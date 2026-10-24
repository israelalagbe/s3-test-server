'use strict';

const crypto = require('crypto');
const { S3Error } = require('./errors');

/** RFC 3986 encoding as used by AWS signatures and list encoding-type=url. */
function awsUriEncode(value, encodeSlash = true) {
  let out = '';
  for (const char of String(value)) {
    if (/[A-Za-z0-9\-._~]/.test(char) || (char === '/' && !encodeSlash)) {
      out += char;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

function generateRequestId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function generateId2() {
  return crypto.randomBytes(32).toString('base64');
}

function isoDate(ms) {
  return new Date(ms).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

function httpDate(ms) {
  return new Date(ms).toUTCString();
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function validateBucketName(name) {
  if (
    !BUCKET_NAME_RE.test(name) ||
    name.includes('..') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name)
  ) {
    throw new S3Error(
      'InvalidBucketName',
      'The specified bucket is not valid.',
      { BucketName: name }
    );
  }
}

/** Read an entire request body (for XML / form endpoints), with a size cap. */
function readBody(req, { limit = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(
          new S3Error(
            'EntityTooLarge',
            'Your proposed upload exceeds the maximum allowed size'
          )
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Compare keys the way S3 orders them: by UTF-8 byte value. */
function compareKeys(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function xmlEncodeKey(key, encodingType) {
  return encodingType === 'url' ? awsUriEncode(key, false) : key;
}

const DUMMY_OWNER = {
  ID: '123456789012345678901234567890123456789012345678901234567890abcd',
  DisplayName: 's3-test-server',
};

module.exports = {
  awsUriEncode,
  generateRequestId,
  generateId2,
  isoDate,
  httpDate,
  timingSafeEqualStr,
  validateBucketName,
  readBody,
  compareKeys,
  xmlEncodeKey,
  DUMMY_OWNER,
};
