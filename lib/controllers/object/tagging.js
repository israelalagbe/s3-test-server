'use strict';

// Object tagging subresource.

const { send, sendDoc } = require('../../models/response');
const { readBody } = require('../../utils');
const { requireBucket, parseTaggingConfig } = require('../bucket');
const { requireObject } = require('./helpers');

async function getTagging(ctx) {
  await requireBucket(ctx);
  const meta = await requireObject(ctx);
  sendDoc(ctx.res, 200, 'Tagging', {
    TagSet: {
      Tag: Object.entries(meta.tagging || {}).map(([Key, Value]) => ({
        Key,
        Value,
      })),
    },
  });
}

async function putTagging(ctx) {
  await requireBucket(ctx);
  const meta = await requireObject(ctx);
  const body = await readBody(ctx.req);
  const config = parseTaggingConfig(body.toString('utf8'));
  meta.tagging = config.tags;
  await ctx.store.updateObjectMeta(ctx.bucket, ctx.key, meta);
  send(ctx.res, 200, {});
}

async function deleteTagging(ctx) {
  await requireBucket(ctx);
  const meta = await requireObject(ctx);
  meta.tagging = {};
  await ctx.store.updateObjectMeta(ctx.bucket, ctx.key, meta);
  send(ctx.res, 204, {});
}

module.exports = { getTagging, putTagging, deleteTagging };
