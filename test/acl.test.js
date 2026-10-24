'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  PutBucketAclCommand,
  GetBucketAclCommand,
} = require('@aws-sdk/client-s3');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
let client;

before(async () => {
  ctx = await startServer({
    configureBuckets: [
      { name: 'default-bucket' },
      { name: 'open-bucket', acl: 'public-read-write' },
      { name: 'readonly-bucket', acl: 'public-read' },
    ],
  });
  client = new S3Client({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
  for (const bucket of ['default-bucket', 'open-bucket', 'readonly-bucket']) {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: 'file.txt', Body: bucket })
    );
  }
});

after(async () => {
  client.destroy();
  await ctx.close();
});

test('buckets are private by default, like real S3', async () => {
  const got = await fetch(`${ctx.endpoint}/default-bucket/file.txt`);
  assert.strictEqual(got.status, 403);
  assert.match(await got.text(), /<Code>AccessDenied<\/Code>/);

  const put = await fetch(`${ctx.endpoint}/default-bucket/anon.txt`, {
    method: 'PUT',
    body: 'nope',
  });
  assert.strictEqual(put.status, 403);

  const list = await fetch(`${ctx.endpoint}/default-bucket/`);
  assert.strictEqual(list.status, 403);

  const signed = await client.send(
    new GetObjectCommand({ Bucket: 'default-bucket', Key: 'file.txt' })
  );
  assert.strictEqual(await signed.Body.transformToString(), 'default-bucket');
});

test('public-read-write buckets allow anonymous reads and writes', async () => {
  const put = await fetch(`${ctx.endpoint}/open-bucket/anon.txt`, {
    method: 'PUT',
    body: 'anonymous write',
  });
  assert.strictEqual(put.status, 200);
  const got = await fetch(`${ctx.endpoint}/open-bucket/anon.txt`);
  assert.strictEqual(await got.text(), 'anonymous write');
});

test('public-read buckets allow anonymous reads but reject writes', async () => {
  const got = await fetch(`${ctx.endpoint}/readonly-bucket/file.txt`);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(await got.text(), 'readonly-bucket');

  const put = await fetch(`${ctx.endpoint}/readonly-bucket/anon.txt`, {
    method: 'PUT',
    body: 'nope',
  });
  assert.strictEqual(put.status, 403);
  assert.match(await put.text(), /<Code>AccessDenied<\/Code>/);

  const del = await fetch(`${ctx.endpoint}/readonly-bucket/file.txt`, {
    method: 'DELETE',
  });
  assert.strictEqual(del.status, 403);
});

test('CreateBucket honors x-amz-acl and PutBucketAcl updates it', async () => {
  await client.send(
    new CreateBucketCommand({ Bucket: 'acl-flip', ACL: 'public-read' })
  );
  await client.send(
    new PutObjectCommand({ Bucket: 'acl-flip', Key: 'f', Body: 'x' })
  );
  assert.strictEqual((await fetch(`${ctx.endpoint}/acl-flip/f`)).status, 200);

  await client.send(
    new PutBucketAclCommand({ Bucket: 'acl-flip', ACL: 'private' })
  );
  assert.strictEqual((await fetch(`${ctx.endpoint}/acl-flip/f`)).status, 403);
});

test('GetBucketAcl reflects the canned ACL', async () => {
  const publicAcl = await client.send(
    new GetBucketAclCommand({ Bucket: 'readonly-bucket' })
  );
  const grants = publicAcl.Grants.map(
    (grant) => `${grant.Grantee.Type}:${grant.Permission}`
  );
  assert.ok(grants.includes('Group:READ'));

  const privateAcl = await client.send(
    new GetBucketAclCommand({ Bucket: 'default-bucket' })
  );
  assert.deepStrictEqual(
    privateAcl.Grants.map((grant) => grant.Permission),
    ['FULL_CONTROL']
  );
});

test('defaultBucketAcl can restore the fully public behavior', async () => {
  const open = await startServer({
    defaultBucketAcl: 'public-read-write',
    configureBuckets: [{ name: 'legacy' }],
  });
  try {
    const put = await fetch(`${open.endpoint}/legacy/anon.txt`, {
      method: 'PUT',
      body: 'old behavior',
    });
    assert.strictEqual(put.status, 200);
    const got = await fetch(`${open.endpoint}/legacy/anon.txt`);
    assert.strictEqual(await got.text(), 'old behavior');
  } finally {
    await open.close();
  }
});
