'use strict';

const { S3Error } = require('./models/error');
const { evaluateBucketPolicy } = require('./models/policy');
const { authenticate } = require('./signature');
const { generateRequestId, generateId2 } = require('./utils');
const { resolveVhostBucket } = require('./middleware/vhost');
const { applyCorsHeaders, handlePreflight } = require('./middleware/cors');
const { isWebsiteRequest, serveWebsite } = require('./middleware/website');
const { handleError } = require('./middleware/error-handler');
const serviceController = require('./controllers/service');
const bucketController = require('./controllers/bucket');
const objectController = require('./controllers/object');
const { postFormUpload } = require('./controllers/post');

/** Builds the `(req, res)` handler that routes requests to the controllers. */
function createRequestHandler(server) {
  return function requestHandler(req, res) {
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

  // Authentication (anonymous requests are allowed on public buckets)
  ctx.auth = authenticate({ req, rawPath, query, vhostBucket, options });

  // Bucket access control: anonymous requests are checked against the
  // bucket's canned ACL, then against its bucket policy (which can widen
  // access per key prefix, or deny it). Signed requests have full access.
  if (bucket && bucketMeta && ctx.auth.mode === 'anonymous') {
    const acl = bucketMeta.configs.acl || options.defaultBucketAcl;
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    let allowed =
      acl === 'public-read-write' || (acl === 'public-read' && isRead);
    const policy = bucketMeta.configs.policy;
    if (policy) {
      let action = null;
      let resource;
      if (key) {
        resource = `arn:aws:s3:::${bucket}/${key}`;
        if (isRead) action = 's3:GetObject';
        else if (req.method === 'DELETE') action = 's3:DeleteObject';
        else action = 's3:PutObject';
      } else if (isRead) {
        resource = `arn:aws:s3:::${bucket}`;
        action = 's3:ListBucket';
      } else if (req.method === 'POST') {
        resource = `arn:aws:s3:::${bucket}/*`;
        action = query.has('delete') ? 's3:DeleteObject' : 's3:PutObject';
      }
      if (action) {
        const verdict = evaluateBucketPolicy(policy, action, resource);
        if (verdict === 'allow') allowed = true;
        else if (verdict === 'deny') allowed = false;
      }
    }
    if (!allowed) {
      throw new S3Error('AccessDenied', 'Access Denied');
    }
  }

  // Static website hosting
  if (isWebsiteRequest(ctx, bucketMeta)) {
    await serveWebsite(ctx, bucketMeta.configs.website);
    return;
  }

  if (!bucket) {
    if (req.method === 'GET') {
      await serviceController.listBuckets(ctx);
      return;
    }
    throw methodNotAllowed(req.method, 'SERVICE');
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
        throw methodNotAllowed(req.method, 'BUCKET');
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
      throw methodNotAllowed(req.method, 'OBJECT');
  }
}

function methodNotAllowed(method, resourceType) {
  return new S3Error(
    'MethodNotAllowed',
    'The specified method is not allowed against this resource.',
    { Method: method, ResourceType: resourceType }
  );
}

module.exports = { createRequestHandler };
