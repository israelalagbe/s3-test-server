'use strict';

const { S3Error } = require('../models/error');
const { send } = require('../models/response');
const { escapeRegExp } = require('../utils');

function matchOrigin(rule, origin) {
  return rule.allowedOrigins.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed.includes('*')) {
      const pattern = new RegExp(
        `^${allowed.split('*').map(escapeRegExp).join('.*')}$`
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

/** Sets simple CORS response headers on non-preflight requests. */
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

/** Answers an OPTIONS preflight against the bucket's CORS configuration. */
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

module.exports = { applyCorsHeaders, handlePreflight, findCorsRule };
