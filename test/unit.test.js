'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { checksumOf, DigestCalculator } = require('../lib/checksums');
const { parseXml, buildXml } = require('../lib/xml');
const { AwsChunkedDecoder } = require('../lib/chunked');

const CHECK = Buffer.from('123456789');

test('CRC32 matches the reference check value', () => {
  assert.strictEqual(checksumOf('CRC32', CHECK), Buffer.from('cbf43926', 'hex').toString('base64'));
});

test('CRC32C matches the reference check value', () => {
  assert.strictEqual(checksumOf('CRC32C', CHECK), Buffer.from('e3069283', 'hex').toString('base64'));
});

test('CRC64NVME matches the reference check value', () => {
  assert.strictEqual(
    checksumOf('CRC64NVME', CHECK),
    Buffer.from('ae8b14860a799888', 'hex').toString('base64')
  );
});

test('DigestCalculator computes md5/sha256 and size', () => {
  const calc = new DigestCalculator(['SHA1']);
  calc.update(Buffer.from('hello '));
  calc.update(Buffer.from('world'));
  const digests = calc.digest();
  assert.strictEqual(digests.size, 11);
  assert.strictEqual(digests.md5Hex, '5eb63bbbe01eeed093cb22bb8f5acdc3');
  assert.strictEqual(
    digests.sha256Hex,
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  );
  assert.ok(digests.checksums.SHA1);
});

test('XML parser handles nesting, repeats and entities', () => {
  const parsed = parseXml(
    '<?xml version="1.0"?><Delete><Quiet>true</Quiet>' +
      '<Object><Key>a&amp;b</Key></Object><Object><Key>c/d e</Key></Object></Delete>'
  );
  assert.strictEqual(parsed.Delete.Quiet, 'true');
  assert.deepStrictEqual(parsed.Delete.Object, [{ Key: 'a&b' }, { Key: 'c/d e' }]);
});

test('XML parser rejects malformed documents', () => {
  assert.throws(() => parseXml('<a><b></a>'));
});

test('XML builder escapes values and skips null fields', () => {
  const xml = buildXml('Root', { A: '<tag>', B: null, C: [1, 2] });
  assert.match(xml, /<A>&lt;tag&gt;<\/A>/);
  assert.doesNotMatch(xml, /<B>/);
  assert.match(xml, /<C>1<\/C><C>2<\/C>/);
});

test('AwsChunkedDecoder strips framing and captures trailers', async () => {
  const body = Buffer.from('hello world');
  const framed =
    body.length.toString(16) +
    ';chunk-signature=abc\r\n' +
    body.toString() +
    '\r\n0;chunk-signature=def\r\n' +
    'x-amz-checksum-crc32:tE5D3g==\r\n' +
    '\r\n';
  const decoder = new AwsChunkedDecoder();
  Readable.from([Buffer.from(framed)]).pipe(decoder);
  const chunks = [];
  for await (const chunk of decoder) chunks.push(chunk);
  assert.strictEqual(Buffer.concat(chunks).toString(), 'hello world');
  assert.strictEqual(decoder.trailers['x-amz-checksum-crc32'], 'tE5D3g==');
});

test('AwsChunkedDecoder handles unsigned trailer framing in small pieces', async () => {
  const framed = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
  const decoder = new AwsChunkedDecoder();
  (async () => {
    for (let i = 0; i < framed.length; i++) {
      decoder.write(framed.subarray(i, i + 1));
      await new Promise((resolve) => setImmediate(resolve));
    }
    decoder.end();
  })();
  const chunks = [];
  for await (const chunk of decoder) chunks.push(chunk);
  assert.strictEqual(Buffer.concat(chunks).toString(), 'hello world');
});
