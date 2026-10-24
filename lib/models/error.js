'use strict';

const STATUS_CODES = {
  AccessDenied: 403,
  AuthorizationHeaderMalformed: 400,
  AuthorizationQueryParametersError: 400,
  BadDigest: 400,
  BucketAlreadyExists: 409,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  EntityTooSmall: 400,
  EntityTooLarge: 400,
  ExpiredToken: 400,
  IncompleteBody: 400,
  InternalError: 500,
  InvalidAccessKeyId: 403,
  InvalidArgument: 400,
  InvalidBucketName: 400,
  InvalidDigest: 400,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  InvalidRange: 416,
  InvalidRequest: 400,
  InvalidToken: 400,
  InvalidURI: 400,
  KeyTooLongError: 400,
  MalformedPOSTRequest: 400,
  MalformedXML: 400,
  MethodNotAllowed: 405,
  MissingContentLength: 411,
  MissingRequestBodyError: 400,
  MissingSecurityHeader: 400,
  NoSuchBucket: 404,
  NoSuchBucketPolicy: 404,
  NoSuchCORSConfiguration: 404,
  NoSuchKey: 404,
  NoSuchLifecycleConfiguration: 404,
  NoSuchTagSet: 404,
  NoSuchUpload: 404,
  NoSuchWebsiteConfiguration: 404,
  NotImplemented: 501,
  PreconditionFailed: 412,
  RequestTimeTooSkewed: 403,
  SignatureDoesNotMatch: 403,
  XAmzContentSHA256Mismatch: 400,
};

/**
 * An error that renders as an S3-style XML error response.
 * `detail` entries become extra XML elements in the <Error> document
 * (e.g. StringToSign for SignatureDoesNotMatch).
 */
class S3Error extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'S3Error';
    this.code = code;
    this.statusCode = detail.statusCode || STATUS_CODES[code] || 500;
    this.detail = { ...detail };
    delete this.detail.statusCode;
  }

  toXml({ requestId, resource } = {}) {
    const { escapeXml } = require('../xml');
    let body = '<?xml version="1.0" encoding="UTF-8"?>\n<Error>';
    body += `<Code>${escapeXml(this.code)}</Code>`;
    body += `<Message>${escapeXml(this.message)}</Message>`;
    for (const [key, value] of Object.entries(this.detail)) {
      if (value === undefined || value === null) continue;
      body += `<${key}>${escapeXml(String(value))}</${key}>`;
    }
    if (resource) body += `<Resource>${escapeXml(resource)}</Resource>`;
    body += `<RequestId>${escapeXml(requestId || '')}</RequestId>`;
    body += '</Error>';
    return body;
  }
}

module.exports = { S3Error, STATUS_CODES };
