'use strict';

const crypto = require('crypto');
const { S3Error } = require('../models/error');
const { timingSafeEqualStr } = require('../utils');
const { checkAccessKey, signatureMismatch } = require('./common');

// Sub-resources included in the SigV2 canonicalized resource, per the
// AWS Signature Version 2 documentation.
const V2_SUBRESOURCES = new Set([
  'acl',
  'accelerate',
  'analytics',
  'cors',
  'delete',
  'encryption',
  'inventory',
  'lifecycle',
  'location',
  'logging',
  'metrics',
  'notification',
  'object-lock',
  'partNumber',
  'policy',
  'publicAccessBlock',
  'replication',
  'requestPayment',
  'restore',
  'tagging',
  'torrent',
  'uploadId',
  'uploads',
  'versionId',
  'versioning',
  'versions',
  'website',
  'response-content-type',
  'response-content-language',
  'response-expires',
  'response-cache-control',
  'response-content-disposition',
  'response-content-encoding',
]);

function verifyV2({ req, rawPath, query, vhostBucket, options, authHeader }) {
  let accessKeyId;
  let signature;
  let expires = null;
  if (authHeader) {
    const match = /^AWS\s+([^:]+):(.+)$/.exec(authHeader.trim());
    if (!match) {
      throw new S3Error('InvalidArgument', 'Authorization header is invalid', {
        ArgumentName: 'Authorization',
        ArgumentValue: authHeader,
      });
    }
    [, accessKeyId, signature] = match;
  } else {
    accessKeyId = query.get('AWSAccessKeyId');
    signature = query.get('Signature');
    expires = query.get('Expires');
    if (Date.now() > parseInt(expires, 10) * 1000) {
      throw new S3Error('AccessDenied', 'Request has expired', {
        Expires: expires,
        ServerTime: new Date().toISOString(),
      });
    }
  }
  checkAccessKey(accessKeyId, options);

  // Canonicalized x-amz-* headers
  const amzHeaders = Object.keys(req.headers)
    .filter((name) => name.startsWith('x-amz-'))
    .sort()
    .map((name) => {
      const value = Array.isArray(req.headers[name])
        ? req.headers[name].join(',')
        : req.headers[name];
      return `${name}:${String(value).trim()}\n`;
    })
    .join('');

  // Canonicalized resource
  let resource = vhostBucket ? `/${vhostBucket}${rawPath}` : rawPath;
  const subresources = [];
  for (const [name, value] of query.entries()) {
    if (V2_SUBRESOURCES.has(name)) {
      subresources.push(value === '' ? name : `${name}=${value}`);
    }
  }
  if (subresources.length > 0) {
    subresources.sort();
    resource += '?' + subresources.join('&');
  }

  const dateField =
    expires !== null
      ? expires
      : req.headers['x-amz-date']
        ? ''
        : req.headers.date || '';
  const stringToSign = [
    req.method,
    req.headers['content-md5'] || '',
    req.headers['content-type'] || '',
    dateField,
    amzHeaders + resource,
  ].join('\n');
  const expected = crypto
    .createHmac('sha1', options.secretAccessKey)
    .update(stringToSign, 'utf8')
    .digest('base64');
  if (!timingSafeEqualStr(expected, signature)) {
    const err = signatureMismatch(options, {
      AWSAccessKeyId: accessKeyId,
      StringToSign: stringToSign,
      SignatureProvided: signature,
    });
    if (err) throw err;
  }
  return {
    mode: authHeader ? 'v2-header' : 'v2-query',
    accessKeyId,
    contentSha256: null,
  };
}

module.exports = { verifyV2 };
