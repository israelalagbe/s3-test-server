# s3-test-server

A modern, lightweight Amazon S3 emulator for local development and testing.

## Why not just mock?

Mocking the S3 client tests your assumptions about S3, not S3 itself. Stubs
skip request signing, checksum validation, multipart ETag rules, pagination
contracts and error shapes, so code that passes mocked tests can still break
against the real service, and every SDK upgrade silently invalidates the
stubs.

Before, with a mocked client, nothing below the stub actually runs:

```js
jest.mock('@aws-sdk/client-s3');
S3Client.prototype.send = jest.fn().mockResolvedValue({ ETag: '"abc123"' });

test('uploads a report', async () => {
  await uploadReport('march.csv', csv);
  expect(S3Client.prototype.send).toHaveBeenCalled(); // proves nothing about S3
});
```

After, the same test against `s3-test-server`. Your production code runs
unmodified and every byte goes over HTTP (`aws-s3.local` is any hostname you
map to 127.0.0.1):

```js
const server = new S3TestServer({
  address: 'aws-s3.local',
  configureBuckets: [{ name: 'reports' }],
});

beforeAll(() => server.run()); // http://aws-s3.local:4568
afterAll(() => server.close());

test('uploads a report and returns its URL', async () => {
  const url = await uploadReport('march.csv', csv); // real code, real wire

  // the full object URL is real, not invented by a stub
  expect(url).toBe('http://aws-s3.local:4568/reports/march.csv');

  // and it resolves: read the object back like any HTTP resource
  const saved = await fetch(url);
  expect(await saved.text()).toBe(csv.toString());
});
```

If `uploadReport` signs incorrectly, streams a corrupt body or mishandles
multipart thresholds, this test fails, exactly as it would against AWS.

Zero runtime dependencies, a single small package, and wire-level
compatibility with both old and new S3 clients:

- **AWS SDK for JavaScript v3**, including flexible checksums
  (CRC32, CRC32C, CRC64NVME, SHA1, SHA256), `aws-chunked` streaming uploads
  with trailers, and full-object / composite multipart checksums
- **AWS SDK for JavaScript v2**, SigV4 and legacy SigV2 (`signatureVersion: 's3'`)
- **Any other S3 client** that signs with Signature V2 or V4, header-based or
  presigned, path-style or virtual-host-style

Data is stored on the filesystem (a temp directory by default), so it survives
restarts when you point it at a directory of your own.

## Quick start

```bash
npm install --save-dev s3-test-server
```

```js
const S3TestServer = require('s3-test-server');

const server = new S3TestServer({
  port: 4568,
  directory: './s3-data',           // omit for a temp directory
  configureBuckets: [{ name: 'my-bucket' }],
});

const { endpoint } = await server.run();   // http://localhost:4568
// ... run your tests ...
await server.close();
```

Point any S3 client at it:

```js
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: 'http://localhost:4568',
  region: 'us-east-1',
  credentials: { accessKeyId: 'S3TEST', secretAccessKey: 'S3TEST' },
  forcePathStyle: true,
});
```

Or from the command line:

```bash
npx s3-test-server -d ./s3-data -p 4568 --configure-bucket my-bucket
```

Run `s3-test-server --help` for all flags.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `address` | `'localhost'` | Hostname or IP to bind to |
| `port` | `4568` | Port (use `0` for an ephemeral port) |
| `directory` | temp dir | Where buckets and objects are stored |
| `accessKeyId` | `'S3TEST'` | Access key clients must sign with |
| `secretAccessKey` | `'S3TEST'` | Matching secret key |
| `region` | `'us-east-1'` | Region reported in responses and events |
| `key`, `cert` | none | Provide both to serve HTTPS |
| `silent` | `false` | Suppress log output |
| `resetOnClose` | `false` | Delete all bucket data on `close()` |
| `allowMismatchedSignatures` | `false` | Accept well-formed but wrong signatures |
| `vhostBuckets` | `true` | Virtual-host-style addressing (`bucket.localhost`, `bucket.s3.<region>.amazonaws.com`) |
| `serviceEndpoint` | `'amazonaws.com'` | Root domain for virtual-host-style access |
| `configureBuckets` | `[]` | Buckets (plus raw XML CORS/website/tagging configs) created at startup |

Anonymous (unsigned) requests are accepted, as on a public bucket, which is
handy for plain `fetch`/`curl` in tests. Signed requests are verified against
`accessKeyId`/`secretAccessKey`.

## Supported operations

**Service / buckets**: ListBuckets, Create/Delete/HeadBucket,
GetBucketLocation, ListObjects (v1), ListObjectsV2, ListObjectVersions
(unversioned mapping), Get/Put/DeleteBucketCors, Get/Put/DeleteBucketWebsite,
Get/Put/DeleteBucketTagging, GetBucketVersioning, GetBucketEncryption,
GetBucketNotification/RequestPayment/Logging/Accelerate, ACLs (dummy),
ListMultipartUploads.

**Objects**: Put/Get/Head/DeleteObject, DeleteObjects, CopyObject
(COPY/REPLACE directives, copy conditions), POST form uploads
(`multipart/form-data`, `${filename}` substitution, `success_action_*`),
Get/Put/DeleteObjectTagging, GetObjectAttributes, object ACLs (dummy),
Range requests, conditional reads (`If-Match`, `If-None-Match`,
`If-(Un)Modified-Since`) and **conditional writes** (`If-None-Match: *`,
`If-Match`), `response-*` header overrides, `Content-MD5` and
`x-amz-checksum-*` validation (headers or `aws-chunked` trailers).

**Multipart**: Create/Abort/CompleteMultipartUpload, UploadPart,
UploadPartCopy (with `x-amz-copy-source-range`), ListParts, correct
multipart ETags (`md5-of-md5s-N`), composite and full-object checksums.

**Static website hosting**: index/error documents, folder redirects,
`x-amz-website-redirect-location`, `RedirectAllRequestsTo`; served for
anonymous GET/HEAD requests on buckets with a website configuration.

**CORS**: preflight (`OPTIONS`) evaluation and response headers, driven by
the bucket's CORS configuration.

Not implemented: bucket versioning (`PutBucketVersioning` with `Enabled`
returns `NotImplemented`), object locking, lifecycle execution, bucket
policies/IAM. Per-chunk signatures inside `aws-chunked` bodies are not
re-verified (the seed signature is).

## Events

The server is an `EventEmitter` and emits S3-style notifications:

```js
server.on('event', (notification) => {
  const [record] = notification.Records;
  console.log(record.eventName, record.s3.object.key);
});
```

Emitted for `ObjectCreated:Put`, `ObjectCreated:Copy`, `ObjectCreated:Post`,
`ObjectCreated:CompleteMultipartUpload` and `ObjectRemoved:Delete`.

## Using as middleware

```js
const http = require('http');
const S3TestServer = require('s3-test-server');

const s3 = new S3TestServer({ silent: true });
http.createServer(s3.callback()).listen(4568);
// also works as an Express/Connect handler
```

## Programmatic API

- `run([callback])` returns `Promise<{ address, port, protocol, endpoint }>`
- `close([callback])` returns `Promise<void>`
- `callback()` / `getMiddleware()` returns a request handler
- `configureBuckets()` provisions `options.configureBuckets` without the API
- `reset()` deletes all buckets and configurations

TypeScript definitions ship with the package (`lib/index.d.ts`).

## HTTPS

```js
const fs = require('fs');
const server = new S3TestServer({
  key: fs.readFileSync('./key.pem'),
  cert: fs.readFileSync('./cert.pem'),
});
```

With a self-signed certificate, configure your client to accept it (for the
AWS SDKs, a custom HTTPS agent with `rejectUnauthorized: false`).

## Requirements

Node.js >= 20.

## License

MIT
