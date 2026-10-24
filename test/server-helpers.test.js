'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
let client;

before(async () => {
  ctx = await startServer();
  client = new S3Client({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
});

after(async () => {
  client.destroy();
  await ctx.close();
});

test('hostPort and endpoint are set on the instance after run()', () => {
  assert.strictEqual(ctx.server.hostPort, `localhost:${ctx.port}`);
  assert.strictEqual(ctx.server.endpoint, `http://localhost:${ctx.port}`);
});

test('putObjects seeds fixtures and getObjects reads them back', async () => {
  const seeded = await ctx.server.putObjects('fixtures', [
    { key: 'public/a.csv', body: 'a,b,c', contentType: 'text/csv' },
    { key: 'internal/b.bin', body: Buffer.from([1, 2, 3]) },
    { key: 'public/c.txt', body: 'c', metadata: { origin: 'seed' } },
  ]);
  assert.strictEqual(seeded.length, 3);

  const all = await ctx.server.getObjects('fixtures');
  assert.deepStrictEqual(
    all.map((object) => object.key),
    ['internal/b.bin', 'public/a.csv', 'public/c.txt']
  );
  assert.ok(all[0].lastModified instanceof Date);

  const publicOnly = await ctx.server.getObjects('fixtures', {
    prefix: 'public/',
    bodies: true,
  });
  assert.deepStrictEqual(
    publicOnly.map((object) => object.key),
    ['public/a.csv', 'public/c.txt']
  );
  assert.strictEqual(publicOnly[0].body.toString(), 'a,b,c');
  assert.strictEqual(publicOnly[0].contentType, 'text/csv');
  assert.strictEqual(publicOnly[1].metadata.origin, 'seed');

  // seeded objects are served over the API like any other
  const got = await fetch(`${ctx.endpoint}/fixtures/public/a.csv`, {
    headers: {},
  });
  // default ACL is private, so read it signed instead
  assert.strictEqual(got.status, 403);
});

test('getObjects rejects for a missing bucket', async () => {
  await assert.rejects(
    ctx.server.getObjects('no-such-bucket'),
    (err) => err.code === 'NoSuchBucket'
  );
});

test('waitForObjects resolves when background uploads finish', async () => {
  const waiter = ctx.server.waitForObjects('background', 2, { timeout: 5000 });
  setTimeout(async () => {
    await ctx.server.putObjects('background', [{ key: 'one', body: '1' }]);
    await client.send(
      new PutObjectCommand({ Bucket: 'background', Key: 'two', Body: '2' })
    );
  }, 100);
  const objects = await waiter;
  assert.deepStrictEqual(objects.map((object) => object.key).sort(), [
    'one',
    'two',
  ]);
});

test('waitForObjects only counts completed multipart uploads', async () => {
  await ctx.server.putObjects('multi-wait', []);
  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: 'multi-wait', Key: 'big.bin' })
  );
  const part = await client.send(
    new UploadPartCommand({
      Bucket: 'multi-wait',
      Key: 'big.bin',
      UploadId: created.UploadId,
      PartNumber: 1,
      Body: Buffer.alloc(1024, 1),
    })
  );
  // the pending part must not satisfy the waiter
  await assert.rejects(
    ctx.server.waitForObjects('multi-wait', 1, { timeout: 600 }),
    /Timed out/
  );
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: 'multi-wait',
      Key: 'big.bin',
      UploadId: created.UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
    })
  );
  const objects = await ctx.server.waitForObjects('multi-wait', 1, {
    timeout: 5000,
  });
  assert.deepStrictEqual(
    objects.map((object) => object.key),
    ['big.bin']
  );
});

test('waitForObjects respects the prefix filter and times out', async () => {
  await ctx.server.putObjects('prefixed', [{ key: 'other/x', body: 'x' }]);
  await assert.rejects(
    ctx.server.waitForObjects('prefixed', 1, {
      prefix: 'wanted/',
      timeout: 400,
    }),
    /Timed out after 400ms/
  );
});
