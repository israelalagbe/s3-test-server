'use strict';

// GET/HEAD of object content and attributes, version- and range-aware.

const { S3Error } = require('../../models/error');
const { send, sendDoc } = require('../../models/response');
const { httpDate } = require('../../utils');
const { requireBucket } = require('../bucket');
const {
  requireObject,
  setVersionHeader,
  checkReadConditions,
  objectResponseHeaders,
  parseRange,
} = require('./helpers');

/** Serves the object body (GET) or just its headers (HEAD). */
async function serveObject(ctx) {
  const { req, res, query } = ctx;
  await requireBucket(ctx);
  await ctx.store.applyLifecycle(ctx.bucket);
  const versionId = query.get('versionId') || undefined;
  let meta;
  if (versionId !== undefined) {
    meta = await ctx.store.getObject(ctx.bucket, ctx.key, versionId);
    if (!meta) {
      throw new S3Error(
        'NoSuchVersion',
        'The specified version does not exist.',
        {
          statusCode: 404,
          Key: ctx.key,
          VersionId: versionId,
        }
      );
    }
    if (meta.isDeleteMarker) {
      // S3 answers a GET for a delete marker's version with 405.
      res.setHeader('x-amz-delete-marker', 'true');
      setVersionHeader(res, meta);
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
        { statusCode: 405, Method: req.method, ResourceType: 'DeleteMarker' }
      );
    }
  } else {
    meta = await requireObject(ctx);
  }
  setVersionHeader(res, meta);

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
  const stream = ctx.store.createObjectReadStream(ctx.bucket, meta, range);
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

module.exports = { serveObject, getObjectAttributes };
