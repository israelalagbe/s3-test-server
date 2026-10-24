'use strict';

const { S3Error } = require('../models/error');
const { sendXml } = require('../models/response');

/** Renders any thrown error as an S3-style XML error response. */
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

module.exports = { handleError };
