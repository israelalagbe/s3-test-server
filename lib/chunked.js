'use strict';

const crypto = require('crypto');
const { Transform } = require('stream');
const { S3Error } = require('./models/error');

const MAX_HEADER_LENGTH = 64 * 1024;
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Decodes the `aws-chunked` content encoding used by SigV4 streaming uploads:
 *
 *   <hex-size>[;chunk-signature=...]\r\n<data>\r\n ... 0[;chunk-signature=...]\r\n
 *   [trailer-name:value\r\n ...]\r\n
 *
 * Emits the raw payload bytes and collects any trailing checksum headers in
 * `this.trailers` (lowercased names), available once the stream ends.
 *
 * When constructed with a `verifier` (from a STREAMING-AWS4-HMAC-SHA256
 * seed signature), every chunk signature is re-verified against the chain:
 *
 *   sig(n) = HMAC(signingKey, "AWS4-HMAC-SHA256-PAYLOAD" \n timestamp \n
 *                 scope \n sig(n-1) \n sha256("") \n sha256(chunk data))
 *
 * A mismatched or missing chunk signature fails the upload with
 * SignatureDoesNotMatch. The final `x-amz-trailer-signature` is accepted
 * without re-verification.
 */
class AwsChunkedDecoder extends Transform {
  constructor(verifier = null) {
    super();
    this.buffer = Buffer.alloc(0);
    this.state = 'size';
    this.remaining = 0;
    this.trailers = {};
    this.verifier = verifier || null;
    this.previousSignature = verifier ? verifier.seedSignature : null;
    this.currentSignature = null;
    this.chunkHash = null;
  }

  _transform(chunk, _encoding, callback) {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this._consume();
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    if (
      this.state === 'data' ||
      (this.state === 'size' && this.buffer.length > 0)
    ) {
      callback(new Error('Truncated aws-chunked payload'));
      return;
    }
    callback();
  }

  _readLine() {
    const idx = this.buffer.indexOf('\r\n');
    if (idx === -1) {
      if (this.buffer.length > MAX_HEADER_LENGTH) {
        throw new Error('aws-chunked header line too long');
      }
      return null;
    }
    const line = this.buffer.subarray(0, idx).toString('utf8');
    this.buffer = this.buffer.subarray(idx + 2);
    return line;
  }

  _verifyChunk() {
    if (!this.verifier) return;
    if (!this.currentSignature) {
      throw new S3Error(
        'SignatureDoesNotMatch',
        'A streaming chunk is missing its chunk-signature.'
      );
    }
    const dataHash = this.chunkHash.digest('hex');
    const stringToSign = [
      'AWS4-HMAC-SHA256-PAYLOAD',
      this.verifier.timestamp,
      this.verifier.scope,
      this.previousSignature,
      EMPTY_SHA256,
      dataHash,
    ].join('\n');
    const expected = crypto
      .createHmac('sha256', this.verifier.signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');
    const provided = Buffer.from(this.currentSignature);
    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), provided)
    ) {
      throw new S3Error(
        'SignatureDoesNotMatch',
        'The chunk signature we calculated does not match the signature you provided.'
      );
    }
    this.previousSignature = this.currentSignature;
  }

  _consume() {
    for (;;) {
      if (this.state === 'done') {
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.state === 'size') {
        const line = this._readLine();
        if (line === null) return;
        if (line === '') continue; // tolerate stray blank lines between chunks
        const [sizeToken, ...params] = line.split(';');
        if (!/^[0-9a-fA-F]+$/.test(sizeToken.trim())) {
          throw new Error(
            `Invalid aws-chunked size line: ${JSON.stringify(line)}`
          );
        }
        this.currentSignature = null;
        for (const param of params) {
          const [name, value] = param.split('=');
          if (name && name.trim() === 'chunk-signature') {
            this.currentSignature = (value || '').trim();
          }
        }
        this.remaining = parseInt(sizeToken.trim(), 16);
        this.chunkHash = this.verifier ? crypto.createHash('sha256') : null;
        if (this.remaining === 0) {
          this._verifyChunk();
          this.state = 'trailer';
        } else {
          this.state = 'data';
        }
      } else if (this.state === 'data') {
        if (this.buffer.length === 0) return;
        const take = Math.min(this.remaining, this.buffer.length);
        const slice = this.buffer.subarray(0, take);
        if (this.chunkHash) this.chunkHash.update(slice);
        this.push(slice);
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) {
          this._verifyChunk();
          this.state = 'data-crlf';
        }
      } else if (this.state === 'data-crlf') {
        if (this.buffer.length < 2) return;
        // Expect \r\n after the chunk body; be lenient if it is missing.
        if (this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
          this.buffer = this.buffer.subarray(2);
        }
        this.state = 'size';
      } else if (this.state === 'trailer') {
        const line = this._readLine();
        if (line === null) {
          // No trailing CRLF after the zero chunk is also accepted.
          if (this.buffer.length === 0) this.state = 'done';
          return;
        }
        if (line === '') {
          this.state = 'done';
          continue;
        }
        const idx = line.indexOf(':');
        if (idx > 0) {
          const name = line.slice(0, idx).trim().toLowerCase();
          const value = line.slice(idx + 1).trim();
          if (name !== 'x-amz-trailer-signature') {
            this.trailers[name] = value;
          }
        }
      }
    }
  }
}

module.exports = { AwsChunkedDecoder };
