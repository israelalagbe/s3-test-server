'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectRetentionCommand,
  GetObjectRetentionCommand,
  PutObjectLegalHoldCommand,
  GetObjectLegalHoldCommand,
  GetObjectLockConfigurationCommand,
  PutObjectLockConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} = require('@aws-sdk/client-s3');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
let client;
const LOCKED = 'locked-bucket';

before(async () => {
  ctx = await startServer();
  client = new S3Client({
    endpoint: ctx.endpoint,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
  await client.send(
    new CreateBucketCommand({
      Bucket: LOCKED,
      ObjectLockEnabledForBucket: true,
    })
  );
});

after(async () => {
  client.destroy();
  await ctx.close();
});

test('object-lock-enabled buckets are versioned and expose their config', async () => {
  const lock = await client.send(
    new GetObjectLockConfigurationCommand({ Bucket: LOCKED })
  );
  assert.strictEqual(lock.ObjectLockConfiguration.ObjectLockEnabled, 'Enabled');
  const put = await client.send(
    new PutObjectCommand({ Bucket: LOCKED, Key: 'v.txt', Body: 'v' })
  );
  assert.ok(put.VersionId, 'versioning is pinned on');
});

test('retention blocks version deletes; governance can be bypassed', async () => {
  const until = new Date(Date.now() + 60 * 60 * 1000);
  const put = await client.send(
    new PutObjectCommand({
      Bucket: LOCKED,
      Key: 'held.txt',
      Body: 'protected',
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: until,
    })
  );
  const retention = await client.send(
    new GetObjectRetentionCommand({ Bucket: LOCKED, Key: 'held.txt' })
  );
  assert.strictEqual(retention.Retention.Mode, 'GOVERNANCE');

  await assert.rejects(
    client.send(
      new DeleteObjectCommand({
        Bucket: LOCKED,
        Key: 'held.txt',
        VersionId: put.VersionId,
      })
    ),
    (err) => err.name === 'AccessDenied'
  );

  // a plain delete (marker creation) is always allowed
  const marker = await client.send(
    new DeleteObjectCommand({ Bucket: LOCKED, Key: 'held.txt' })
  );
  assert.strictEqual(marker.DeleteMarker, true);

  // governance retention yields to the bypass header
  await client.send(
    new DeleteObjectCommand({
      Bucket: LOCKED,
      Key: 'held.txt',
      VersionId: put.VersionId,
      BypassGovernanceRetention: true,
    })
  );
});

test('legal hold blocks version deletes until released', async () => {
  const put = await client.send(
    new PutObjectCommand({
      Bucket: LOCKED,
      Key: 'legal.txt',
      Body: 'x',
      ObjectLockLegalHoldStatus: 'ON',
    })
  );
  const hold = await client.send(
    new GetObjectLegalHoldCommand({ Bucket: LOCKED, Key: 'legal.txt' })
  );
  assert.strictEqual(hold.LegalHold.Status, 'ON');

  await assert.rejects(
    client.send(
      new DeleteObjectCommand({
        Bucket: LOCKED,
        Key: 'legal.txt',
        VersionId: put.VersionId,
        BypassGovernanceRetention: true, // does not help against legal holds
      })
    ),
    (err) => err.name === 'AccessDenied'
  );

  await client.send(
    new PutObjectLegalHoldCommand({
      Bucket: LOCKED,
      Key: 'legal.txt',
      LegalHold: { Status: 'OFF' },
    })
  );
  await client.send(
    new DeleteObjectCommand({
      Bucket: LOCKED,
      Key: 'legal.txt',
      VersionId: put.VersionId,
    })
  );
});

test('a default retention rule applies to new objects', async () => {
  await client.send(
    new PutObjectLockConfigurationCommand({
      Bucket: LOCKED,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
      },
    })
  );
  await client.send(
    new PutObjectCommand({ Bucket: LOCKED, Key: 'defaulted.txt', Body: 'x' })
  );
  const retention = await client.send(
    new GetObjectRetentionCommand({ Bucket: LOCKED, Key: 'defaulted.txt' })
  );
  assert.strictEqual(retention.Retention.Mode, 'GOVERNANCE');
  assert.ok(new Date(retention.Retention.RetainUntilDate) > new Date());

  // retention can be extended through the API
  const extended = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  await client.send(
    new PutObjectRetentionCommand({
      Bucket: LOCKED,
      Key: 'defaulted.txt',
      Retention: { Mode: 'GOVERNANCE', RetainUntilDate: extended },
    })
  );
  const updated = await client.send(
    new GetObjectRetentionCommand({ Bucket: LOCKED, Key: 'defaulted.txt' })
  );
  assert.ok(
    Math.abs(new Date(updated.Retention.RetainUntilDate) - extended) < 2000
  );
});

test('lifecycle expiration removes objects on unversioned buckets', async () => {
  await client.send(new CreateBucketCommand({ Bucket: 'expiring' }));
  await client.send(
    new PutObjectCommand({ Bucket: 'expiring', Key: 'old/a.txt', Body: 'a' })
  );
  await client.send(
    new PutObjectCommand({ Bucket: 'expiring', Key: 'keep/b.txt', Body: 'b' })
  );
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: 'expiring',
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-old',
            Status: 'Enabled',
            Filter: { Prefix: 'old/' },
            // a date in the past expires matching objects immediately
            Expiration: { Date: new Date('2020-01-01T00:00:00Z') },
          },
        ],
      },
    })
  );
  const stored = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: 'expiring' })
  );
  assert.strictEqual(stored.Rules.length, 1);

  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: 'expiring' })
  );
  assert.deepStrictEqual(
    (listed.Contents || []).map((object) => object.Key),
    ['keep/b.txt']
  );
  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: 'expiring', Key: 'old/a.txt' })),
    (err) => err.name === 'NoSuchKey'
  );

  await client.send(new DeleteBucketLifecycleCommand({ Bucket: 'expiring' }));
  await assert.rejects(
    client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: 'expiring' })
    ),
    (err) => err.$metadata.httpStatusCode === 404
  );
});

test('lifecycle on versioned buckets: markers and noncurrent cleanup', async () => {
  await client.send(new CreateBucketCommand({ Bucket: 'tidy' }));
  await client.send(
    new (require('@aws-sdk/client-s3').PutBucketVersioningCommand)({
      Bucket: 'tidy',
      VersioningConfiguration: { Status: 'Enabled' },
    })
  );
  await client.send(
    new PutObjectCommand({ Bucket: 'tidy', Key: 'f.txt', Body: 'v1' })
  );
  await client.send(
    new PutObjectCommand({ Bucket: 'tidy', Key: 'f.txt', Body: 'v2' })
  );
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: 'tidy',
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'tidy-up',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Expiration: { Date: new Date('2020-01-01T00:00:00Z') },
            NoncurrentVersionExpiration: { NoncurrentDays: 0 },
          },
        ],
      },
    })
  );
  const versions = await client.send(
    new ListObjectVersionsCommand({ Bucket: 'tidy' })
  );
  // the expired current version got shadowed by a delete marker, and the
  // noncurrent v1 was removed permanently
  assert.strictEqual((versions.DeleteMarkers || []).length, 1);
  assert.strictEqual((versions.Versions || []).length, 1);
  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: 'tidy', Key: 'f.txt' })),
    (err) => err.name === 'NoSuchKey'
  );
});
