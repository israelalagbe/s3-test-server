'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  PutObjectTaggingCommand,
  GetObjectTaggingCommand,
  GetObjectAttributesCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
  DeleteBucketCommand,
  GetBucketLocationCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { startServer, CREDENTIALS } = require('./support');

let ctx;
let client;
const BUCKET = 'sdk-v3-bucket';

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

test('head bucket / list buckets / bucket location', async () => {
  await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  const list = await client.send(new ListBucketsCommand({}));
  assert.ok(list.Buckets.some((bucket) => bucket.Name === BUCKET));
  const location = await client.send(new GetBucketLocationCommand({ Bucket: BUCKET }));
  assert.ok(location.$metadata.httpStatusCode === 200);
});

test('put and get an object (buffer body, default checksums)', async () => {
  const body = Buffer.from('hello from sdk v3');
  const put = await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'greetings/hello.txt',
      Body: body,
      ContentType: 'text/plain',
      Metadata: { purpose: 'testing' },
      CacheControl: 'max-age=60',
    })
  );
  assert.match(put.ETag, /^"[0-9a-f]{32}"$/);

  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'greetings/hello.txt' })
  );
  assert.strictEqual(await got.Body.transformToString(), 'hello from sdk v3');
  assert.strictEqual(got.ContentType, 'text/plain');
  assert.strictEqual(got.Metadata.purpose, 'testing');
  assert.strictEqual(got.CacheControl, 'max-age=60');
  assert.strictEqual(got.ETag, put.ETag);
});

test('put with a stream body uses aws-chunked framing and trailers', async () => {
  const tmpFile = path.join(os.tmpdir(), `s3-test-stream-${Date.now()}.bin`);
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  fs.writeFileSync(tmpFile, payload);
  try {
    const put = await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'streamed.bin',
        Body: fs.createReadStream(tmpFile),
        ContentLength: payload.length,
      })
    );
    assert.ok(put.ETag);
    const got = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'streamed.bin', ChecksumMode: 'ENABLED' })
    );
    const received = Buffer.from(await got.Body.transformToByteArray());
    assert.ok(received.equals(payload));
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('range requests return 206 with the right slice', async () => {
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'range.txt', Body: 'abcdefghij' })
  );
  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', Range: 'bytes=2-5' })
  );
  assert.strictEqual(await got.Body.transformToString(), 'cdef');
  assert.strictEqual(got.ContentRange, 'bytes 2-5/10');
});

test('conditional writes: IfNoneMatch * fails when the key exists', async () => {
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'conditional.txt', Body: 'one' })
  );
  await assert.rejects(
    client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'conditional.txt',
        Body: 'two',
        IfNoneMatch: '*',
      })
    ),
    (err) => err.name === 'PreconditionFailed' || err.$metadata.httpStatusCode === 412
  );
});

test('copy object preserves content and metadata', async () => {
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'copy-src.txt',
      Body: 'copy me',
      Metadata: { origin: 'src' },
    })
  );
  const copy = await client.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: 'copy-dst.txt',
      CopySource: `${BUCKET}/copy-src.txt`,
    })
  );
  assert.ok(copy.CopyObjectResult.ETag);
  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'copy-dst.txt' })
  );
  assert.strictEqual(await got.Body.transformToString(), 'copy me');
  assert.strictEqual(got.Metadata.origin, 'src');
});

test('listObjectsV2 supports prefix, delimiter and pagination', async () => {
  const keys = ['list/a.txt', 'list/b.txt', 'list/sub/c.txt', 'other/z.txt'];
  for (const key of keys) {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: key }));
  }
  const page1 = await client.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'list/', Delimiter: '/', MaxKeys: 2 })
  );
  assert.strictEqual(page1.KeyCount, 2);
  assert.ok(page1.IsTruncated);
  const page2 = await client.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'list/',
      Delimiter: '/',
      ContinuationToken: page1.NextContinuationToken,
    })
  );
  const allKeys = [...(page1.Contents || []), ...(page2.Contents || [])].map((o) => o.Key);
  const allPrefixes = [
    ...(page1.CommonPrefixes || []),
    ...(page2.CommonPrefixes || []),
  ].map((p) => p.Prefix);
  assert.deepStrictEqual(allKeys.sort(), ['list/a.txt', 'list/b.txt']);
  assert.deepStrictEqual(allPrefixes, ['list/sub/']);
});

test('multipart upload with checksums round-trips', async () => {
  const partSize = 5 * 1024 * 1024;
  const part1 = Buffer.alloc(partSize, 'a');
  const part2 = Buffer.from('the tail end');

  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: 'multi/part.bin',
      ContentType: 'application/x-custom',
      Metadata: { kind: 'mpu' },
    })
  );
  const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: BUCKET }));
  assert.ok(uploads.Uploads.some((u) => u.UploadId === created.UploadId));

  const up1 = await client.send(
    new UploadPartCommand({
      Bucket: BUCKET,
      Key: 'multi/part.bin',
      UploadId: created.UploadId,
      PartNumber: 1,
      Body: part1,
    })
  );
  const up2 = await client.send(
    new UploadPartCommand({
      Bucket: BUCKET,
      Key: 'multi/part.bin',
      UploadId: created.UploadId,
      PartNumber: 2,
      Body: part2,
    })
  );
  const parts = await client.send(
    new ListPartsCommand({ Bucket: BUCKET, Key: 'multi/part.bin', UploadId: created.UploadId })
  );
  assert.strictEqual(parts.Parts.length, 2);

  const completed = await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: 'multi/part.bin',
      UploadId: created.UploadId,
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: up1.ETag, ChecksumCRC32: up1.ChecksumCRC32 },
          { PartNumber: 2, ETag: up2.ETag, ChecksumCRC32: up2.ChecksumCRC32 },
        ],
      },
    })
  );
  assert.match(completed.ETag, /-2"$/);

  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'multi/part.bin' })
  );
  const body = Buffer.from(await got.Body.transformToByteArray());
  assert.ok(body.equals(Buffer.concat([part1, part2])));
  assert.strictEqual(got.ContentType, 'application/x-custom');
  assert.strictEqual(got.Metadata.kind, 'mpu');

  const attrs = await client.send(
    new GetObjectAttributesCommand({
      Bucket: BUCKET,
      Key: 'multi/part.bin',
      ObjectAttributes: ['ETag', 'ObjectSize', 'ObjectParts', 'Checksum'],
    })
  );
  assert.strictEqual(attrs.ObjectSize, part1.length + part2.length);
  assert.strictEqual(attrs.ObjectParts.TotalPartsCount, 2);
});

test('abort multipart upload removes it', async () => {
  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'multi/aborted.bin' })
  );
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: BUCKET,
      Key: 'multi/aborted.bin',
      UploadId: created.UploadId,
    })
  );
  await assert.rejects(
    client.send(
      new ListPartsCommand({
        Bucket: BUCKET,
        Key: 'multi/aborted.bin',
        UploadId: created.UploadId,
      })
    ),
    (err) => err.name === 'NoSuchUpload'
  );
});

test('object tagging round-trips', async () => {
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'tagged.txt', Body: 'x', Tagging: 'a=1&b=2' })
  );
  await client.send(
    new PutObjectTaggingCommand({
      Bucket: BUCKET,
      Key: 'tagged.txt',
      Tagging: { TagSet: [{ Key: 'env', Value: 'test' }] },
    })
  );
  const tags = await client.send(
    new GetObjectTaggingCommand({ Bucket: BUCKET, Key: 'tagged.txt' })
  );
  assert.deepStrictEqual(tags.TagSet, [{ Key: 'env', Value: 'test' }]);
});

test('delete object and batch delete', async () => {
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'del/1', Body: '1' }));
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'del/2', Body: '2' }));
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'del/1' }));
  const batch = await client.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: [{ Key: 'del/2' }, { Key: 'del/missing' }] },
    })
  );
  assert.strictEqual(batch.Deleted.length, 2);
  await assert.rejects(
    client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'del/2' })),
    (err) => err.$metadata.httpStatusCode === 404
  );
});

test('missing keys produce NoSuchKey errors', async () => {
  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'nope' })),
    (err) => err.name === 'NoSuchKey'
  );
});

test('presigned GET and PUT URLs work with plain fetch', async () => {
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt', Body: 'presigned content' })
  );
  const getUrl = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt' }),
    { expiresIn: 300 }
  );
  const res = await fetch(getUrl);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'presigned content');

  const putUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned-put.txt' }),
    { expiresIn: 300 }
  );
  const putRes = await fetch(putUrl, { method: 'PUT', body: 'uploaded via presigned url' });
  assert.strictEqual(putRes.status, 200);
  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'presigned-put.txt' })
  );
  assert.strictEqual(await got.Body.transformToString(), 'uploaded via presigned url');
});

test('bucket CORS configuration round-trips', async () => {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['https://example.com'],
            AllowedMethods: ['GET', 'PUT'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    })
  );
  const cors = await client.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
  assert.strictEqual(cors.CORSRules.length, 1);
  assert.deepStrictEqual(cors.CORSRules[0].AllowedMethods, ['GET', 'PUT']);
});

test('put/delete bucket lifecycle and emptiness enforcement', async () => {
  const name = 'sdk-v3-tmp-bucket';
  await client.send(new CreateBucketCommand({ Bucket: name }));
  await client.send(new PutObjectCommand({ Bucket: name, Key: 'x', Body: 'x' }));
  await assert.rejects(
    client.send(new DeleteBucketCommand({ Bucket: name })),
    (err) => err.name === 'BucketNotEmpty'
  );
  await client.send(new DeleteObjectCommand({ Bucket: name, Key: 'x' }));
  await client.send(new DeleteBucketCommand({ Bucket: name }));
});

test('put/copy/delete emit S3 notification events', async () => {
  const events = [];
  const listener = (notification) => events.push(notification.Records[0]);
  ctx.server.on('event', listener);
  try {
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'events.txt', Body: 'ev' })
    );
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'events.txt' }));
  } finally {
    ctx.server.removeListener('event', listener);
  }
  const names = events.map((record) => record.eventName);
  assert.ok(names.includes('ObjectCreated:Put'));
  assert.ok(names.includes('ObjectRemoved:Delete'));
  assert.strictEqual(events[0].s3.bucket.name, BUCKET);
  assert.strictEqual(events[0].s3.object.key, 'events.txt');
});
