'use strict';

// Object writes: PutObject uploads and CopyObject.

const { S3Error } = require('../../models/error');
const { send, sendDoc, quoteEtag } = require('../../models/response');
const { isoDate } = require('../../utils');
const { requireBucket } = require('../bucket');
const {
  extractChecksumRequest,
  getUploadBodyStream,
  validateDigests,
  metaFieldsFromHeaders,
  checkWriteConditions,
  checkCopyConditions,
  parseCopySource,
  checksumHeaderName,
  checksumXmlFields,
  setVersionHeader,
} = require('./helpers');
const { objectLockFields } = require('./lock');

/** Stores the request body as a new object (or object version). */
async function putObjectContent(ctx) {
  const { req, res } = ctx;
  const bucketMeta = await requireBucket(ctx);
  const versioning = bucketMeta.configs.versioning;
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

  const existingRaw = await ctx.store.getObject(ctx.bucket, ctx.key);
  const existing =
    existingRaw && !existingRaw.isDeleteMarker ? existingRaw : null;
  checkWriteConditions(req.headers, existing);
  const lockFields = objectLockFields(ctx, bucketMeta);

  const { declared, algorithms } = extractChecksumRequest(req.headers);
  const computeAlgos = algorithms.length > 0 ? algorithms : ['CRC64NVME'];
  const { stream, decoder } = getUploadBodyStream(req, ctx.auth);
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

  const fields = { ...metaFieldsFromHeaders(req.headers), ...lockFields };
  fields.checksums = staged.digests.checksums;
  fields.checksumAlgorithm =
    Object.keys(checksumFields)[0] ||
    (algorithms.length === 0 ? 'CRC64NVME' : algorithms[0]);
  fields.checksumType = 'FULL_OBJECT';
  const meta = await staged.commit(ctx.key, fields, versioning);

  const headers = {
    ETag: quoteEtag(meta.etag),
    'x-amz-server-side-encryption': 'AES256',
  };
  for (const [algorithm, value] of Object.entries(meta.checksums || {})) {
    headers[checksumHeaderName(algorithm)] = value;
  }
  headers['x-amz-checksum-type'] = meta.checksumType;
  setVersionHeader(res, meta);
  ctx.emitEvent('ObjectCreated:Put', meta);
  send(res, 200, headers);
}

async function copyObject(ctx) {
  const bucketMeta = await requireBucket(ctx);
  const versioning = bucketMeta.configs.versioning;
  const source = parseCopySource(ctx);
  const sourceBucket = await ctx.store.getBucket(source.bucket);
  if (!sourceBucket) {
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', {
      BucketName: source.bucket,
    });
  }
  const sourceMeta = await ctx.store.getObject(
    source.bucket,
    source.key,
    source.versionId
  );
  if (!sourceMeta || sourceMeta.isDeleteMarker) {
    if (source.versionId) {
      throw new S3Error(
        'NoSuchVersion',
        'The specified version does not exist.',
        { statusCode: 404, Key: source.key, VersionId: source.versionId }
      );
    }
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
  const existingRaw = await ctx.store.getObject(ctx.bucket, ctx.key);
  checkWriteConditions(
    ctx.req.headers,
    existingRaw && !existingRaw.isDeleteMarker ? existingRaw : null
  );

  const sourceStream = ctx.store.createObjectReadStream(
    source.bucket,
    sourceMeta
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

  const meta = await staged.commit(ctx.key, fields, versioning);
  if (sourceMeta.versionId && sourceMeta.versionId !== 'null') {
    ctx.res.setHeader('x-amz-copy-source-version-id', sourceMeta.versionId);
  }
  setVersionHeader(ctx.res, meta);
  ctx.emitEvent('ObjectCreated:Copy', meta);
  sendDoc(ctx.res, 200, 'CopyObjectResult', {
    LastModified: isoDate(meta.lastModified),
    ETag: quoteEtag(meta.etag),
    ...checksumXmlFields(meta.checksums),
    ChecksumType: meta.checksumType,
  });
}

module.exports = { putObjectContent, copyObject };
