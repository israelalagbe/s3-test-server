'use strict';

// Multipart uploads: create, upload parts (incl. part copies), list and
// complete. Completion concatenates the parts and resolves checksums.

const crypto = require('crypto');
const { Readable } = require('stream');
const { S3Error } = require('../../models/error');
const { parseXml, asArray } = require('../../xml');
const { checksumOf } = require('../../checksums');
const {
  send,
  sendDoc,
  quoteEtag,
  stripEtagQuotes,
} = require('../../models/response');
const { readBody, isoDate, awsUriEncode, DUMMY_OWNER } = require('../../utils');
const { requireBucket } = require('../bucket');
const {
  MIN_PART_SIZE,
  CHECKSUM_ALGOS,
  extractChecksumRequest,
  getUploadBodyStream,
  validateDigests,
  metaFieldsFromHeaders,
  checkWriteConditions,
  checkCopyConditions,
  parseCopySource,
  parseRange,
  checksumHeaderName,
  checksumXmlFields,
  setVersionHeader,
  stripPartSuffix,
} = require('./helpers');

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
  const { stream, decoder } = getUploadBodyStream(ctx.req, ctx.auth);
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
  const sourceMeta = await ctx.store.getObject(
    source.bucket,
    source.key,
    source.versionId
  );
  if (!sourceMeta || sourceMeta.isDeleteMarker) {
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
    sourceMeta,
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
  const bucketMeta = await requireBucket(ctx);
  const versioning = bucketMeta.configs.versioning;
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

  const existingRaw = await ctx.store.getObject(ctx.bucket, ctx.key);
  checkWriteConditions(
    ctx.req.headers,
    existingRaw && !existingRaw.isDeleteMarker ? existingRaw : null
  );

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
  const meta = await staged.commit(ctx.key, fields, versioning);
  await ctx.store.removeUpload(ctx.bucket, upload.uploadId);

  setVersionHeader(ctx.res, meta);
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

module.exports = {
  requireUpload,
  uploadPart,
  uploadPartCopy,
  createMultipartUpload,
  completeMultipartUpload,
  listParts,
};
