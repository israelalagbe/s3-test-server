'use strict';

const { S3Error } = require('../models/error');

function checkAccessKey(accessKeyId, options) {
  if (accessKeyId !== options.accessKeyId) {
    throw new S3Error(
      'InvalidAccessKeyId',
      'The AWS Access Key Id you provided does not exist in our records.',
      { AWSAccessKeyId: accessKeyId }
    );
  }
}

/**
 * Returns the SignatureDoesNotMatch error to throw, or null when the server
 * runs with `allowMismatchedSignatures`.
 */
function signatureMismatch(options, detail) {
  if (options.allowMismatchedSignatures) return null;
  return new S3Error(
    'SignatureDoesNotMatch',
    'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
    detail
  );
}

module.exports = { checkAccessKey, signatureMismatch };
