'use strict';

// Compatibility checks with higher-level tooling from aws/aws-sdk-js-v3:
// the managed multipart uploader (@aws-sdk/lib-storage) and paginators.

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const { Readable } = require('node:stream');
const {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
let client;
const BUCKET = 'compat-bucket';

before(async () => {
  ctx = await startServer();
  client = new S3Client({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
});

after(async () => {
  client.destroy();
  await ctx.close();
});

test('lib-storage Upload streams a large body via managed multipart', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const totalChunks = 12; // 12 MiB → multiple 5 MiB parts
  const body = Readable.from(
    (async function* () {
      for (let i = 0; i < totalChunks; i++) yield chunk;
    })()
  );
  const upload = new Upload({
    client,
    params: {
      Bucket: BUCKET,
      Key: 'lib-storage/big.bin',
      Body: body,
      ContentType: 'application/octet-stream',
    },
    partSize: 5 * 1024 * 1024,
    queueSize: 2,
  });
  const progress = [];
  upload.on('httpUploadProgress', (event) => progress.push(event.loaded));
  const result = await upload.done();
  assert.strictEqual(result.Bucket, BUCKET);
  assert.strictEqual(result.Key, 'lib-storage/big.bin');
  assert.ok(result.ETag);
  assert.ok(progress.length > 0);

  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'lib-storage/big.bin' })
  );
  assert.strictEqual(got.ContentLength, chunk.length * totalChunks);
  const received = Buffer.from(await got.Body.transformToByteArray());
  assert.ok(received.equals(Buffer.concat(new Array(totalChunks).fill(chunk))));
});

test('lib-storage Upload falls back to a single PUT for small bodies', async () => {
  const upload = new Upload({
    client,
    params: {
      Bucket: BUCKET,
      Key: 'lib-storage/small.txt',
      Body: 'tiny payload',
    },
  });
  await upload.done();
  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'lib-storage/small.txt' })
  );
  assert.strictEqual(await got.Body.transformToString(), 'tiny payload');
});

test('paginateListObjectsV2 walks all pages', async () => {
  for (let i = 0; i < 7; i++) {
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `paginate/key-${String(i).padStart(2, '0')}`,
        Body: `${i}`,
      })
    );
  }
  const keys = [];
  const paginator = paginateListObjectsV2(
    { client, pageSize: 3 },
    { Bucket: BUCKET, Prefix: 'paginate/' }
  );
  let pages = 0;
  for await (const page of paginator) {
    pages += 1;
    for (const item of page.Contents || []) keys.push(item.Key);
  }
  assert.strictEqual(pages, 3);
  assert.strictEqual(keys.length, 7);
  assert.deepStrictEqual(keys, [...keys].sort());
});
