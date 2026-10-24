'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const AWS = require('aws-sdk');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
const BUCKET = 'sdk-v2-bucket';

function makeClient(signatureVersion) {
  return new AWS.S3({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    accessKeyId: CREDENTIALS.accessKeyId,
    secretAccessKey: CREDENTIALS.secretAccessKey,
    s3ForcePathStyle: true,
    signatureVersion,
  });
}

before(async () => {
  ctx = await startServer();
  await makeClient('v4').createBucket({ Bucket: BUCKET }).promise();
});

after(async () => {
  await ctx.close();
});

test('aws-sdk v2 with SigV4: put, get, head, list v1', async () => {
  const client = makeClient('v4');
  const put = await client
    .putObject({
      Bucket: BUCKET,
      Key: 'v4/data.txt',
      Body: 'signed with sigv4',
      ContentType: 'text/plain',
      Metadata: { client: 'v2-sdk' },
    })
    .promise();
  assert.match(put.ETag, /^"[0-9a-f]{32}"$/);

  const got = await client
    .getObject({ Bucket: BUCKET, Key: 'v4/data.txt' })
    .promise();
  assert.strictEqual(got.Body.toString(), 'signed with sigv4');
  assert.strictEqual(got.ContentType, 'text/plain');
  assert.strictEqual(got.Metadata.client, 'v2-sdk');

  const head = await client
    .headObject({ Bucket: BUCKET, Key: 'v4/data.txt' })
    .promise();
  assert.strictEqual(head.ContentLength, 17);

  const list = await client
    .listObjects({ Bucket: BUCKET, Prefix: 'v4/', Delimiter: '/' })
    .promise();
  assert.deepStrictEqual(
    list.Contents.map((o) => o.Key),
    ['v4/data.txt']
  );
});

test('aws-sdk v2 with legacy SigV2 (signatureVersion "s3")', async () => {
  const client = makeClient('s3');
  await client
    .putObject({
      Bucket: BUCKET,
      Key: 'v2/data.txt',
      Body: 'signed with sigv2',
    })
    .promise();
  const got = await client
    .getObject({ Bucket: BUCKET, Key: 'v2/data.txt' })
    .promise();
  assert.strictEqual(got.Body.toString(), 'signed with sigv2');

  const list = await client
    .listObjects({ Bucket: BUCKET, Prefix: 'v2/' })
    .promise();
  assert.strictEqual(list.Contents.length, 1);

  await client.deleteObject({ Bucket: BUCKET, Key: 'v2/data.txt' }).promise();
});

test('aws-sdk v2 list v1 pagination with markers', async () => {
  const client = makeClient('v4');
  for (const key of ['page/a', 'page/b', 'page/c']) {
    await client.putObject({ Bucket: BUCKET, Key: key, Body: key }).promise();
  }
  const page1 = await client
    .listObjects({ Bucket: BUCKET, Prefix: 'page/', MaxKeys: 2 })
    .promise();
  assert.strictEqual(page1.Contents.length, 2);
  assert.ok(page1.IsTruncated);
  const page2 = await client
    .listObjects({
      Bucket: BUCKET,
      Prefix: 'page/',
      Marker: page1.Contents[page1.Contents.length - 1].Key,
    })
    .promise();
  assert.deepStrictEqual(
    page2.Contents.map((o) => o.Key),
    ['page/c']
  );
});

test('aws-sdk v2 presigned URLs (SigV4 and SigV2) work with fetch', async () => {
  for (const signatureVersion of ['v4', 's3']) {
    const client = makeClient(signatureVersion);
    const key = `presigned-${signatureVersion}.txt`;
    await client
      .putObject({
        Bucket: BUCKET,
        Key: key,
        Body: `presigned ${signatureVersion}`,
      })
      .promise();
    const url = client.getSignedUrl('getObject', {
      Bucket: BUCKET,
      Key: key,
      Expires: 300,
    });
    const res = await fetch(url);
    assert.strictEqual(
      res.status,
      200,
      `status for ${signatureVersion}: ${res.status}`
    );
    assert.strictEqual(await res.text(), `presigned ${signatureVersion}`);
  }
});

test('aws-sdk v2 multipart upload', async () => {
  const client = makeClient('v4');
  const part1 = Buffer.alloc(5 * 1024 * 1024, 'x');
  const part2 = Buffer.from('tail');
  const created = await client
    .createMultipartUpload({ Bucket: BUCKET, Key: 'v2-multi.bin' })
    .promise();
  const up1 = await client
    .uploadPart({
      Bucket: BUCKET,
      Key: 'v2-multi.bin',
      UploadId: created.UploadId,
      PartNumber: 1,
      Body: part1,
    })
    .promise();
  const up2 = await client
    .uploadPart({
      Bucket: BUCKET,
      Key: 'v2-multi.bin',
      UploadId: created.UploadId,
      PartNumber: 2,
      Body: part2,
    })
    .promise();
  const done = await client
    .completeMultipartUpload({
      Bucket: BUCKET,
      Key: 'v2-multi.bin',
      UploadId: created.UploadId,
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: up1.ETag },
          { PartNumber: 2, ETag: up2.ETag },
        ],
      },
    })
    .promise();
  assert.match(done.ETag, /-2"$/);
  const got = await client
    .getObject({ Bucket: BUCKET, Key: 'v2-multi.bin' })
    .promise();
  assert.strictEqual(got.Body.length, part1.length + part2.length);
});

test('wrong credentials are rejected', async () => {
  const bad = new AWS.S3({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    accessKeyId: CREDENTIALS.accessKeyId,
    secretAccessKey: 'wrong-secret',
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
  });
  await assert.rejects(
    bad.listObjects({ Bucket: BUCKET }).promise(),
    (err) => err.code === 'SignatureDoesNotMatch'
  );
  const badKey = new AWS.S3({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    accessKeyId: 'UNKNOWN',
    secretAccessKey: 'whatever',
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
  });
  await assert.rejects(
    badKey.listObjects({ Bucket: BUCKET }).promise(),
    (err) => err.code === 'InvalidAccessKeyId'
  );
});
