'use strict';

const crypto = require('crypto');
const { S3Error } = require('./errors');
const { awsUriEncode, timingSafeEqualStr } = require('./utils');

const MAX_SKEW_MS = 15 * 60 * 1000;

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

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    value || ''
  );
  if (!match) return NaN;
  return Date.UTC(
    +match[1],
    +match[2] - 1,
    +match[3],
    +match[4],
    +match[5],
    +match[6]
  );
}

function canonicalQueryString(query, { excludeSignature = false } = {}) {
  const pairs = [];
  for (const [name, value] of query.entries()) {
    if (excludeSignature && name === 'X-Amz-Signature') continue;
    pairs.push([awsUriEncode(name), awsUriEncode(value)]);
  }
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

function canonicalHeaders(req, signedHeaderNames) {
  const lines = [];
  for (const name of signedHeaderNames) {
    let value = req.headers[name];
    if (value === undefined) {
      if (name === 'host') value = req.headers[':authority'] || '';
      else value = '';
    }
    if (Array.isArray(value)) value = value.join(',');
    lines.push(`${name}:${String(value).trim().replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Authenticates a request. Supports:
 *  - SigV4 Authorization header (AWS4-HMAC-SHA256)
 *  - SigV4 presigned query (X-Amz-Algorithm=AWS4-HMAC-SHA256)
 *  - SigV2 Authorization header (AWS AKID:signature)
 *  - SigV2 presigned query (AWSAccessKeyId/Expires/Signature)
 *  - anonymous requests
 *
 * Returns { mode, accessKeyId, contentSha256 } where contentSha256 is the
 * declared payload hash to verify against the actual body (SigV4 only), or
 * null when no verification applies.
 */
function authenticate({ req, rawPath, query, vhostBucket, options }) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    if (authHeader.startsWith('AWS4-HMAC-SHA256')) {
      return verifyV4Header({ req, rawPath, query, authHeader, options });
    }
    if (authHeader.startsWith('AWS ')) {
      return verifyV2({
        req,
        rawPath,
        query,
        vhostBucket,
        options,
        authHeader,
      });
    }
    throw new S3Error('InvalidArgument', 'Unsupported Authorization Type', {
      ArgumentName: 'Authorization',
      ArgumentValue: authHeader,
    });
  }
  if (query.get('X-Amz-Algorithm')) {
    return verifyV4Query({ req, rawPath, query, options });
  }
  if (query.get('Signature') && query.get('AWSAccessKeyId')) {
    return verifyV2({ req, rawPath, query, vhostBucket, options });
  }
  return { mode: 'anonymous', accessKeyId: null, contentSha256: null };
}

function checkAccessKey(accessKeyId, options) {
  if (accessKeyId !== options.accessKeyId) {
    throw new S3Error(
      'InvalidAccessKeyId',
      'The AWS Access Key Id you provided does not exist in our records.',
      { AWSAccessKeyId: accessKeyId }
    );
  }
}

function signatureMismatch(options, detail) {
  if (options.allowMismatchedSignatures) return null;
  return new S3Error(
    'SignatureDoesNotMatch',
    'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
    detail
  );
}

function verifyV4Header({ req, rawPath, query, authHeader, options }) {
  const match =
    /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]+)$/.exec(
      authHeader.trim()
    );
  if (!match) {
    throw new S3Error(
      'AuthorizationHeaderMalformed',
      'The authorization header is malformed.'
    );
  }
  const [, credential, signedHeaders, signature] = match;
  const credParts = credential.split('/');
  if (
    credParts.length !== 5 ||
    credParts[3] !== 's3' ||
    credParts[4] !== 'aws4_request'
  ) {
    throw new S3Error(
      'AuthorizationHeaderMalformed',
      `The authorization header is malformed; the credential scope is incorrect.`
    );
  }
  const [accessKeyId, credDate, region] = credParts;
  checkAccessKey(accessKeyId, options);

  const amzDate = req.headers['x-amz-date'];
  const dateMs = amzDate
    ? parseAmzDate(amzDate)
    : Date.parse(req.headers.date || '');
  if (Number.isNaN(dateMs)) {
    throw new S3Error(
      'AccessDenied',
      'AWS authentication requires a valid Date or x-amz-date header'
    );
  }
  if (Math.abs(Date.now() - dateMs) > MAX_SKEW_MS) {
    throw new S3Error(
      'RequestTimeTooSkewed',
      "The difference between the request time and the server's time is too large."
    );
  }

  const contentSha256 = req.headers['x-amz-content-sha256'];
  if (!contentSha256) {
    throw new S3Error(
      'InvalidRequest',
      'Missing required header for this request: x-amz-content-sha256'
    );
  }

  const timestamp = amzDate || toAmzDate(dateMs);
  const scope = `${credDate}/${region}/s3/aws4_request`;
  const signedHeaderNames = signedHeaders.split(';');
  const canonicalRequest = [
    req.method,
    rawPath,
    canonicalQueryString(query),
    canonicalHeaders(req, signedHeaderNames),
    signedHeaders,
    contentSha256,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const expected = computeV4Signature(
    options.secretAccessKey,
    credDate,
    region,
    stringToSign
  );
  if (!timingSafeEqualStr(expected, signature)) {
    const err = signatureMismatch(options, {
      AWSAccessKeyId: accessKeyId,
      StringToSign: stringToSign,
      SignatureProvided: signature,
      CanonicalRequest: canonicalRequest,
    });
    if (err) throw err;
  }
  return { mode: 'v4-header', accessKeyId, contentSha256 };
}

function verifyV4Query({ req, rawPath, query, options }) {
  const algorithm = query.get('X-Amz-Algorithm');
  if (algorithm !== 'AWS4-HMAC-SHA256') {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"'
    );
  }
  const credential = query.get('X-Amz-Credential') || '';
  const signature = query.get('X-Amz-Signature') || '';
  const signedHeaders = query.get('X-Amz-SignedHeaders') || '';
  const amzDate = query.get('X-Amz-Date') || '';
  const expires = parseInt(query.get('X-Amz-Expires') || '', 10);
  const credParts = credential.split('/');
  if (credParts.length !== 5 || !signature || !signedHeaders || !amzDate) {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'Query-string authentication version 4 requires the X-Amz-Algorithm, X-Amz-Credential, X-Amz-Signature, X-Amz-Date, X-Amz-SignedHeaders, and X-Amz-Expires parameters.'
    );
  }
  const [accessKeyId, credDate, region] = credParts;
  checkAccessKey(accessKeyId, options);

  const dateMs = parseAmzDate(amzDate);
  if (Number.isNaN(dateMs)) {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'X-Amz-Date is malformed'
    );
  }
  if (!Number.isNaN(expires) && Date.now() > dateMs + expires * 1000) {
    throw new S3Error('AccessDenied', 'Request has expired', {
      'X-Amz-Expires': expires,
      Expires: new Date(dateMs + expires * 1000).toISOString(),
      ServerTime: new Date().toISOString(),
    });
  }

  const signedHeaderNames = signedHeaders.split(';');
  const canonicalRequest = [
    req.method,
    rawPath,
    canonicalQueryString(query, { excludeSignature: true }),
    canonicalHeaders(req, signedHeaderNames),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${credDate}/${region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const expected = computeV4Signature(
    options.secretAccessKey,
    credDate,
    region,
    stringToSign
  );
  if (!timingSafeEqualStr(expected, signature)) {
    const err = signatureMismatch(options, {
      AWSAccessKeyId: accessKeyId,
      StringToSign: stringToSign,
      SignatureProvided: signature,
    });
    if (err) throw err;
  }
  return { mode: 'v4-query', accessKeyId, contentSha256: null };
}

function computeV4Signature(secret, credDate, region, stringToSign) {
  const kDate = hmac(`AWS4${secret}`, credDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  return hmac(kSigning, stringToSign, 'hex');
}

function toAmzDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
}

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

module.exports = { authenticate };
