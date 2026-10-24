'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { startServer, CREDENTIALS } = require('./support');

function makeClient(endpoint, region) {
  return new S3Client({
    endpoint,
    region,
    credentials: CREDENTIALS,
    forcePathStyle: true,
  });
}

test('without a configured region, any client region is accepted', async () => {
  const ctx = await startServer();
  const clients = ['us-east-1', 'eu-west-1', 'ap-southeast-2'].map((region) =>
    makeClient(ctx.endpoint, region)
  );
  try {
    await clients[0].send(new CreateBucketCommand({ Bucket: 'any-region' }));
    for (const [index, client] of clients.entries()) {
      await client.send(
        new PutObjectCommand({
          Bucket: 'any-region',
          Key: `k${index}`,
          Body: 'x',
        })
      );
    }
  } finally {
    clients.forEach((client) => client.destroy());
    await ctx.close();
  }
});

test('with a configured region, mismatched signatures are rejected', async () => {
  const ctx = await startServer({
    region: 'eu-west-1',
    configureBuckets: [{ name: 'regional' }],
  });
  const matching = makeClient(ctx.endpoint, 'eu-west-1');
  const wrong = makeClient(ctx.endpoint, 'us-west-2');
  try {
    await matching.send(
      new PutObjectCommand({ Bucket: 'regional', Key: 'ok', Body: 'x' })
    );
    const got = await matching.send(
      new GetObjectCommand({ Bucket: 'regional', Key: 'ok' })
    );
    assert.strictEqual(await got.Body.transformToString(), 'x');

    await assert.rejects(
      wrong.send(new GetObjectCommand({ Bucket: 'regional', Key: 'ok' })),
      (err) =>
        err.name === 'AuthorizationHeaderMalformed' &&
        err.$metadata.httpStatusCode === 400
    );
  } finally {
    matching.destroy();
    wrong.destroy();
    await ctx.close();
  }
});

test('presigned URLs signed for the wrong region are rejected', async () => {
  const ctx = await startServer({
    region: 'eu-west-1',
    configureBuckets: [{ name: 'regional' }],
  });
  const matching = makeClient(ctx.endpoint, 'eu-west-1');
  const wrong = makeClient(ctx.endpoint, 'us-west-2');
  try {
    await matching.send(
      new PutObjectCommand({ Bucket: 'regional', Key: 'file', Body: 'data' })
    );

    const goodUrl = await getSignedUrl(
      matching,
      new GetObjectCommand({ Bucket: 'regional', Key: 'file' }),
      { expiresIn: 60 }
    );
    assert.strictEqual((await fetch(goodUrl)).status, 200);

    const badUrl = await getSignedUrl(
      wrong,
      new GetObjectCommand({ Bucket: 'regional', Key: 'file' }),
      { expiresIn: 60 }
    );
    const res = await fetch(badUrl);
    assert.strictEqual(res.status, 400);
    assert.match(await res.text(), /AuthorizationQueryParametersError/);
  } finally {
    matching.destroy();
    wrong.destroy();
    await ctx.close();
  }
});

test('CreateBucket with a mismatched LocationConstraint is rejected', async () => {
  const ctx = await startServer({ region: 'eu-west-1' });
  const client = makeClient(ctx.endpoint, 'eu-west-1');
  try {
    // the SDK derives the LocationConstraint from the client region, so a
    // matching client succeeds
    await client.send(new CreateBucketCommand({ Bucket: 'local-ok' }));
    await assert.rejects(
      client.send(
        new CreateBucketCommand({
          Bucket: 'elsewhere',
          CreateBucketConfiguration: { LocationConstraint: 'ap-south-1' },
        })
      ),
      (err) =>
        err.name === 'IllegalLocationConstraintException' &&
        err.$metadata.httpStatusCode === 400
    );
  } finally {
    client.destroy();
    await ctx.close();
  }
});

test('legacy SigV2 is unaffected by region pinning', async () => {
  const ctx = await startServer({
    region: 'eu-west-1',
    configureBuckets: [{ name: 'regional' }],
  });
  const AWS = require('aws-sdk');
  const client = new AWS.S3({
    endpoint: ctx.endpoint,
    region: 'eu-west-1',
    accessKeyId: CREDENTIALS.accessKeyId,
    secretAccessKey: CREDENTIALS.secretAccessKey,
    s3ForcePathStyle: true,
    signatureVersion: 's3', // SigV2 has no region in its signature
  });
  try {
    await client
      .putObject({ Bucket: 'regional', Key: 'v2', Body: 'v2' })
      .promise();
    const got = await client
      .getObject({ Bucket: 'regional', Key: 'v2' })
      .promise();
    assert.strictEqual(got.Body.toString(), 'v2');
  } finally {
    await ctx.close();
  }
});
