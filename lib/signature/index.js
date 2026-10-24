'use strict';

const { S3Error } = require('../models/error');
const { verifyV2 } = require('./v2');
const { verifyV4Header, verifyV4Query } = require('./v4');

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

module.exports = { authenticate };
