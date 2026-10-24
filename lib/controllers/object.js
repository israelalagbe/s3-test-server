'use strict';

const { Readable } = require('stream');
const crypto = require('crypto');
const { S3Error } = require('../models/error');
const { parseXml, asArray } = require('../xml');
const { AwsChunkedDecoder } = require('../chunked');
const { checksumOf } = require('../checksums');
const {
  send,
  sendDoc,
  sendXml,
  quoteEtag,
  stripEtagQuotes,
} = require('../models/response');
const {
  readBody,
  isoDate,
  httpDate,
  awsUriEncode,
  DUMMY_OWNER,
} = require('../utils');
const { requireBucket, dummyAclXml, parseTaggingConfig } = require('./bucket');

const MIN_PART_SIZE = 5 * 1024 * 1024;
const CHECKSUM_ALGOS = ['CRC32', 'CRC32C', 'CRC64NVME', 'SHA1', 'SHA256'];
const DEFAULT_CONTENT_TYPE = 'binary/octet-stream';

// ---------------------------------------------------------------- helpers

function checksumHeaderName(algorithm) {
  return `x-amz-checksum-${algorithm.toLowerCase()}`;
}

function extractChecksumRequest(headers) {
  const declared = {};
  for (const algorithm of CHECKSUM_ALGOS) {
    const value = headers[checksumHeaderName(algorithm)];
    if (value !== undefined) declared[algorithm] = value;
  }
  const trailerAlgos = String(headers['x-amz-trailer'] || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.startsWith('x-amz-checksum-'))
    .map((name) => name.slice('x-amz-checksum-'.length).toUpperCase())
    .filter((algorithm) => CHECKSUM_ALGOS.includes(algorithm));
  let sdkAlgo = headers['x-amz-sdk-checksum-algorithm'];
  if (sdkAlgo) sdkAlgo = String(sdkAlgo).toUpperCase();
  const algorithms = new Set([
    ...Object.keys(declared),
    ...trailerAlgos,
    ...(sdkAlgo && CHECKSUM_ALGOS.includes(sdkAlgo) ? [sdkAlgo] : []),
  ]);
  return { declared, algorithms: [...algorithms] };
}

function getUploadBodyStream(req) {
  const contentSha = String(req.headers['x-amz-content-sha256'] || '');
  const contentEncoding = String(req.headers['content-encoding'] || '');
  const isChunked =
    contentSha.startsWith('STREAMING-') ||
    contentEncoding
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .includes('aws-chunked');
  if (!isChunked) return { stream: req, decoder: null };
  const decoder = new AwsChunkedDecoder();
  req.pipe(decoder);
  req.on('error', (err) => decoder.destroy(err));
  return { stream: decoder, decoder };
}

/**
 * Validates integrity declarations (Content-MD5, x-amz-content-sha256,
 * x-amz-checksum-*) against computed digests. Returns the checksum fields to
 * store on the object/part metadata.
 */
function validateDigests({ headers, auth, declared, trailers, digests }) {
  const expected = { ...declared };
  for (const algorithm of CHECKSUM_ALGOS) {
    const trailerValue = trailers
      ? trailers[checksumHeaderName(algorithm)]
      : undefined;
    if (trailerValue !== undefined) expected[algorithm] = trailerValue;
  }

  const contentMd5 = headers['content-md5'];
  if (contentMd5) {
    let decoded;
    try {
      decoded = Buffer.from(contentMd5, 'base64');
    } catch {
      decoded = Buffer.alloc(0);
    }
    if (decoded.length !== 16) {
      throw new S3Error(
        'InvalidDigest',
        'The Content-MD5 you specified is not valid.',
        {
          'Content-MD5': contentMd5,
        }
      );
    }
    if (decoded.toString('hex') !== digests.md5Hex) {
      throw new S3Error(
        'BadDigest',
        'The Content-MD5 you specified did not match what we received.',
        {
          ExpectedDigest: contentMd5,
          CalculatedDigest: digests.md5Base64,
        }
      );
    }
  }

  const contentSha = auth && auth.contentSha256;
  if (
    contentSha &&
    /^[0-9a-f]{64}$/.test(contentSha) &&
    contentSha !== digests.sha256Hex
  ) {
    throw new S3Error(
      'XAmzContentSHA256Mismatch',
      'The provided x-amz-content-sha256 does not match what was computed.',
      {
        ClientComputedContentSHA256: contentSha,
        S3ComputedContentSHA256: digests.sha256Hex,
      }
    );
  }

  for (const [algorithm, value] of Object.entries(expected)) {
    const computed = digests.checksums[algorithm];
    if (computed !== undefined && computed !== value) {
      throw new S3Error(
        'BadDigest',
        `The ${algorithm} you specified did not match the calculated checksum.`
      );
    }
  }
  return expected;
}

function metaFieldsFromHeaders(headers) {
  const fields = {
    contentType: headers['content-type'] || DEFAULT_CONTENT_TYPE,
    userMetadata: {},
  };
  const simple = {
    'cache-control': 'cacheControl',
    'content-disposition': 'contentDisposition',
    'content-language': 'contentLanguage',
    expires: 'expiresHeader',
    'x-amz-storage-class': 'storageClass',
    'x-amz-website-redirect-location': 'websiteRedirectLocation',
  };
  for (const [header, field] of Object.entries(simple)) {
    if (headers[header] !== undefined) fields[field] = String(headers[header]);
  }
  const contentEncoding = String(headers['content-encoding'] || '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token && token.toLowerCase() !== 'aws-chunked')
    .join(', ');
  if (contentEncoding) fields.contentEncoding = contentEncoding;
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith('x-amz-meta-')) {
      fields.userMetadata[name.slice('x-amz-meta-'.length)] = Array.isArray(
        value
      )
        ? value.join(',')
        : String(value);
    }
  }
  if (headers['x-amz-tagging']) {
    const tags = {};
    for (const [tagKey, tagValue] of new URLSearchParams(
      String(headers['x-amz-tagging'])
    )) {
      tags[tagKey] = tagValue;
    }
    fields.tagging = tags;
  }
  return fields;
}

function checkWriteConditions(headers, existing) {
  const ifNoneMatch = headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch === '*' && existing) {
      throw new S3Error(
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
        { Condition: 'If-None-Match' }
      );
    }
    if (
      ifNoneMatch !== '*' &&
      existing &&
      stripEtagQuotes(ifNoneMatch) === existing.etag
    ) {
      throw new S3Error(
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
        { Condition: 'If-None-Match' }
      );
    }
  }
  const ifMatch = headers['if-match'];
  if (ifMatch !== undefined) {
    if (
      !existing ||
      (ifMatch !== '*' && stripEtagQuotes(ifMatch) !== existing.etag)
    ) {
      throw new S3Error(
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
        { Condition: 'If-Match' }
      );
    }
  }
}

function checkReadConditions(headers, meta) {
  const lastModifiedSec = Math.floor(meta.lastModified / 1000) * 1000;
  const ifMatch = headers['if-match'];
  if (ifMatch !== undefined) {
    const etags = String(ifMatch)
      .split(',')
      .map((value) => stripEtagQuotes(value.trim()));
    if (!etags.includes('*') && !etags.includes(meta.etag)) {
      throw new S3Error(
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
        { Condition: 'If-Match' }
      );
    }
  } else if (headers['if-unmodified-since'] !== undefined) {
    const since = Date.parse(headers['if-unmodified-since']);
    if (!Number.isNaN(since) && lastModifiedSec > since) {
      throw new S3Error(
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
        { Condition: 'If-Unmodified-Since' }
      );
    }
  }
  const ifNoneMatch = headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    const etags = String(ifNoneMatch)
      .split(',')
      .map((value) => stripEtagQuotes(value.trim()));
    if (etags.includes('*') || etags.includes(meta.etag))
      return { notModified: true };
  } else if (headers['if-modified-since'] !== undefined) {
    const since = Date.parse(headers['if-modified-since']);
    if (!Number.isNaN(since) && lastModifiedSec <= since)
      return { notModified: true };
  }
  return { notModified: false };
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)(?:,|$)/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = parseInt(match[2], 10);
    if (suffix === 0) {
      throw invalidRange(size);
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end =
      match[2] === '' ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
  }
  if (start >= size || start > end) {
    throw invalidRange(size);
  }
  return { start, end };
}

function invalidRange(size) {
  return new S3Error('InvalidRange', 'The requested range is not satisfiable', {
    RangeRequested: '',
    ActualObjectSize: size,
  });
}

async function requireObject(ctx, key = ctx.key) {
  const meta = await ctx.store.getObject(ctx.bucket, key);
  if (!meta) {
    throw new S3Error('NoSuchKey', 'The specified key does not exist.', {
      Key: key,
    });
  }
  return meta;
}

function parseCopySource(ctx) {
  const raw = String(ctx.req.headers['x-amz-copy-source'] || '');
  const [pathPart, queryPart] = raw.split('?');
  const trimmed = pathPart.replace(/^\//, '');
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new S3Error(
      'InvalidArgument',
      'Copy Source must mention the source bucket and key: sourcebucket/sourcekey',
      {
        ArgumentName: 'x-amz-copy-source',
        ArgumentValue: raw,
      }
    );
  }
  let bucket;
  let key;
  try {
    bucket = decodeURIComponent(trimmed.slice(0, slash));
    key = decodeURIComponent(trimmed.slice(slash + 1));
  } catch {
    throw new S3Error('InvalidURI', "Couldn't parse the specified URI.");
  }
  let versionId;
  if (queryPart) {
    versionId = new URLSearchParams(queryPart).get('versionId') || undefined;
  }
  return { bucket, key, versionId };
}

function checkCopyConditions(headers, sourceMeta) {
  const ifMatch = headers['x-amz-copy-source-if-match'];
  const ifNoneMatch = headers['x-amz-copy-source-if-none-match'];
  const ifModified = headers['x-amz-copy-source-if-modified-since'];
  const ifUnmodified = headers['x-amz-copy-source-if-unmodified-since'];
  const fail = () => {
    throw new S3Error(
      'PreconditionFailed',
      'At least one of the pre-conditions you specified did not hold'
    );
  };
  if (ifMatch !== undefined && stripEtagQuotes(ifMatch) !== sourceMeta.etag)
    fail();
  if (
    ifNoneMatch !== undefined &&
    stripEtagQuotes(ifNoneMatch) === sourceMeta.etag
  )
    fail();
  if (ifUnmodified !== undefined) {
    const since = Date.parse(ifUnmodified);
    if (!Number.isNaN(since) && sourceMeta.lastModified > since) fail();
  }
  if (ifModified !== undefined) {
    const since = Date.parse(ifModified);
    if (!Number.isNaN(since) && sourceMeta.lastModified <= since) fail();
  }
}

function objectResponseHeaders(meta, { checksumMode } = {}) {
  const headers = {
    ETag: quoteEtag(meta.etag),
    'Last-Modified': httpDate(meta.lastModified),
    'Accept-Ranges': 'bytes',
    'Content-Type': meta.contentType || DEFAULT_CONTENT_TYPE,
    'x-amz-server-side-encryption': 'AES256',
  };
  if (meta.cacheControl) headers['Cache-Control'] = meta.cacheControl;
  if (meta.contentDisposition)
    headers['Content-Disposition'] = meta.contentDisposition;
  if (meta.contentEncoding) headers['Content-Encoding'] = meta.contentEncoding;
  if (meta.contentLanguage) headers['Content-Language'] = meta.contentLanguage;
  if (meta.expiresHeader) headers.Expires = meta.expiresHeader;
  if (meta.websiteRedirectLocation) {
    headers['x-amz-website-redirect-location'] = meta.websiteRedirectLocation;
  }
  if (meta.storageClass && meta.storageClass !== 'STANDARD') {
    headers['x-amz-storage-class'] = meta.storageClass;
  }
  for (const [name, value] of Object.entries(meta.userMetadata || {})) {
    headers[`x-amz-meta-${name}`] = value;
  }
  const tagCount = Object.keys(meta.tagging || {}).length;
  if (tagCount > 0) headers['x-amz-tagging-count'] = tagCount;
  if (meta.partsCount) headers['x-amz-mp-parts-count'] = meta.partsCount;
  if (checksumMode && meta.checksums) {
    for (const [algorithm, value] of Object.entries(meta.checksums)) {
      headers[checksumHeaderName(algorithm)] = value;
    }
    if (meta.checksumType) headers['x-amz-checksum-type'] = meta.checksumType;
  }
  return headers;
}

// ---------------------------------------------------------------- GET/HEAD

async function getOrHeadObject(ctx) {
  const { req, res, query } = ctx;

  if (query.has('uploadId')) {
    await listParts(ctx);
    return;
  }
  if (query.has('acl')) {
    await requireBucket(ctx);
    await requireObject(ctx);
    sendXml(res, 200, dummyAclXml());
    return;
  }
  if (query.has('tagging')) {
    await requireBucket(ctx);
    const meta = await requireObject(ctx);
    sendDoc(res, 200, 'Tagging', {
      TagSet: {
        Tag: Object.entries(meta.tagging || {}).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      },
    });
    return;
  }
  if (query.has('attributes')) {
    await getObjectAttributes(ctx);
    return;
  }
  if (query.has('torrent')) {
    throw new S3Error(
      'NotImplemented',
      'A header or query you provided requested a function that is not implemented.'
    );
  }

  await requireBucket(ctx);
  const meta = await requireObject(ctx);

  const { notModified } = checkReadConditions(req.headers, meta);
  // Like S3, checksum headers are only returned for whole-object responses.
  const checksumMode =
    String(req.headers['x-amz-checksum-mode'] || '').toUpperCase() ===
      'ENABLED' && !req.headers.range;
  const headers = objectResponseHeaders(meta, { checksumMode });

  // response-* overrides (commonly used with presigned URLs)
  const overrides = {
    'response-content-type': 'Content-Type',
    'response-content-language': 'Content-Language',
    'response-expires': 'Expires',
    'response-cache-control': 'Cache-Control',
    'response-content-disposition': 'Content-Disposition',
    'response-content-encoding': 'Content-Encoding',
  };
  for (const [param, header] of Object.entries(overrides)) {
    const value = query.get(param);
    if (value !== null) headers[header] = value;
  }

  if (notModified) {
    delete headers['Content-Type'];
    send(res, 304, headers);
    return;
  }

  let range = null;
  if (req.headers.range) {
    range = parseRange(req.headers.range, meta.size);
  }
  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : meta.size;
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${meta.size}`;
  }
  headers['Content-Length'] = length;

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  if (length === 0) {
    res.end();
    return;
  }
  const stream = ctx.store.createObjectReadStream(ctx.bucket, ctx.key, range);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
}

async function getObjectAttributes(ctx) {
  await requireBucket(ctx);
  const meta = await requireObject(ctx);
  const requested = String(ctx.req.headers['x-amz-object-attributes'] || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new S3Error(
      'InvalidRequest',
      'The x-amz-object-attributes header specifying the attributes to be retrieved is either missing or empty'
    );
  }
  const result = {};
  if (requested.includes('ETag')) result.ETag = meta.etag;
  if (requested.includes('Checksum') && meta.checksums) {
    const checksum = {};
    for (const [algorithm, value] of Object.entries(meta.checksums)) {
      checksum[`Checksum${algorithm}`] = value;
    }
    if (meta.checksumType) checksum.ChecksumType = meta.checksumType;
    result.Checksum = checksum;
  }
  if (requested.includes('ObjectParts') && meta.partsCount) {
    // The XML element for TotalPartsCount is named PartsCount.
    result.ObjectParts = { PartsCount: meta.partsCount };
  }
  if (requested.includes('StorageClass')) {
    result.StorageClass = meta.storageClass || 'STANDARD';
  }
  if (requested.includes('ObjectSize')) result.ObjectSize = meta.size;
  ctx.res.setHeader('Last-Modified', httpDate(meta.lastModified));
  sendDoc(ctx.res, 200, 'GetObjectAttributesResponse', result);
}

async function listParts(ctx) {
  await requireBucket(ctx);
  const uploadId = ctx.query.get('uploadId');
  const upload = await ctx.store.getUpload(ctx.bucket, uploadId);
  if (!upload || upload.key !== ctx.key) {
    throw new S3Error(
      'NoSuchUpload',
      'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
      {
        UploadId: uploadId,
      }
    );
  }
  const marker = parseInt(ctx.query.get('part-number-marker') || '0', 10) || 0;
  const maxParts = Math.min(
    parseInt(ctx.query.get('max-parts') || '1000', 10) || 1000,
    1000
  );
  const allParts = (await ctx.store.listParts(ctx.bucket, uploadId)).filter(
    (part) => part.partNumber > marker
  );
  const page = allParts.slice(0, maxParts);
  const truncated = allParts.length > page.length;

  sendDoc(ctx.res, 200, 'ListPartsResult', {
    Bucket: ctx.bucket,
    Key: ctx.key,
    UploadId: uploadId,
    PartNumberMarker: marker,
    NextPartNumberMarker: truncated
      ? page[page.length - 1].partNumber
      : undefined,
    MaxParts: maxParts,
    IsTruncated: truncated,
    Part: page.map((part) => ({
      PartNumber: part.partNumber,
      LastModified: isoDate(part.lastModified),
      ETag: quoteEtag(part.etag),
      Size: part.size,
      ...checksumXmlFields(part.checksums),
    })),
    Initiator: DUMMY_OWNER,
    Owner: DUMMY_OWNER,
    StorageClass: upload.storageClass || 'STANDARD',
    ChecksumAlgorithm: upload.checksumAlgorithm,
    ChecksumType: upload.checksumType,
  });
}

function checksumXmlFields(checksums) {
  const fields = {};
  for (const [algorithm, value] of Object.entries(checksums || {})) {
    fields[`Checksum${algorithm}`] = value;
  }
  return fields;
}

// ---------------------------------------------------------------- PUT

async function putObject(ctx) {
  const { req, res, query } = ctx;

  if (query.has('acl')) {
    await requireBucket(ctx);
    await requireObject(ctx);
    await readBody(req);
    send(res, 200, {});
    return;
  }
  if (query.has('tagging')) {
    await requireBucket(ctx);
    const meta = await requireObject(ctx);
    const body = await readBody(req);
    const config = parseTaggingConfig(body.toString('utf8'));
    meta.tagging = config.tags;
    await ctx.store.updateObjectMeta(ctx.bucket, ctx.key, meta);
    send(res, 200, {});
    return;
  }
  if (query.has('uploadId')) {
    if (req.headers['x-amz-copy-source']) {
      await uploadPartCopy(ctx);
    } else {
      await uploadPart(ctx);
    }
    return;
  }
  if (req.headers['x-amz-copy-source']) {
    await copyObject(ctx);
    return;
  }

  await requireBucket(ctx);
  if (ctx.key.length > 1024) {
    throw new S3Error('KeyTooLongError', 'Your key is too long', {
      MaxSizeAllowed: 1024,
      Size: ctx.key.length,
    });
  }
  if (
    req.headers['content-length'] === undefined &&
    String(req.headers['transfer-encoding'] || '').toLowerCase() !== 'chunked'
  ) {
    throw new S3Error(
      'MissingContentLength',
      'You must provide the Content-Length HTTP header.'
    );
  }

  const existing = await ctx.store.getObject(ctx.bucket, ctx.key);
  checkWriteConditions(req.headers, existing);

  const { declared, algorithms } = extractChecksumRequest(req.headers);
  const computeAlgos = algorithms.length > 0 ? algorithms : ['CRC64NVME'];
  const { stream, decoder } = getUploadBodyStream(req);
  const staged = await ctx.store.stageObject(ctx.bucket, stream, computeAlgos);

  let checksumFields;
  try {
    checksumFields = validateDigests({
      headers: req.headers,
      auth: ctx.auth,
      declared,
      trailers: decoder ? decoder.trailers : null,
      digests: staged.digests,
    });
  } catch (err) {
    await staged.abort();
    throw err;
  }

  const fields = metaFieldsFromHeaders(req.headers);
  fields.checksums = staged.digests.checksums;
  fields.checksumAlgorithm =
    Object.keys(checksumFields)[0] ||
    (algorithms.length === 0 ? 'CRC64NVME' : algorithms[0]);
  fields.checksumType = 'FULL_OBJECT';
  const meta = await staged.commit(ctx.key, fields);

  const headers = {
    ETag: quoteEtag(meta.etag),
    'x-amz-server-side-encryption': 'AES256',
  };
  for (const [algorithm, value] of Object.entries(meta.checksums || {})) {
    headers[checksumHeaderName(algorithm)] = value;
  }
  headers['x-amz-checksum-type'] = meta.checksumType;
  ctx.emitEvent('ObjectCreated:Put', meta);
  send(res, 200, headers);
}

async function copyObject(ctx) {
  await requireBucket(ctx);
  const source = parseCopySource(ctx);
  if (source.versionId && source.versionId !== 'null') {
    throw new S3Error(
      'NoSuchVersion',
      'The specified version does not exist.',
      {
        statusCode: 404,
        VersionId: source.versionId,
      }
    );
  }
  const sourceBucket = await ctx.store.getBucket(source.bucket);
  if (!sourceBucket) {
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', {
      BucketName: source.bucket,
    });
  }
  const sourceMeta = await ctx.store.getObject(source.bucket, source.key);
  if (!sourceMeta) {
    throw new S3Error('NoSuchKey', 'The specified key does not exist.', {
      Key: source.key,
    });
  }
  checkCopyConditions(ctx.req.headers, sourceMeta);

  const metadataDirective = String(
    ctx.req.headers['x-amz-metadata-directive'] || 'COPY'
  ).toUpperCase();
  const taggingDirective = String(
    ctx.req.headers['x-amz-tagging-directive'] || 'COPY'
  ).toUpperCase();
  const sameTarget = source.bucket === ctx.bucket && source.key === ctx.key;
  if (sameTarget && metadataDirective === 'COPY') {
    throw new S3Error(
      'InvalidRequest',
      "This copy request is illegal because it is trying to copy an object to itself without changing the object's metadata, storage class, website redirect location or encryption attributes."
    );
  }
  const existing = await ctx.store.getObject(ctx.bucket, ctx.key);
  checkWriteConditions(ctx.req.headers, existing);

  const sourceStream = ctx.store.createObjectReadStream(
    source.bucket,
    source.key
  );
  const algorithms = sourceMeta.checksumAlgorithm
    ? [sourceMeta.checksumAlgorithm]
    : ['CRC64NVME'];
  const staged = await ctx.store.stageObject(
    ctx.bucket,
    sourceStream,
    algorithms
  );

  let fields;
  if (metadataDirective === 'REPLACE') {
    fields = metaFieldsFromHeaders(ctx.req.headers);
  } else {
    fields = {
      contentType: sourceMeta.contentType,
      cacheControl: sourceMeta.cacheControl,
      contentDisposition: sourceMeta.contentDisposition,
      contentEncoding: sourceMeta.contentEncoding,
      contentLanguage: sourceMeta.contentLanguage,
      expiresHeader: sourceMeta.expiresHeader,
      storageClass:
        ctx.req.headers['x-amz-storage-class'] || sourceMeta.storageClass,
      websiteRedirectLocation: sourceMeta.websiteRedirectLocation,
      userMetadata: { ...sourceMeta.userMetadata },
    };
  }
  fields.tagging =
    taggingDirective === 'REPLACE'
      ? metaFieldsFromHeaders(ctx.req.headers).tagging || {}
      : { ...sourceMeta.tagging };
  fields.checksums = staged.digests.checksums;
  fields.checksumAlgorithm = algorithms[0];
  fields.checksumType = 'FULL_OBJECT';

  const meta = await staged.commit(ctx.key, fields);
  ctx.emitEvent('ObjectCreated:Copy', meta);
  sendDoc(ctx.res, 200, 'CopyObjectResult', {
    LastModified: isoDate(meta.lastModified),
    ETag: quoteEtag(meta.etag),
    ...checksumXmlFields(meta.checksums),
    ChecksumType: meta.checksumType,
  });
}

async function requireUpload(ctx) {
  const uploadId = ctx.query.get('uploadId');
  const upload = await ctx.store.getUpload(ctx.bucket, uploadId);
  if (!upload || upload.key !== ctx.key) {
    throw new S3Error(
      'NoSuchUpload',
      'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
      {
        UploadId: uploadId,
      }
    );
  }
  return upload;
}

function parsePartNumber(ctx) {
  const raw = ctx.query.get('partNumber');
  const partNumber = parseInt(raw, 10);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new S3Error(
      'InvalidArgument',
      'Part number must be an integer between 1 and 10000, inclusive',
      {
        ArgumentName: 'partNumber',
        ArgumentValue: raw,
      }
    );
  }
  return partNumber;
}

async function uploadPart(ctx) {
  await requireBucket(ctx);
  const upload = await requireUpload(ctx);
  const partNumber = parsePartNumber(ctx);

  const { declared, algorithms } = extractChecksumRequest(ctx.req.headers);
  const computeAlgos = new Set(algorithms);
  if (upload.checksumAlgorithm) computeAlgos.add(upload.checksumAlgorithm);
  const { stream, decoder } = getUploadBodyStream(ctx.req);
  const staged = await ctx.store.putPart(
    ctx.bucket,
    upload.uploadId,
    partNumber,
    stream,
    [...computeAlgos]
  );

  try {
    validateDigests({
      headers: ctx.req.headers,
      auth: ctx.auth,
      declared,
      trailers: decoder ? decoder.trailers : null,
      digests: staged.digests,
    });
  } catch (err) {
    await staged.abort();
    throw err;
  }
  const part = await staged.commit();

  const headers = {
    ETag: quoteEtag(part.etag),
    'x-amz-server-side-encryption': 'AES256',
  };
  for (const [algorithm, value] of Object.entries(part.checksums || {})) {
    headers[checksumHeaderName(algorithm)] = value;
  }
  send(ctx.res, 200, headers);
}

async function uploadPartCopy(ctx) {
  await requireBucket(ctx);
  const upload = await requireUpload(ctx);
  const partNumber = parsePartNumber(ctx);
  const source = parseCopySource(ctx);
  const sourceMeta = await ctx.store.getObject(source.bucket, source.key);
  if (!sourceMeta) {
    throw new S3Error('NoSuchKey', 'The specified key does not exist.', {
      Key: source.key,
    });
  }
  checkCopyConditions(ctx.req.headers, sourceMeta);

  let range = null;
  const rangeHeader = ctx.req.headers['x-amz-copy-source-range'];
  if (rangeHeader) {
    range = parseRange(rangeHeader, sourceMeta.size);
    if (!range) {
      throw new S3Error(
        'InvalidArgument',
        'The x-amz-copy-source-range value must be of the form bytes=first-last',
        {
          ArgumentName: 'x-amz-copy-source-range',
          ArgumentValue: rangeHeader,
        }
      );
    }
  }
  const sourceStream = ctx.store.createObjectReadStream(
    source.bucket,
    source.key,
    range
  );
  const computeAlgos = upload.checksumAlgorithm
    ? [upload.checksumAlgorithm]
    : [];
  const staged = await ctx.store.putPart(
    ctx.bucket,
    upload.uploadId,
    partNumber,
    sourceStream,
    computeAlgos
  );
  const part = await staged.commit();
  sendDoc(ctx.res, 200, 'CopyPartResult', {
    LastModified: isoDate(part.lastModified),
    ETag: quoteEtag(part.etag),
    ...checksumXmlFields(part.checksums),
  });
}

// ---------------------------------------------------------------- POST

async function postObject(ctx) {
  const { query } = ctx;
  if (query.has('uploads')) {
    await createMultipartUpload(ctx);
    return;
  }
  if (query.has('uploadId')) {
    await completeMultipartUpload(ctx);
    return;
  }
  throw new S3Error(
    'MethodNotAllowed',
    'The specified method is not allowed against this resource.',
    {
      Method: 'POST',
      ResourceType: 'OBJECT',
    }
  );
}

async function createMultipartUpload(ctx) {
  await requireBucket(ctx);
  await readBody(ctx.req);
  const fields = metaFieldsFromHeaders(ctx.req.headers);
  let checksumAlgorithm = ctx.req.headers['x-amz-checksum-algorithm'];
  if (checksumAlgorithm) {
    checksumAlgorithm = String(checksumAlgorithm).toUpperCase();
    if (!CHECKSUM_ALGOS.includes(checksumAlgorithm)) {
      throw new S3Error(
        'InvalidRequest',
        'The algorithm type you specified in x-amz-checksum-algorithm header is invalid.'
      );
    }
    fields.checksumAlgorithm = checksumAlgorithm;
    let checksumType = ctx.req.headers['x-amz-checksum-type'];
    if (checksumType) {
      checksumType = String(checksumType).toUpperCase();
    } else {
      checksumType =
        checksumAlgorithm === 'CRC64NVME' ? 'FULL_OBJECT' : 'COMPOSITE';
    }
    if (checksumAlgorithm === 'SHA1' || checksumAlgorithm === 'SHA256') {
      checksumType = 'COMPOSITE';
    }
    fields.checksumType = checksumType;
  }
  const upload = await ctx.store.createUpload(ctx.bucket, ctx.key, fields);
  const headers = {};
  if (fields.checksumAlgorithm) {
    headers['x-amz-checksum-algorithm'] = fields.checksumAlgorithm;
    headers['x-amz-checksum-type'] = fields.checksumType;
  }
  for (const [name, value] of Object.entries(headers)) {
    ctx.res.setHeader(name, value);
  }
  sendDoc(ctx.res, 200, 'InitiateMultipartUploadResult', {
    Bucket: ctx.bucket,
    Key: ctx.key,
    UploadId: upload.uploadId,
  });
}

async function completeMultipartUpload(ctx) {
  await requireBucket(ctx);
  const upload = await requireUpload(ctx);
  const body = await readBody(ctx.req);
  let requestedParts;
  try {
    const parsed = parseXml(body.toString('utf8'));
    requestedParts = asArray(
      parsed.CompleteMultipartUpload && parsed.CompleteMultipartUpload.Part
    );
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  if (requestedParts.length === 0) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }

  const existing = await ctx.store.getObject(ctx.bucket, ctx.key);
  checkWriteConditions(ctx.req.headers, existing);

  const storedParts = new Map(
    (await ctx.store.listParts(ctx.bucket, upload.uploadId)).map((part) => [
      part.partNumber,
      part,
    ])
  );

  let previousNumber = 0;
  const parts = [];
  for (const requested of requestedParts) {
    const partNumber = parseInt(requested.PartNumber, 10);
    if (!Number.isInteger(partNumber) || partNumber <= previousNumber) {
      throw new S3Error(
        'InvalidPartOrder',
        'The list of parts was not in ascending order. Parts must be ordered by part number.',
        {
          UploadId: upload.uploadId,
        }
      );
    }
    previousNumber = partNumber;
    const stored = storedParts.get(partNumber);
    if (!stored || stripEtagQuotes(requested.ETag) !== stored.etag) {
      throw new S3Error(
        'InvalidPart',
        "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.",
        {
          UploadId: upload.uploadId,
          PartNumber: partNumber,
          ETag: requested.ETag,
        }
      );
    }
    parts.push(stored);
  }
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].size < MIN_PART_SIZE) {
      throw new S3Error(
        'EntityTooSmall',
        'Your proposed upload is smaller than the minimum allowed size',
        {
          PartNumber: parts[i].partNumber,
          ProposedSize: parts[i].size,
          MinSizeAllowed: MIN_PART_SIZE,
        }
      );
    }
  }

  // Concatenate the parts into the final object.
  const store = ctx.store;
  const bucket = ctx.bucket;
  const partStreams = async function* () {
    for (const part of parts) {
      yield* store.createPartReadStream(
        bucket,
        upload.uploadId,
        part.partNumber
      );
    }
  };
  const fullObjectAlgos = upload.checksumAlgorithm
    ? [upload.checksumAlgorithm]
    : ['CRC64NVME'];
  const staged = await ctx.store.stageObject(
    ctx.bucket,
    Readable.from(partStreams()),
    fullObjectAlgos
  );

  // Multipart ETag: md5 of the concatenated binary part MD5s, suffixed -N.
  const md5Concat = crypto.createHash('md5');
  for (const part of parts) {
    md5Concat.update(Buffer.from(part.etag, 'hex'));
  }
  const etag = `${md5Concat.digest('hex')}-${parts.length}`;

  // Resolve checksum: composite (checksum-of-checksums) or full-object.
  const checksums = {};
  let checksumType;
  if (upload.checksumAlgorithm) {
    checksumType = upload.checksumType || 'COMPOSITE';
    if (checksumType === 'COMPOSITE') {
      const concatenated = Buffer.concat(
        parts.map((part) =>
          Buffer.from(part.checksums[upload.checksumAlgorithm] || '', 'base64')
        )
      );
      checksums[upload.checksumAlgorithm] =
        `${checksumOf(upload.checksumAlgorithm, concatenated)}-${parts.length}`;
    } else {
      checksums[upload.checksumAlgorithm] =
        staged.digests.checksums[upload.checksumAlgorithm];
    }
  } else {
    checksumType = 'FULL_OBJECT';
    checksums.CRC64NVME = staged.digests.checksums.CRC64NVME;
  }

  // Validate a client-provided full-object checksum, if any.
  const { declared } = extractChecksumRequest(ctx.req.headers);
  for (const [algorithm, value] of Object.entries(declared)) {
    const computed =
      checksumType === 'FULL_OBJECT'
        ? checksums[algorithm]
        : staged.digests.checksums[algorithm];
    if (
      computed !== undefined &&
      stripPartSuffix(computed) !== stripPartSuffix(value)
    ) {
      await staged.abort();
      throw new S3Error(
        'BadDigest',
        `The ${algorithm} you specified did not match the calculated checksum.`
      );
    }
  }

  const fields = {
    contentType: upload.contentType,
    cacheControl: upload.cacheControl,
    contentDisposition: upload.contentDisposition,
    contentEncoding: upload.contentEncoding,
    contentLanguage: upload.contentLanguage,
    expiresHeader: upload.expiresHeader,
    storageClass: upload.storageClass,
    websiteRedirectLocation: upload.websiteRedirectLocation,
    userMetadata: upload.userMetadata || {},
    tagging: upload.tagging || {},
    etag,
    checksums,
    checksumAlgorithm: upload.checksumAlgorithm || 'CRC64NVME',
    checksumType,
    partsCount: parts.length,
  };
  const meta = await staged.commit(ctx.key, fields);
  await ctx.store.removeUpload(ctx.bucket, upload.uploadId);

  ctx.emitEvent('ObjectCreated:CompleteMultipartUpload', meta);
  const host = ctx.req.headers.host || 'localhost';
  sendDoc(ctx.res, 200, 'CompleteMultipartUploadResult', {
    Location: `http://${host}/${ctx.bucket}/${awsUriEncode(ctx.key, false)}`,
    Bucket: ctx.bucket,
    Key: ctx.key,
    ETag: quoteEtag(etag),
    ...checksumXmlFields(checksums),
    ChecksumType: checksumType,
  });
}

function stripPartSuffix(value) {
  return String(value).replace(/-\d+$/, '');
}

// ---------------------------------------------------------------- DELETE

async function deleteObjectRoute(ctx) {
  const { query, res } = ctx;
  if (query.has('uploadId')) {
    await requireBucket(ctx);
    await requireUpload(ctx);
    await ctx.store.removeUpload(ctx.bucket, query.get('uploadId'));
    send(res, 204, {});
    return;
  }
  if (query.has('tagging')) {
    await requireBucket(ctx);
    const meta = await requireObject(ctx);
    meta.tagging = {};
    await ctx.store.updateObjectMeta(ctx.bucket, ctx.key, meta);
    send(res, 204, {});
    return;
  }
  await requireBucket(ctx);
  const meta = await ctx.store.getObject(ctx.bucket, ctx.key);
  await ctx.store.deleteObject(ctx.bucket, ctx.key);
  if (meta) {
    ctx.emitEvent('ObjectRemoved:Delete', {
      key: ctx.key,
      size: 0,
      etag: undefined,
    });
  }
  send(res, 204, {});
}

async function deleteObjects(ctx) {
  await requireBucket(ctx);
  const body = await readBody(ctx.req);
  let parsed;
  try {
    parsed = parseXml(body.toString('utf8'));
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const deleteRequest = parsed.Delete;
  if (!deleteRequest) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const quiet = deleteRequest.Quiet === 'true';
  const objects = asArray(deleteRequest.Object);
  if (objects.length === 0 || objects.length > 1000) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const deleted = [];
  for (const object of objects) {
    const key = typeof object.Key === 'string' ? object.Key : '';
    const existed = await ctx.store.deleteObject(ctx.bucket, key);
    if (existed) {
      ctx.emitEvent('ObjectRemoved:Delete', { key, size: 0, etag: undefined });
    }
    deleted.push({ Key: key });
  }
  sendDoc(ctx.res, 200, 'DeleteResult', {
    Deleted: quiet ? [] : deleted,
  });
}

module.exports = {
  getOrHeadObject,
  putObject,
  postObject,
  deleteObjectRoute,
  deleteObjects,
};
