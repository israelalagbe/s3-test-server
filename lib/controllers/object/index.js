'use strict';

// Routes object-level requests to the focused controllers: each HTTP method
// dispatches on its subresource query parameters.

const { S3Error } = require('../../models/error');
const { sendXml, send } = require('../../models/response');
const { readBody } = require('../../utils');
const { requireBucket, dummyAclXml } = require('../bucket');
const { requireObject } = require('./helpers');
const read = require('./read');
const write = require('./write');
const multipart = require('./multipart');
const tagging = require('./tagging');
const lock = require('./lock');
const del = require('./delete');

function methodNotAllowed(method) {
  return new S3Error(
    'MethodNotAllowed',
    'The specified method is not allowed against this resource.',
    { Method: method, ResourceType: 'OBJECT' }
  );
}

async function getOrHeadObject(ctx) {
  const { query, res } = ctx;
  if (query.has('uploadId')) return multipart.listParts(ctx);
  if (query.has('acl')) {
    await requireBucket(ctx);
    await requireObject(ctx);
    sendXml(res, 200, dummyAclXml());
    return;
  }
  if (query.has('tagging')) return tagging.getTagging(ctx);
  if (query.has('retention')) return lock.getRetention(ctx);
  if (query.has('legal-hold')) return lock.getLegalHold(ctx);
  if (query.has('attributes')) return read.getObjectAttributes(ctx);
  if (query.has('torrent')) {
    throw new S3Error(
      'NotImplemented',
      'A header or query you provided requested a function that is not implemented.'
    );
  }
  return read.serveObject(ctx);
}

async function putObject(ctx) {
  const { req, query, res } = ctx;
  if (query.has('acl')) {
    await requireBucket(ctx);
    await requireObject(ctx);
    await readBody(req);
    send(res, 200, {});
    return;
  }
  if (query.has('tagging')) return tagging.putTagging(ctx);
  if (query.has('retention')) return lock.putRetention(ctx);
  if (query.has('legal-hold')) return lock.putLegalHold(ctx);
  if (query.has('uploadId')) {
    return req.headers['x-amz-copy-source']
      ? multipart.uploadPartCopy(ctx)
      : multipart.uploadPart(ctx);
  }
  if (req.headers['x-amz-copy-source']) return write.copyObject(ctx);
  return write.putObjectContent(ctx);
}

async function postObject(ctx) {
  const { query } = ctx;
  if (query.has('uploads')) return multipart.createMultipartUpload(ctx);
  if (query.has('uploadId')) return multipart.completeMultipartUpload(ctx);
  throw methodNotAllowed('POST');
}

async function deleteObjectRoute(ctx) {
  const { query, res } = ctx;
  if (query.has('uploadId')) {
    await requireBucket(ctx);
    await multipart.requireUpload(ctx);
    await ctx.store.removeUpload(ctx.bucket, query.get('uploadId'));
    send(res, 204, {});
    return;
  }
  if (query.has('tagging')) return tagging.deleteTagging(ctx);
  return del.deleteObjectContent(ctx);
}

module.exports = {
  getOrHeadObject,
  putObject,
  postObject,
  deleteObjectRoute,
  deleteObjects: del.deleteObjects,
};
