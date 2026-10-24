'use strict';

/**
 * Minimal end-to-end example:
 *
 *   node example/index.js
 *
 * Starts the emulator, drives it with the AWS SDK v3, then reads an object
 * back anonymously over plain HTTP.
 */

const S3TestServer = require('..');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

async function main() {
  const server = new S3TestServer({
    port: 0, // ephemeral port
    // public-read lets the unsigned fetch below work; buckets are
    // private by default, like real S3
    configureBuckets: [{ name: 'example-bucket', acl: 'public-read' }],
  });
  server.on('event', ({ Records: [record] }) => {
    console.log(`event: ${record.eventName} ${record.s3.object.key}`);
  });

  const { endpoint } = await server.run();
  console.log(`emulator running at ${endpoint}`);

  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'S3TEST', secretAccessKey: 'S3TEST' },
    forcePathStyle: true,
  });

  await client.send(
    new PutObjectCommand({
      Bucket: 'example-bucket',
      Key: 'notes/hello.txt',
      Body: 'hello from the example',
      ContentType: 'text/plain',
    })
  );

  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: 'example-bucket' })
  );
  console.log(
    'keys:',
    listed.Contents.map((object) => object.Key)
  );

  const got = await client.send(
    new GetObjectCommand({ Bucket: 'example-bucket', Key: 'notes/hello.txt' })
  );
  console.log('via SDK:', await got.Body.transformToString());

  // Unsigned reads work on public-read buckets.
  const res = await fetch(`${endpoint}/example-bucket/notes/hello.txt`);
  console.log('via fetch:', await res.text());

  client.destroy();
  await server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
