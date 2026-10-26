'use strict';

// Object deletion: single deletes (markers on versioned buckets, permanent
// with a versionId) and the batch DeleteObjects API.

const { S3Error } = require('../../models/error');
const { parseXml, asArray } = require('../../xml');
const { send, sendDoc } = require('../../models/response');
const { readBody } = require('../../utils');
const { requireBucket } = require('../bucket');
const { checkObjectLock } = require('./lock');

/** Deletes one object or version, honoring versioning and object lock. */
async function deleteObjectContent(ctx) {
  const { query, res } = ctx;
  const bucketMeta = await requireBucket(ctx);
  const versioning = bucketMeta.configs.versioning;
  const versionId = query.get('versionId') || undefined;
  if (versionId !== undefined) {
    // deleting a specific version is permanent, so object lock applies
    const target = await ctx.store.getObject(ctx.bucket, ctx.key, versionId);
    checkObjectLock(ctx, target);
  }
  const result = await ctx.store.deleteObject(ctx.bucket, ctx.key, {
    versionId,
    versioning,
  });
  const headers = {};
  if (result.deleteMarker || result.removedMarker) {
    headers['x-amz-delete-marker'] = 'true';
  }
  if (result.versionId && result.versionId !== 'null') {
    headers['x-amz-version-id'] = result.versionId;
  }
  if (result.existed) {
    ctx.emitEvent(
      result.deleteMarker
        ? 'ObjectRemoved:DeleteMarkerCreated'
        : 'ObjectRemoved:Delete',
      { key: ctx.key, size: 0, etag: undefined, versionId: result.versionId }
    );
  }
  send(res, 204, headers);
}

async function deleteObjects(ctx) {
  const bucketMeta = await requireBucket(ctx);
  const versioning = bucketMeta.configs.versioning;
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
  const errors = [];
  for (const object of objects) {
    const key = typeof object.Key === 'string' ? object.Key : '';
    const versionId =
      typeof object.VersionId === 'string' && object.VersionId !== ''
        ? object.VersionId
        : undefined;
    if (versionId !== undefined) {
      const target = await ctx.store.getObject(ctx.bucket, key, versionId);
      try {
        checkObjectLock(ctx, target);
      } catch (err) {
        errors.push({
          Key: key,
          VersionId: versionId,
          Code: err.code,
          Message: err.message,
        });
        continue;
      }
    }
    const result = await ctx.store.deleteObject(ctx.bucket, key, {
      versionId,
      versioning,
    });
    if (result.existed) {
      ctx.emitEvent(
        result.deleteMarker
          ? 'ObjectRemoved:DeleteMarkerCreated'
          : 'ObjectRemoved:Delete',
        { key, size: 0, etag: undefined, versionId: result.versionId }
      );
    }
    const entry = { Key: key };
    if (versionId !== undefined) entry.VersionId = versionId;
    if (result.deleteMarker) {
      entry.DeleteMarker = true;
      if (result.versionId && result.versionId !== 'null') {
        entry.DeleteMarkerVersionId = result.versionId;
      }
    }
    deleted.push(entry);
  }
  sendDoc(ctx.res, 200, 'DeleteResult', {
    Deleted: quiet ? [] : deleted,
    Error: errors,
  });
}

module.exports = { deleteObjectContent, deleteObjects };
