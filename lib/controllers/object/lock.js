'use strict';

// Object lock: retention and legal holds on individual versions, plus the
// bucket-default retention applied at write time.

const { S3Error } = require('../../models/error');
const { parseXml } = require('../../xml');
const { send, sendDoc } = require('../../models/response');
const { readBody, isoDate } = require('../../utils');
const { requireBucket } = require('../bucket');
const { requireObject } = require('./helpers');

const LOCK_MODES = new Set(['GOVERNANCE', 'COMPLIANCE']);

/**
 * Resolves object-lock fields for a new object version: explicit
 * x-amz-object-lock-* headers, else the bucket's default retention rule.
 */

function objectLockFields(ctx, bucketMeta) {
  const headers = ctx.req.headers;
  const lockConfig = bucketMeta.configs.objectLock;
  const mode = headers['x-amz-object-lock-mode'];
  const retainUntil = headers['x-amz-object-lock-retain-until-date'];
  const legalHold = headers['x-amz-object-lock-legal-hold'];
  if ((mode || retainUntil || legalHold) && !lockConfig) {
    throw new S3Error(
      'InvalidRequest',
      'Bucket is missing Object Lock Configuration'
    );
  }
  const fields = {};
  if (mode || retainUntil) {
    if (!mode || !retainUntil) {
      throw new S3Error(
        'InvalidArgument',
        'x-amz-object-lock-retain-until-date and x-amz-object-lock-mode must both be supplied'
      );
    }
    const upperMode = String(mode).toUpperCase();
    const until = Date.parse(retainUntil);
    if (!LOCK_MODES.has(upperMode) || Number.isNaN(until)) {
      throw new S3Error('InvalidArgument', 'Invalid object lock parameters');
    }
    fields.retentionMode = upperMode;
    fields.retainUntil = until;
  } else if (lockConfig && lockConfig.defaultMode) {
    fields.retentionMode = lockConfig.defaultMode;
    fields.retainUntil =
      Date.now() + lockConfig.defaultRetentionDays * 24 * 60 * 60 * 1000;
  }
  if (legalHold) {
    fields.legalHold = String(legalHold).toUpperCase() === 'ON';
  }
  return fields;
}

/** Throws when a version is protected by retention or a legal hold. */

function checkObjectLock(ctx, meta) {
  if (!meta) return;
  if (meta.legalHold) {
    throw new S3Error(
      'AccessDenied',
      'Access Denied because object protected by object lock.'
    );
  }
  if (meta.retainUntil && meta.retainUntil > Date.now()) {
    const bypass =
      String(
        ctx.req.headers['x-amz-bypass-governance-retention'] || ''
      ).toLowerCase() === 'true';
    if (meta.retentionMode === 'GOVERNANCE' && bypass) return;
    throw new S3Error(
      'AccessDenied',
      'Access Denied because object protected by object lock.'
    );
  }
}

async function getRetention(ctx) {
  await requireBucket(ctx);
  const meta = await requireObject(ctx);
  if (!meta.retentionMode) {
    throw new S3Error(
      'NoSuchObjectLockConfiguration',
      'The specified object does not have a ObjectLock configuration',
      { statusCode: 404 }
    );
  }
  sendDoc(ctx.res, 200, 'Retention', {
    Mode: meta.retentionMode,
    RetainUntilDate: isoDate(meta.retainUntil),
  });
}

async function putRetention(ctx) {
  const bucketMeta = await requireBucket(ctx);
  if (!bucketMeta.configs.objectLock) {
    throw new S3Error(
      'InvalidRequest',
      'Bucket is missing Object Lock Configuration'
    );
  }
  const meta = await requireObject(ctx);
  const body = await readBody(ctx.req);
  let retention;
  try {
    retention = parseXml(body.toString('utf8')).Retention;
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const mode = retention && String(retention.Mode || '').toUpperCase();
  const until = retention && Date.parse(retention.RetainUntilDate);
  if (!LOCK_MODES.has(mode) || Number.isNaN(until)) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  // shortening or removing COMPLIANCE retention is not allowed
  if (
    meta.retentionMode === 'COMPLIANCE' &&
    meta.retainUntil > Date.now() &&
    until < meta.retainUntil
  ) {
    throw new S3Error(
      'AccessDenied',
      'Access Denied because object protected by object lock.'
    );
  }
  meta.retentionMode = mode;
  meta.retainUntil = until;
  await ctx.store.updateObjectMeta(ctx.bucket, ctx.key, meta);
  send(ctx.res, 200, {});
}

async function getLegalHold(ctx) {
  await requireBucket(ctx);
  const meta = await requireObject(ctx);
  sendDoc(ctx.res, 200, 'LegalHold', {
    Status: meta.legalHold ? 'ON' : 'OFF',
  });
}

async function putLegalHold(ctx) {
  const bucketMeta = await requireBucket(ctx);
  if (!bucketMeta.configs.objectLock) {
    throw new S3Error(
      'InvalidRequest',
      'Bucket is missing Object Lock Configuration'
    );
  }
  const meta = await requireObject(ctx);
  const body = await readBody(ctx.req);
  let status;
  try {
    status = parseXml(body.toString('utf8')).LegalHold?.Status;
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  if (status !== 'ON' && status !== 'OFF') {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  meta.legalHold = status === 'ON';
  await ctx.store.updateObjectMeta(ctx.bucket, ctx.key, meta);
  send(ctx.res, 200, {});
}

module.exports = {
  objectLockFields,
  checkObjectLock,
  getRetention,
  putRetention,
  getLegalHold,
  putLegalHold,
};
