'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  GetBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
let client;
const BUCKET = 'versioned-bucket';

before(async () => {
  ctx = await startServer();
  client = new S3Client({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: BUCKET,
      VersioningConfiguration: { Status: 'Enabled' },
    })
  );
});

after(async () => {
  client.destroy();
  await ctx.close();
});

test('GetBucketVersioning reflects the enabled status', async () => {
  const result = await client.send(
    new GetBucketVersioningCommand({ Bucket: BUCKET })
  );
  assert.strictEqual(result.Status, 'Enabled');
});

test('overwrites keep earlier versions retrievable by versionId', async () => {
  const first = await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'doc.txt', Body: 'one' })
  );
  const second = await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'doc.txt', Body: 'two' })
  );
  assert.ok(first.VersionId && second.VersionId);
  assert.notStrictEqual(first.VersionId, second.VersionId);

  const latest = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'doc.txt' })
  );
  assert.strictEqual(await latest.Body.transformToString(), 'two');
  assert.strictEqual(latest.VersionId, second.VersionId);

  const old = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: 'doc.txt',
      VersionId: first.VersionId,
    })
  );
  assert.strictEqual(await old.Body.transformToString(), 'one');
});

test('delete creates a marker; removing the marker restores the object', async () => {
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'restore.txt',
      Body: 'keep me',
    })
  );
  const del = await client.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: 'restore.txt' })
  );
  assert.strictEqual(del.DeleteMarker, true);
  assert.ok(del.VersionId);

  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'restore.txt' })),
    (err) => err.name === 'NoSuchKey'
  );

  // the key no longer shows in a plain listing
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'restore' })
  );
  assert.strictEqual(listed.KeyCount, 0);

  // but the marker and the old version are in the version listing
  const versions = await client.send(
    new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: 'restore' })
  );
  assert.strictEqual(versions.DeleteMarkers.length, 1);
  assert.strictEqual(versions.DeleteMarkers[0].IsLatest, true);
  assert.strictEqual(versions.Versions.length, 1);

  // deleting the marker itself restores the object
  await client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: 'restore.txt',
      VersionId: del.VersionId,
    })
  );
  const restored = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'restore.txt' })
  );
  assert.strictEqual(await restored.Body.transformToString(), 'keep me');
});

test('deleting a specific version removes just that version', async () => {
  const v1 = await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'prune.txt', Body: 'v1' })
  );
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'prune.txt', Body: 'v2' })
  );
  await client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: 'prune.txt',
      VersionId: v1.VersionId,
    })
  );
  await assert.rejects(
    client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: 'prune.txt',
        VersionId: v1.VersionId,
      })
    ),
    (err) => err.$metadata.httpStatusCode === 404
  );
  const latest = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'prune.txt' })
  );
  assert.strictEqual(await latest.Body.transformToString(), 'v2');
});

test('CopyObject can restore an old version by versionId', async () => {
  const v1 = await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'copyback.txt', Body: 'old' })
  );
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'copyback.txt', Body: 'new' })
  );
  const copy = await client.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: 'copyback.txt',
      CopySource: `${BUCKET}/copyback.txt?versionId=${v1.VersionId}`,
      MetadataDirective: 'REPLACE',
    })
  );
  assert.strictEqual(copy.CopySourceVersionId, v1.VersionId);
  const latest = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'copyback.txt' })
  );
  assert.strictEqual(await latest.Body.transformToString(), 'old');
});

test('unversioned buckets still behave as before', async () => {
  await client.send(new CreateBucketCommand({ Bucket: 'plain-bucket' }));
  const put = await client.send(
    new PutObjectCommand({ Bucket: 'plain-bucket', Key: 'x', Body: '1' })
  );
  assert.strictEqual(put.VersionId, undefined);
  await client.send(
    new DeleteObjectCommand({ Bucket: 'plain-bucket', Key: 'x' })
  );
  const versions = await client.send(
    new ListObjectVersionsCommand({ Bucket: 'plain-bucket' })
  );
  assert.strictEqual(versions.Versions ?? undefined, undefined);
  assert.strictEqual(versions.DeleteMarkers ?? undefined, undefined);
});
