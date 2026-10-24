'use strict';

const crypto = require('crypto');

// CRC tables are built lazily. Implemented locally (rather than via
// zlib.crc32) so the package runs on all Node.js 20.x releases.

function makeCrc32Table(poly) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

let crc32Table;
let crc32cTable;
let crc64Table;

function makeCrc64Table(poly) {
  const table = new BigUint64Array(256);
  for (let n = 0n; n < 256n; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1n ? (c >> 1n) ^ poly : c >> 1n;
    }
    table[Number(n)] = c;
  }
  return table;
}

class Crc32 {
  constructor(castagnoli = false) {
    if (castagnoli) {
      crc32cTable = crc32cTable || makeCrc32Table(0x82f63b78);
      this.table = crc32cTable;
    } else {
      crc32Table = crc32Table || makeCrc32Table(0xedb88320);
      this.table = crc32Table;
    }
    this.crc = 0xffffffff;
  }

  update(buf) {
    let crc = this.crc;
    const table = this.table;
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    this.crc = crc >>> 0;
  }

  digest() {
    const out = Buffer.alloc(4);
    out.writeUInt32BE((this.crc ^ 0xffffffff) >>> 0);
    return out;
  }
}

// CRC-64/NVME: reflected polynomial of 0xAD93D23594C93659.
const CRC64_POLY = 0x9a6c9329ac4bc9b5n;
const CRC64_MASK = 0xffffffffffffffffn;

class Crc64Nvme {
  constructor() {
    crc64Table = crc64Table || makeCrc64Table(CRC64_POLY);
    this.crc = CRC64_MASK;
  }

  update(buf) {
    let crc = this.crc;
    const table = crc64Table;
    for (let i = 0; i < buf.length; i++) {
      crc = table[Number((crc ^ BigInt(buf[i])) & 0xffn)] ^ (crc >> 8n);
    }
    this.crc = crc;
  }

  digest() {
    const out = Buffer.alloc(8);
    out.writeBigUInt64BE((this.crc ^ CRC64_MASK) & CRC64_MASK);
    return out;
  }
}

class NodeHash {
  constructor(algorithm) {
    this.hash = crypto.createHash(algorithm);
  }

  update(buf) {
    this.hash.update(buf);
  }

  digest() {
    return this.hash.digest();
  }
}

const CHECKSUM_ALGORITHMS = ['CRC32', 'CRC32C', 'CRC64NVME', 'SHA1', 'SHA256'];

function createChecksummer(algorithm) {
  switch (algorithm) {
    case 'CRC32':
      return new Crc32(false);
    case 'CRC32C':
      return new Crc32(true);
    case 'CRC64NVME':
      return new Crc64Nvme();
    case 'SHA1':
      return new NodeHash('sha1');
    case 'SHA256':
      return new NodeHash('sha256');
    default:
      throw new Error(`Unsupported checksum algorithm: ${algorithm}`);
  }
}

/**
 * Computes MD5 + SHA256 (always) and any requested flexible checksums over a
 * stream of buffers.
 */
class DigestCalculator {
  constructor(algorithms = []) {
    this.md5 = crypto.createHash('md5');
    this.sha256 = crypto.createHash('sha256');
    this.size = 0;
    this.checksummers = {};
    for (const algorithm of algorithms) {
      if (!this.checksummers[algorithm]) {
        this.checksummers[algorithm] = createChecksummer(algorithm);
      }
    }
  }

  update(buf) {
    this.size += buf.length;
    this.md5.update(buf);
    this.sha256.update(buf);
    for (const checksummer of Object.values(this.checksummers)) {
      checksummer.update(buf);
    }
  }

  digest() {
    const md5 = this.md5.digest();
    const checksums = {};
    for (const [algorithm, checksummer] of Object.entries(this.checksummers)) {
      checksums[algorithm] = checksummer.digest().toString('base64');
    }
    return {
      size: this.size,
      md5Hex: md5.toString('hex'),
      md5Base64: md5.toString('base64'),
      sha256Hex: this.sha256.digest('hex'),
      checksums,
    };
  }
}

function checksumOf(algorithm, buf) {
  const checksummer = createChecksummer(algorithm);
  checksummer.update(buf);
  return checksummer.digest().toString('base64');
}

module.exports = {
  CHECKSUM_ALGORITHMS,
  DigestCalculator,
  createChecksummer,
  checksumOf,
};
