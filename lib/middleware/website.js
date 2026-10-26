'use strict';

const { send } = require('../models/response');
const { escapeXml } = require('../xml');

// Query parameters that indicate an S3 API call rather than a website fetch.
const API_SUBRESOURCES = [
  'acl',
  'cors',
  'website',
  'tagging',
  'location',
  'versioning',
  'versions',
  'uploads',
  'uploadId',
  'delete',
  'policy',
  'lifecycle',
  'encryption',
  'object-lock',
  'publicAccessBlock',
  'notification',
  'requestPayment',
  'logging',
  'accelerate',
  'attributes',
  'list-type',
  'replication',
  'torrent',
];

/** True when the request should be served in static-website mode. */
function isWebsiteRequest(ctx, bucketMeta) {
  return Boolean(
    ctx.bucket &&
    bucketMeta &&
    bucketMeta.configs.website &&
    (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') &&
    ctx.auth.mode === 'anonymous' &&
    !API_SUBRESOURCES.some((subresource) => ctx.query.has(subresource))
  );
}

async function serveWebsite(ctx, website) {
  if (website.redirectAllRequestsTo) {
    const target = `${website.redirectAllRequestsTo.protocol}://${website.redirectAllRequestsTo.hostName}/${ctx.key}`;
    send(ctx.res, 301, { Location: target });
    return;
  }
  let key = ctx.key;
  if (key === '' || key.endsWith('/')) {
    key += website.indexDocument;
  }
  let meta = await ctx.store.getObject(ctx.bucket, key);
  if (meta && meta.isDeleteMarker) meta = null;
  if (!meta && !ctx.key.endsWith('/') && ctx.key !== '') {
    // folder-style redirect: /foo → /foo/ when foo/index.html exists
    const indexKey = `${ctx.key}/${website.indexDocument}`;
    const indexMeta = await ctx.store.getObject(ctx.bucket, indexKey);
    if (indexMeta && !indexMeta.isDeleteMarker) {
      send(ctx.res, 302, { Location: `/${ctx.key}/` });
      return;
    }
  }
  if (meta && meta.websiteRedirectLocation) {
    send(ctx.res, 301, { Location: meta.websiteRedirectLocation });
    return;
  }
  if (!meta) {
    if (website.errorDocument) {
      let errorMeta = await ctx.store.getObject(
        ctx.bucket,
        website.errorDocument
      );
      if (errorMeta && errorMeta.isDeleteMarker) errorMeta = null;
      if (errorMeta) {
        ctx.res.writeHead(404, {
          'Content-Type': errorMeta.contentType || 'text/html',
          'Content-Length': errorMeta.size,
        });
        if (ctx.req.method === 'HEAD') {
          ctx.res.end();
          return;
        }
        ctx.store.createObjectReadStream(ctx.bucket, errorMeta).pipe(ctx.res);
        return;
      }
    }
    const html =
      '<!DOCTYPE html><html><head><title>404 Not Found</title></head>' +
      `<body><h1>404 Not Found</h1><ul><li>Code: NoSuchKey</li><li>Message: The specified key does not exist.</li><li>Key: ${escapeXml(key)}</li></ul></body></html>`;
    send(ctx.res, 404, { 'Content-Type': 'text/html' }, html);
    return;
  }
  ctx.res.writeHead(200, {
    'Content-Type': meta.contentType || 'text/html',
    'Content-Length': meta.size,
    ETag: `"${meta.etag}"`,
    'Last-Modified': new Date(meta.lastModified).toUTCString(),
  });
  if (ctx.req.method === 'HEAD') {
    ctx.res.end();
    return;
  }
  ctx.store.createObjectReadStream(ctx.bucket, meta).pipe(ctx.res);
}

module.exports = { isWebsiteRequest, serveWebsite };
