'use strict';

// Shared helpers for the object controllers: integrity validation, header
// mapping, conditional-request evaluation and version plumbing.

const { S3Error } = require('../../models/error');
const { AwsChunkedDecoder } = require('../../chunked');
const { stripEtagQuotes, quoteEtag } = require('../../models/response');
const { httpDate } = require('../../utils');

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

function getUploadBodyStream(req, auth) {
  const contentSha = String(req.headers['x-amz-content-sha256'] || '');
  const contentEncoding = String(req.headers['content-encoding'] || '');
  const isChunked =
    contentSha.startsWith('STREAMING-') ||
    contentEncoding
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .includes('aws-chunked');
  if (!isChunked) return { stream: req, decoder: null };
  // When the seed signature declared signed streaming chunks, verify each
  // chunk signature (and the trailer signature) against the chain.
  const decoder = new AwsChunkedDecoder(auth && auth.streaming);
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
  if (!meta || meta.isDeleteMarker) {
    if (meta && meta.isDeleteMarker) {
      ctx.res.setHeader('x-amz-delete-marker', 'true');
    }
    throw new S3Error('NoSuchKey', 'The specified key does not exist.', {
      Key: key,
    });
  }
  return meta;
}

function setVersionHeader(res, meta, name = 'x-amz-version-id') {
  if (meta && meta.versionId && meta.versionId !== 'null') {
    res.setHeader(name, meta.versionId);
  }
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

function checksumXmlFields(checksums) {
  const fields = {};
  for (const [algorithm, value] of Object.entries(checksums || {})) {
    fields[`Checksum${algorithm}`] = value;
  }
  return fields;
}

// ---------------------------------------------------------------- PUT

function stripPartSuffix(value) {
  return String(value).replace(/-\d+$/, '');
}

// ---------------------------------------------------------------- DELETE

module.exports = {
  MIN_PART_SIZE,
  CHECKSUM_ALGOS,
  DEFAULT_CONTENT_TYPE,
  checksumHeaderName,
  extractChecksumRequest,
  getUploadBodyStream,
  validateDigests,
  metaFieldsFromHeaders,
  checkWriteConditions,
  checkReadConditions,
  parseRange,
  invalidRange,
  requireObject,
  setVersionHeader,
  parseCopySource,
  checkCopyConditions,
  objectResponseHeaders,
  checksumXmlFields,
  stripPartSuffix,
};
