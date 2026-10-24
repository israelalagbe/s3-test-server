'use strict';

const { sendDoc } = require('../models/response');
const { isoDate, DUMMY_OWNER } = require('../utils');

async function listBuckets(ctx) {
  const buckets = await ctx.store.listBuckets();
  sendDoc(ctx.res, 200, 'ListAllMyBucketsResult', {
    Owner: DUMMY_OWNER,
    Buckets: {
      Bucket: buckets.map((bucket) => ({
        Name: bucket.name,
        CreationDate: isoDate(bucket.creationDate),
      })),
    },
  });
}

module.exports = { listBuckets };
