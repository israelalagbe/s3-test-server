'use strict';

const { S3Error } = require('../errors');
const { send, sendDoc, quoteEtag } = require('../helpers');
const { readBody, awsUriEncode } = require('../utils');
const { requireBucket } = require('./bucket');

/**
 * Browser-style form upload: POST / with multipart/form-data.
 * Policy documents and their signatures are accepted but not enforced.
 */
async function postFormUpload(ctx) {
  await requireBucket(ctx);
  const contentType = String(ctx.req.headers['content-type'] || '');
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!contentType.startsWith('multipart/form-data') || !boundaryMatch) {
    throw new S3Error(
      'MalformedPOSTRequest',
      'The body of your POST request is not well-formed multipart/form-data.'
    );
  }
  const body = await readBody(ctx.req, { limit: 5 * 1024 * 1024 * 1024 });
  const { fields, file } = parseMultipartFormData(body, boundaryMatch[1]);
  if (!file) {
    throw new S3Error(
      'InvalidArgument',
      'POST requires exactly one file upload per request.',
      { ArgumentName: 'file', ArgumentValue: '0' }
    );
  }
  let key = fields.key;
  if (!key) {
    throw new S3Error(
      'InvalidArgument',
      "Bucket POST must contain a field named 'key'. If it is specified, please check the order of the fields.",
      { ArgumentName: 'key', ArgumentValue: '' }
    );
  }
  key = key.replace(/\$\{filename\}/g, file.filename || '');

  const { Readable } = require('stream');
  const staged = await ctx.store.stageObject(
    ctx.bucket,
    Readable.from([file.content]),
    ['CRC64NVME']
  );
  const meta = await staged.commit(key, {
    contentType:
      fields['Content-Type'] || file.contentType || 'binary/octet-stream',
    cacheControl: fields['Cache-Control'],
    contentDisposition: fields['Content-Disposition'],
    contentEncoding: fields['Content-Encoding'],
    userMetadata: Object.fromEntries(
      Object.entries(fields)
        .filter(([name]) => name.toLowerCase().startsWith('x-amz-meta-'))
        .map(([name, value]) => [
          name.slice('x-amz-meta-'.length).toLowerCase(),
          value,
        ])
    ),
    tagging: {},
    checksums: staged.digests.checksums,
    checksumAlgorithm: 'CRC64NVME',
    checksumType: 'FULL_OBJECT',
  });
  ctx.emitEvent('ObjectCreated:Post', meta);

  const etag = quoteEtag(meta.etag);
  const redirect = fields.success_action_redirect || fields.redirect;
  if (redirect) {
    let location;
    try {
      location = new URL(redirect);
      location.searchParams.set('bucket', ctx.bucket);
      location.searchParams.set('key', key);
      location.searchParams.set('etag', etag);
    } catch {
      location = null;
    }
    if (location) {
      send(ctx.res, 303, { Location: location.toString(), ETag: etag });
      return;
    }
  }
  const status = parseInt(fields.success_action_status, 10);
  if (status === 200 || status === 204) {
    send(ctx.res, status, { ETag: etag });
  } else if (status === 201) {
    const host = ctx.req.headers.host || 'localhost';
    ctx.res.setHeader('ETag', etag);
    sendDoc(ctx.res, 201, 'PostResponse', {
      Location: `http://${host}/${ctx.bucket}/${awsUriEncode(key, false)}`,
      Bucket: ctx.bucket,
      Key: key,
      ETag: etag,
    });
  } else {
    send(ctx.res, 204, { ETag: etag });
  }
}

function parseMultipartFormData(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;

  let offset = body.indexOf(delimiter);
  while (offset !== -1) {
    offset += delimiter.length;
    // closing delimiter "--boundary--"
    if (body[offset] === 0x2d && body[offset + 1] === 0x2d) break;
    // skip the CRLF after the boundary line
    if (body[offset] === 0x0d && body[offset + 1] === 0x0a) offset += 2;

    const headerEnd = body.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) break;
    const rawHeaders = body.subarray(offset, headerEnd).toString('utf8');
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next === -1) break;
    // content runs up to the CRLF that precedes the next boundary
    const content = body.subarray(headerEnd + 4, next - 2);

    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0)
        headers[line.slice(0, idx).trim().toLowerCase()] = line
          .slice(idx + 1)
          .trim();
    }
    const disposition = headers['content-disposition'] || '';
    const nameMatch = /name="([^"]*)"/.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/.exec(disposition);
    if (nameMatch) {
      if (filenameMatch || nameMatch[1] === 'file') {
        file = {
          filename: filenameMatch ? filenameMatch[1] : '',
          content,
          contentType: headers['content-type'],
        };
      } else {
        fields[nameMatch[1]] = content.toString('utf8');
      }
    }
    offset = next;
  }
  return { fields, file };
}

module.exports = { postFormUpload };
