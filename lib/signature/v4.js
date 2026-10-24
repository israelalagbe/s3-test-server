'use strict';

const crypto = require('crypto');
const { S3Error } = require('../models/error');
const { awsUriEncode, timingSafeEqualStr } = require('../utils');
const { checkAccessKey, signatureMismatch } = require('./common');

const MAX_SKEW_MS = 15 * 60 * 1000;

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
  if (options.enforceRegion && region !== options.region) {
    throw new S3Error(
      'AuthorizationHeaderMalformed',
      `The authorization header is malformed; the region '${region}' is wrong; expecting '${options.region}'`,
      { Region: options.region }
    );
  }

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
  if (credParts[3] !== 's3' || credParts[4] !== 'aws4_request') {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'Error parsing the X-Amz-Credential parameter; the credential scope is incorrect.'
    );
  }
  checkAccessKey(accessKeyId, options);
  if (options.enforceRegion && region !== options.region) {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      `Error parsing the X-Amz-Credential parameter; the region '${region}' is wrong; expecting '${options.region}'`,
      { Region: options.region }
    );
  }

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

module.exports = { verifyV4Header, verifyV4Query };
