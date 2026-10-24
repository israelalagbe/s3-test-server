'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  DeleteBucketPolicyCommand,
} = require('@aws-sdk/client-s3');
const { startServer, CREDENTIALS } = require('./support');

const PUBLIC_PREFIX_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: '*',
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::site/public/*',
    },
  ],
});

let ctx;
let client;

before(async () => {
  ctx = await startServer({
    configureBuckets: [{ name: 'site', configs: [PUBLIC_PREFIX_POLICY] }],
  });
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

test('anonymous GETs succeed only under public/', async () => {
  await client.send(
    new PutObjectCommand({
      Bucket: 'site',
      Key: 'public/logo.txt',
      Body: 'logo',
    })
  );
  await client.send(
    new PutObjectCommand({
      Bucket: 'site',
      Key: 'internal/report.txt',
      Body: 'secret',
    })
  );

  const publicGet = await fetch(`${ctx.endpoint}/site/public/logo.txt`);
  assert.strictEqual(publicGet.status, 200);
  assert.strictEqual(await publicGet.text(), 'logo');

  const internalGet = await fetch(`${ctx.endpoint}/site/internal/report.txt`);
  assert.strictEqual(internalGet.status, 403);
  assert.match(await internalGet.text(), /<Code>AccessDenied<\/Code>/);

  // the policy grants GetObject only: anonymous writes and listings stay 403
  const anonPut = await fetch(`${ctx.endpoint}/site/public/evil.txt`, {
    method: 'PUT',
    body: 'nope',
  });
  assert.strictEqual(anonPut.status, 403);
  const anonList = await fetch(`${ctx.endpoint}/site/?list-type=2`);
  assert.strictEqual(anonList.status, 403);
});

test('rewriting a key outside public/ makes the anonymous GET 403', async () => {
  await client.send(
    new PutObjectCommand({
      Bucket: 'site',
      Key: 'public/file.txt',
      Body: 'data',
    })
  );
  assert.strictEqual(
    (await fetch(`${ctx.endpoint}/site/public/file.txt`)).status,
    200
  );

  // "rewrite" the key out of the public prefix: copy, then delete the original
  await client.send(
    new CopyObjectCommand({
      Bucket: 'site',
      Key: 'archive/file.txt',
      CopySource: 'site/public/file.txt',
    })
  );
  await client.send(
    new DeleteObjectCommand({ Bucket: 'site', Key: 'public/file.txt' })
  );

  const moved = await fetch(`${ctx.endpoint}/site/archive/file.txt`);
  assert.strictEqual(moved.status, 403);
  assert.match(await moved.text(), /<Code>AccessDenied<\/Code>/);
  // the old public URL no longer serves anything either
  assert.notStrictEqual(
    (await fetch(`${ctx.endpoint}/site/public/file.txt`)).status,
    200
  );
});

test('Deny statements narrow anonymous access', async () => {
  await client.send(new CreateBucketCommand({ Bucket: 'mostly-open' }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: 'mostly-open',
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: 'arn:aws:s3:::mostly-open/*',
          },
          {
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: 'arn:aws:s3:::mostly-open/secret/*',
          },
        ],
      }),
    })
  );
  await client.send(
    new PutObjectCommand({ Bucket: 'mostly-open', Key: 'open.txt', Body: 'ok' })
  );
  await client.send(
    new PutObjectCommand({
      Bucket: 'mostly-open',
      Key: 'secret/hidden.txt',
      Body: 'no',
    })
  );
  assert.strictEqual(
    (await fetch(`${ctx.endpoint}/mostly-open/open.txt`)).status,
    200
  );
  assert.strictEqual(
    (await fetch(`${ctx.endpoint}/mostly-open/secret/hidden.txt`)).status,
    403
  );
});

test('Get/Put/DeleteBucketPolicy round-trip', async () => {
  const stored = await client.send(
    new GetBucketPolicyCommand({ Bucket: 'site' })
  );
  assert.deepStrictEqual(
    JSON.parse(stored.Policy),
    JSON.parse(PUBLIC_PREFIX_POLICY)
  );

  await client.send(new DeleteBucketPolicyCommand({ Bucket: 'site' }));
  await assert.rejects(
    client.send(new GetBucketPolicyCommand({ Bucket: 'site' })),
    (err) => err.$metadata.httpStatusCode === 404
  );
  // restore for any later assertions
  await client.send(
    new PutBucketPolicyCommand({ Bucket: 'site', Policy: PUBLIC_PREFIX_POLICY })
  );
});

test('malformed and unsupported policies are rejected', async () => {
  await assert.rejects(
    client.send(
      new PutBucketPolicyCommand({ Bucket: 'site', Policy: 'not json' })
    ),
    (err) => err.$metadata.httpStatusCode === 400
  );
  await assert.rejects(
    client.send(
      new PutBucketPolicyCommand({
        Bucket: 'site',
        Policy: JSON.stringify({
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Action: 's3:GetObject',
              Resource: 'arn:aws:s3:::site/*',
              Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } },
            },
          ],
        }),
      })
    ),
    (err) => err.name === 'NotImplemented'
  );
});
