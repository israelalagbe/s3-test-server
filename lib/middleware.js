'use strict';

const { S3Error } = require('./errors');
const { authenticate } = require('./signature');
const { send, sendXml, sendDoc } = require('./helpers');
const { generateRequestId, generateId2, isoDate } = require('./utils');
const { escapeXml } = require('./xml');
const bucketController = require('./controllers/bucket');
const objectController = require('./controllers/object');
const { postFormUpload } = require('./controllers/post');

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

function createMiddleware(server) {
  return function middleware(req, res) {
    handleRequest(server, req, res).catch((err) => {
      handleError(server, req, res, err);
    });
  };
}

async function handleRequest(server, req, res) {
  const { options, store, logger } = server;
  req.requestId = generateRequestId();
  res.setHeader('x-amz-request-id', req.requestId);
  res.setHeader('x-amz-id-2', generateId2());

  res.on('finish', () => {
    logger.info(`${req.method} ${req.url} ${res.statusCode}`);
  });

  const queryIndex = req.url.indexOf('?');
  const rawPath = queryIndex === -1 ? req.url : req.url.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : req.url.slice(queryIndex + 1);
  const query = new URLSearchParams(rawQuery);

  const vhostBucket = resolveVhostBucket(req, options);
  let bucket = vhostBucket;
  let key = '';
  try {
    if (vhostBucket) {
      key = decodeURIComponent(rawPath.slice(1));
    } else {
      const trimmed = rawPath.replace(/^\//, '');
      const slash = trimmed.indexOf('/');
      if (slash === -1) {
        bucket = decodeURIComponent(trimmed) || null;
      } else {
        bucket = decodeURIComponent(trimmed.slice(0, slash));
        key = decodeURIComponent(trimmed.slice(slash + 1));
      }
    }
  } catch {
    throw new S3Error('InvalidURI', "Couldn't parse the specified URI.");
  }

  const ctx = {
    req,
    res,
    store,
    options,
    logger,
    query,
    rawPath,
    bucket,
    key,
    auth: null,
    requestId: req.requestId,
    emitEvent: (eventName, objectMeta) =>
      server._emitEvent(eventName, bucket, objectMeta),
  };
  req.s3Resource = bucket ? `/${bucket}${key ? `/${key}` : ''}` : '/';

  // CORS
  const bucketMeta = bucket ? await store.getBucket(bucket) : null;
  const corsConfig = bucketMeta && bucketMeta.configs.cors;
  if (req.method === 'OPTIONS') {
    handlePreflight(ctx, corsConfig);
    return;
  }
  applyCorsHeaders(ctx, corsConfig);

  // Authentication (anonymous requests are allowed, like public buckets)
  ctx.auth = authenticate({
    req,
    rawPath,
    query,
    vhostBucket,
    options,
  });

  // Static website hosting
  if (
    bucket &&
    bucketMeta &&
    bucketMeta.configs.website &&
    (req.method === 'GET' || req.method === 'HEAD') &&
    ctx.auth.mode === 'anonymous' &&
    !API_SUBRESOURCES.some((subresource) => query.has(subresource))
  ) {
    await serveWebsite(ctx, bucketMeta.configs.website);
    return;
  }

  if (!bucket) {
    if (req.method === 'GET') {
      await listBuckets(ctx);
      return;
    }
    throw new S3Error(
      'MethodNotAllowed',
      'The specified method is not allowed against this resource.',
      {
        Method: req.method,
        ResourceType: 'SERVICE',
      }
    );
  }

  if (!key) {
    switch (req.method) {
      case 'GET':
        await bucketController.getBucket(ctx);
        return;
      case 'PUT':
        await bucketController.putBucket(ctx);
        return;
      case 'DELETE':
        await bucketController.deleteBucket(ctx);
        return;
      case 'HEAD':
        await bucketController.headBucket(ctx);
        return;
      case 'POST':
        if (query.has('delete')) {
          await objectController.deleteObjects(ctx);
        } else {
          await postFormUpload(ctx);
        }
        return;
      default:
        throw new S3Error(
          'MethodNotAllowed',
          'The specified method is not allowed against this resource.',
          {
            Method: req.method,
            ResourceType: 'BUCKET',
          }
        );
    }
  }

  switch (req.method) {
    case 'GET':
    case 'HEAD':
      await objectController.getOrHeadObject(ctx);
      return;
    case 'PUT':
      await objectController.putObject(ctx);
      return;
    case 'POST':
      await objectController.postObject(ctx);
      return;
    case 'DELETE':
      await objectController.deleteObjectRoute(ctx);
      return;
    default:
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
        {
          Method: req.method,
          ResourceType: 'OBJECT',
        }
      );
  }
}

function resolveVhostBucket(req, options) {
  if (!options.vhostBuckets) return null;
  const host = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    /^[\d.]+$/.test(host) ||
    host === '[::1]'
  ) {
    return null;
  }
  if (host === options.address || host === options.serviceEndpoint) return null;

  const patterns = [
    // bucket.s3.region.amazonaws.com / bucket.s3-region.amazonaws.com
    new RegExp(
      `^(.+)\\.s3[.-][a-z0-9-]+\\.${escapeRe(options.serviceEndpoint)}$`
    ),
    // bucket.s3.amazonaws.com
    new RegExp(`^(.+)\\.s3\\.${escapeRe(options.serviceEndpoint)}$`),
    // bucket.amazonaws.com-style custom endpoints
    new RegExp(`^(.+)\\.${escapeRe(options.serviceEndpoint)}$`),
    // bucket.localhost
    /^(.+)\.localhost$/,
  ];
  if (
    options.address &&
    options.address !== 'localhost' &&
    !/^[\d.]+$/.test(options.address)
  ) {
    patterns.push(new RegExp(`^(.+)\\.${escapeRe(options.address)}$`));
  }
  for (const pattern of patterns) {
    const match = pattern.exec(host);
    if (match) {
      const prefix = match[1];
      if (
        prefix === 's3' ||
        prefix.startsWith('s3.') ||
        prefix.startsWith('s3-')
      ) {
        return null;
      }
      return prefix;
    }
  }
  return null;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- CORS

function matchOrigin(rule, origin) {
  return rule.allowedOrigins.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed.includes('*')) {
      const pattern = new RegExp(
        `^${allowed.split('*').map(escapeRe).join('.*')}$`
      );
      return pattern.test(origin);
    }
    return allowed === origin;
  });
}

function findCorsRule(corsConfig, origin, method, requestHeaders = []) {
  if (!corsConfig) return null;
  for (const rule of corsConfig.rules) {
    if (!matchOrigin(rule, origin)) continue;
    if (!rule.allowedMethods.includes(method)) continue;
    const allowAllHeaders = rule.allowedHeaders.includes('*');
    const headersOk = requestHeaders.every(
      (header) =>
        allowAllHeaders ||
        rule.allowedHeaders.some(
          (allowed) =>
            allowed === header ||
            (allowed.endsWith('*') && header.startsWith(allowed.slice(0, -1)))
        )
    );
    if (!headersOk) continue;
    return rule;
  }
  return null;
}

function applyCorsHeaders(ctx, corsConfig) {
  const origin = ctx.req.headers.origin;
  if (!origin || !corsConfig) return;
  const rule = findCorsRule(corsConfig, origin, ctx.req.method);
  if (!rule) return;
  const wildcard = rule.allowedOrigins.includes('*');
  ctx.res.setHeader('Access-Control-Allow-Origin', wildcard ? '*' : origin);
  if (!wildcard) {
    ctx.res.setHeader('Access-Control-Allow-Credentials', 'true');
    ctx.res.setHeader(
      'Vary',
      'Origin, Access-Control-Request-Headers, Access-Control-Request-Method'
    );
  }
  if (rule.exposeHeaders.length > 0) {
    ctx.res.setHeader(
      'Access-Control-Expose-Headers',
      rule.exposeHeaders.join(', ')
    );
  }
}

function handlePreflight(ctx, corsConfig) {
  const origin = ctx.req.headers.origin;
  const method = ctx.req.headers['access-control-request-method'];
  if (!origin || !method) {
    throw new S3Error(
      'BadRequest',
      'Insufficient information. Origin request header needed.',
      { statusCode: 400 }
    );
  }
  const requestHeaders = String(
    ctx.req.headers['access-control-request-headers'] || ''
  )
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const rule = findCorsRule(corsConfig, origin, method, requestHeaders);
  if (!rule) {
    throw new S3Error(
      'AccessForbidden',
      corsConfig
        ? "CORSResponse: This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers are not whitelisted by the resource's CORS spec."
        : 'CORSResponse: CORS is not enabled for this bucket.',
      { statusCode: 403, Method: method, ResourceType: 'OBJECT' }
    );
  }
  const wildcard = rule.allowedOrigins.includes('*');
  const headers = {
    'Access-Control-Allow-Origin': wildcard ? '*' : origin,
    'Access-Control-Allow-Methods': rule.allowedMethods.join(', '),
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
  };
  if (!wildcard) headers['Access-Control-Allow-Credentials'] = 'true';
  if (requestHeaders.length > 0) {
    headers['Access-Control-Allow-Headers'] = requestHeaders.join(', ');
  }
  if (rule.maxAgeSeconds !== undefined) {
    headers['Access-Control-Max-Age'] = rule.maxAgeSeconds;
  }
  send(ctx.res, 200, headers);
}

// ---------------------------------------------------------------- website

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
  if (!meta && !ctx.key.endsWith('/') && ctx.key !== '') {
    // folder-style redirect: /foo → /foo/ when foo/index.html exists
    const indexKey = `${ctx.key}/${website.indexDocument}`;
    if (await ctx.store.getObject(ctx.bucket, indexKey)) {
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
      const errorMeta = await ctx.store.getObject(
        ctx.bucket,
        website.errorDocument
      );
      if (errorMeta) {
        ctx.res.writeHead(404, {
          'Content-Type': errorMeta.contentType || 'text/html',
          'Content-Length': errorMeta.size,
        });
        if (ctx.req.method === 'HEAD') {
          ctx.res.end();
          return;
        }
        ctx.store
          .createObjectReadStream(ctx.bucket, website.errorDocument)
          .pipe(ctx.res);
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
  ctx.store.createObjectReadStream(ctx.bucket, key).pipe(ctx.res);
}

// ---------------------------------------------------------------- service

async function listBuckets(ctx) {
  const buckets = await ctx.store.listBuckets();
  const { DUMMY_OWNER } = require('./utils');
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

// ---------------------------------------------------------------- errors

function handleError(server, req, res, err) {
  const s3Error =
    err instanceof S3Error
      ? err
      : new S3Error(
          'InternalError',
          'We encountered an internal error. Please try again.'
        );
  if (!(err instanceof S3Error)) {
    server.logger.error(err.stack || String(err));
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Drain any unread request body so keep-alive connections stay usable.
  req.resume();
  sendXml(
    res,
    s3Error.statusCode,
    s3Error.toXml({ requestId: req.requestId, resource: req.s3Resource })
  );
}

module.exports = { createMiddleware };
