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
      { name: 'open-bucket' },
      { name: 'readonly-bucket', acl: 'public-read' },
      { name: 'private-bucket', acl: 'private' },
    ],
  });
  client = new S3Client({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
  for (const bucket of ['open-bucket', 'readonly-bucket', 'private-bucket']) {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: 'file.txt', Body: bucket })
    );
  }
});

after(async () => {
  client.destroy();
  await ctx.close();
});

test('default buckets allow anonymous reads and writes', async () => {
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

test('private buckets reject all anonymous requests but allow signed ones', async () => {
  const got = await fetch(`${ctx.endpoint}/private-bucket/file.txt`);
  assert.strictEqual(got.status, 403);
  assert.match(await got.text(), /<Code>AccessDenied<\/Code>/);

  const list = await fetch(`${ctx.endpoint}/private-bucket/`);
  assert.strictEqual(list.status, 403);

  const signed = await client.send(
    new GetObjectCommand({ Bucket: 'private-bucket', Key: 'file.txt' })
  );
  assert.strictEqual(await signed.Body.transformToString(), 'private-bucket');
});

test('CreateBucket honors x-amz-acl and PutBucketAcl updates it', async () => {
  await client.send(
    new CreateBucketCommand({ Bucket: 'acl-flip', ACL: 'private' })
  );
  await client.send(
    new PutObjectCommand({ Bucket: 'acl-flip', Key: 'f', Body: 'x' })
  );
  assert.strictEqual((await fetch(`${ctx.endpoint}/acl-flip/f`)).status, 403);

  await client.send(
    new PutBucketAclCommand({ Bucket: 'acl-flip', ACL: 'public-read' })
  );
  assert.strictEqual((await fetch(`${ctx.endpoint}/acl-flip/f`)).status, 200);
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
    new GetBucketAclCommand({ Bucket: 'private-bucket' })
  );
  assert.deepStrictEqual(
    privateAcl.Grants.map((grant) => grant.Permission),
    ['FULL_CONTROL']
  );
});

test('defaultBucketAcl: private makes the server S3-like by default', async () => {
  const strict = await startServer({
    defaultBucketAcl: 'private',
    configureBuckets: [{ name: 'locked' }],
  });
  try {
    const anon = await fetch(`${strict.endpoint}/locked/`);
    assert.strictEqual(anon.status, 403);
  } finally {
    await strict.close();
  }
});
