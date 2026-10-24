'use strict';

const { Transform } = require('stream');

const MAX_HEADER_LENGTH = 64 * 1024;

/**
 * Decodes the `aws-chunked` content encoding used by SigV4 streaming uploads:
 *
 *   <hex-size>[;chunk-signature=...]\r\n<data>\r\n ... 0[;chunk-signature=...]\r\n
 *   [trailer-name:value\r\n ...]\r\n
 *
 * Emits the raw payload bytes and collects any trailing checksum headers in
 * `this.trailers` (lowercased names), available once the stream ends.
 * Chunk signatures are not themselves verified; the seed signature in the
 * Authorization header has already been checked by then.
 */
class AwsChunkedDecoder extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.state = 'size';
    this.remaining = 0;
    this.trailers = {};
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this._consume();
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    if (this.state === 'data' || this.state === 'size' && this.buffer.length > 0) {
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
        const sizeToken = line.split(';')[0].trim();
        if (!/^[0-9a-fA-F]+$/.test(sizeToken)) {
          throw new Error(`Invalid aws-chunked size line: ${JSON.stringify(line)}`);
        }
        this.remaining = parseInt(sizeToken, 16);
        this.state = this.remaining === 0 ? 'trailer' : 'data';
      } else if (this.state === 'data') {
        if (this.buffer.length === 0) return;
        const take = Math.min(this.remaining, this.buffer.length);
        this.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.state = 'data-crlf';
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
