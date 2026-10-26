'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const crypto = require('node:crypto');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
const BUCKET = 'chunked-bucket';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}

function signingKey(secret, date, region) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/**
 * Builds a SigV4 signed-streaming PUT (STREAMING-AWS4-HMAC-SHA256-PAYLOAD)
 * exactly like the AWS CLI does, chunking the payload and chaining chunk
 * signatures off the seed signature.
 */
function buildSignedStreamingPut({ host, key, payload, tamper = false }) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const region = 'us-east-1';
  const scope = `${date}/${region}/s3/aws4_request`;
  const chunks = [];
  for (let offset = 0; offset < payload.length; offset += 8192) {
    chunks.push(payload.subarray(offset, offset + 8192));
  }
  chunks.push(Buffer.alloc(0)); // final chunk

  // frame size: each chunk is "<hex>;chunk-signature=<64 hex>\r\n<data>\r\n"
  const framedLength = chunks.reduce(
    (total, chunk) =>
      total +
      chunk.length.toString(16).length +
      ';chunk-signature='.length +
      64 +
      2 +
      chunk.length +
      2,
    0
  );

  const headers = {
    host,
    'content-encoding': 'aws-chunked',
    'content-length': String(framedLength),
    'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
    'x-amz-date': timestamp,
    'x-amz-decoded-content-length': String(payload.length),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    'PUT',
    `/${BUCKET}/${key}`,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const kSigning = signingKey(CREDENTIALS.secretAccessKey, date, region);
  const seedSignature = hmac(kSigning, stringToSign, 'hex');

  let previous = seedSignature;
  const framed = [];
  for (const chunk of chunks) {
    const chunkSts = [
      'AWS4-HMAC-SHA256-PAYLOAD',
      timestamp,
      scope,
      previous,
      EMPTY_SHA256,
      crypto.createHash('sha256').update(chunk).digest('hex'),
    ].join('\n');
    const signature = hmac(kSigning, chunkSts, 'hex');
    previous = signature;
    let data = chunk;
    if (tamper && chunk.length > 0) {
      data = Buffer.from(chunk);
      data[0] ^= 0xff; // flip a byte without re-signing
    }
    framed.push(
      Buffer.from(
        `${chunk.length.toString(16)};chunk-signature=${signature}\r\n`
      ),
      data,
      Buffer.from('\r\n')
    );
  }

  return {
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${CREDENTIALS.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderNames.join(';')}, Signature=${seedSignature}`,
    },
    body: Buffer.concat(framed),
  };
}

before(async () => {
  ctx = await startServer();
  await ctx.server.putObjects(BUCKET, []);
});

after(async () => {
  await ctx.close();
});

test('a correctly chained signed-streaming upload is accepted', async () => {
  const payload = Buffer.alloc(20000, 7);
  const request = buildSignedStreamingPut({
    host: `localhost:${ctx.port}`,
    key: 'signed.bin',
    payload,
  });
  const res = await fetch(`${ctx.endpoint}/${BUCKET}/signed.bin`, {
    method: 'PUT',
    headers: request.headers,
    body: request.body,
  });
  assert.strictEqual(res.status, 200);

  const [stored] = await ctx.server.getObjects(BUCKET, {
    prefix: 'signed.bin',
    bodies: true,
  });
  assert.ok(stored.body.equals(payload));
});

test('a tampered chunk fails with SignatureDoesNotMatch', async () => {
  const payload = Buffer.alloc(20000, 7);
  const request = buildSignedStreamingPut({
    host: `localhost:${ctx.port}`,
    key: 'tampered.bin',
    payload,
    tamper: true,
  });
  const res = await fetch(`${ctx.endpoint}/${BUCKET}/tampered.bin`, {
    method: 'PUT',
    headers: request.headers,
    body: request.body,
  });
  assert.strictEqual(res.status, 403);
  assert.match(await res.text(), /SignatureDoesNotMatch/);

  const objects = await ctx.server.getObjects(BUCKET, {
    prefix: 'tampered.bin',
  });
  assert.strictEqual(objects.length, 0, 'nothing was stored');
});

test('a chunk missing its signature fails too', async () => {
  const payload = Buffer.from('needs signatures');
  const request = buildSignedStreamingPut({
    host: `localhost:${ctx.port}`,
    key: 'missing.bin',
    payload,
  });
  // strip the signature from the first chunk's framing
  const body = Buffer.from(
    request.body
      .toString('latin1')
      .replace(/;chunk-signature=[0-9a-f]{64}/, ''),
    'latin1'
  );
  const res = await fetch(`${ctx.endpoint}/${BUCKET}/missing.bin`, {
    method: 'PUT',
    headers: { ...request.headers, 'content-length': String(body.length) },
    body,
  });
  assert.strictEqual(res.status, 403);
});
