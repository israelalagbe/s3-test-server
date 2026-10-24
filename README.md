# AWS S3 Local Emulator Test Server

A lightweight Amazon S3 emulator for local development and testing.

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
  configureBuckets: [{ name: 'my-bucket' }],
});

const { endpoint } = await server.run(); // http://localhost:4568
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
  configureBuckets: [{ name: 'reports', acl: 'public-read' }],
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

## Options

All options are optional. `new S3TestServer()` starts an HTTP server on
`localhost:4568` backed by a temporary directory.

### Server

- `address` (string, default `'localhost'`): hostname or IP to bind to.
- `port` (number, default `4568`): port to listen on. Use `0` for an
  ephemeral port.
- `key`, `cert` (string | Buffer): TLS key and certificate. Provide both to
  serve HTTPS.
- `silent` (boolean, default `false`): suppress log output.

### Storage

- `directory` (string, default: a temporary directory): where buckets and
  objects are stored. Data persists across restarts.
- `resetOnStart` (boolean, default `false`): clear the data directory on
  every start, so a persistent `directory` begins empty.
- `resetOnClose` (boolean, default `false`): delete all bucket data when
  `close()` is called.
- `configureBuckets` (array, default `[]`): buckets to create at startup,
  each `{ name, configs }` with optional raw XML configs (CORS, website,
  tagging).

### Credentials and addressing

- `accessKeyId` (string, default `'S3TEST'`): access key clients must sign
  with.
- `secretAccessKey` (string, default `'S3TEST'`): matching secret key.
- `region` (string, default `'us-east-1'`): region reported in responses and
  event records. When set explicitly, the server behaves like a regional
  endpoint: SigV4 requests signed for another region are rejected
  (`AuthorizationHeaderMalformed`), as is a mismatched `LocationConstraint`
  on CreateBucket. When omitted, any region is accepted.
- `vhostBuckets` (boolean, default `true`): virtual-host-style addressing
  (`bucket.localhost`, `bucket.s3.<region>.amazonaws.com`).
- `serviceEndpoint` (string, default `'amazonaws.com'`): root domain
  recognized for virtual-host-style access.
- `allowMismatchedSignatures` (boolean, default `false`): accept well-formed
  but incorrect signatures.
- `defaultBucketAcl` (string, default `'private'`): ACL applied to buckets
  without an explicit one. See "Public and private buckets".

### All options at a glance

```js
const server = new S3TestServer({
  // server
  address: 'localhost', // hostname or IP the HTTP server binds to
  port: 4568, // port to listen on; 0 picks a free ephemeral port
  key: fs.readFileSync('./key.pem'), // TLS private key; with cert, serves HTTPS
  cert: fs.readFileSync('./cert.pem'), // TLS certificate for HTTPS
  silent: false, // true suppresses all request/startup logging

  // storage
  directory: './s3-data', // where buckets and objects live; omit for a temp dir
  resetOnStart: false, // true clears the data directory on every run()
  resetOnClose: false, // true deletes all bucket data on close()
  configureBuckets: [
    // buckets created before the server starts
    { name: 'assets', acl: 'public-read' }, // canned ACL for this bucket
    { name: 'site', configs: [corsXml, websiteXml, policyJson] }, // raw configs
  ],

  // credentials and addressing
  accessKeyId: 'S3TEST', // access key id requests must be signed with
  secretAccessKey: 'S3TEST', // matching secret for SigV2/SigV4 signatures
  region: 'eu-west-1', // pins the region: other regions are rejected
  defaultBucketAcl: 'private', // ACL for buckets created without one
  vhostBuckets: true, // resolve bucket.localhost-style Host headers
  serviceEndpoint: 'amazonaws.com', // root domain for virtual-host addressing
  allowMismatchedSignatures: false, // true accepts wrong (but well-formed) signatures
});
```

## Public and private buckets

Like real S3, buckets are private by default. Signed requests are verified
against `accessKeyId`/`secretAccessKey` and have full access. Anonymous
(unsigned) requests are checked against the bucket's canned ACL:

- `private` or `authenticated-read` (the default): all anonymous requests
  get `403 AccessDenied`.
- `public-read`: anonymous GET/HEAD only; anonymous writes get
  `403 AccessDenied`.
- `public-read-write`: anonymous reads and writes, like a fully public
  bucket. Set `defaultBucketAcl: 'public-read-write'` to restore the 1.x
  behavior where unsigned `fetch`/`curl` works everywhere.

Set a bucket's ACL any of the usual ways:

```js
// at startup
new S3TestServer({
  configureBuckets: [
    { name: 'assets', acl: 'public-read' },
    { name: 'internal' }, // private, the default
  ],
});
```

```js
// through the API
await client.send(
  new CreateBucketCommand({ Bucket: 'assets', ACL: 'public-read' })
);
await client.send(
  new PutBucketAclCommand({ Bucket: 'assets', ACL: 'private' })
);
```

`GetBucketAcl` reflects the canned ACL (an `AllUsers` grant appears for the
public ones). Object-level ACLs are accepted but not enforced.

### Per-prefix access with bucket policies

For finer control than canned ACLs, the server evaluates a subset of bucket
policies against anonymous requests: `Effect` Allow/Deny, `Principal` `"*"`,
`Action` wildcards (`s3:GetObject`, `s3:ListBucket`, `s3:PutObject`,
`s3:DeleteObject`, `s3:*`) and `Resource` ARNs with wildcards. Signed
requests always have full access; an explicit `Deny` only narrows anonymous
access. Set policies with `PutBucketPolicy`, or as a JSON document in
`configureBuckets` (detected by its leading `{`):

```js
// only keys under public/ are readable without signing
const policy = JSON.stringify({
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
new S3TestServer({ configureBuckets: [{ name: 'site', configs: [policy] }] });
```

Anonymous `GET /site/public/logo.png` then succeeds while
`GET /site/internal/report.csv` and all anonymous writes return
`403 AccessDenied`. `GetBucketPolicy` returns the stored document and
`DeleteBucketPolicy` removes it. `NotAction`, `NotResource`, `NotPrincipal`
and `Condition` are rejected as `NotImplemented` rather than silently
ignored.

## Supported operations

### Service and buckets

- ListBuckets, CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation
- ListObjects (v1), ListObjectsV2, ListObjectVersions (unversioned mapping)
- ListMultipartUploads
- Get/Put/DeleteBucketCors, Get/Put/DeleteBucketWebsite,
  Get/Put/DeleteBucketTagging
- GetBucketVersioning, GetBucketEncryption, GetBucketNotification,
  GetBucketRequestPayment, GetBucketLogging, GetBucketAccelerate
- Bucket ACLs (canned, enforced for anonymous requests)
- Bucket policies (anonymous-access subset): Get/Put/DeleteBucketPolicy

### Objects

- PutObject, GetObject, HeadObject, DeleteObject, DeleteObjects
- CopyObject with COPY/REPLACE directives and copy conditions
- POST form uploads: `multipart/form-data`, `${filename}` substitution,
  `success_action_*`
- Get/Put/DeleteObjectTagging, GetObjectAttributes, object ACLs (dummy)
- Range requests (`206 Partial Content`)
- Conditional reads: `If-Match`, `If-None-Match`, `If-(Un)Modified-Since`
- Conditional writes: `If-None-Match: *`, `If-Match`
- `response-*` header overrides on GET
- Integrity validation: `Content-MD5` and `x-amz-checksum-*`
  (CRC32, CRC32C, CRC64NVME, SHA1, SHA256), from headers or `aws-chunked`
  trailers

### Multipart uploads

- CreateMultipartUpload, UploadPart, UploadPartCopy (with
  `x-amz-copy-source-range`), CompleteMultipartUpload, AbortMultipartUpload,
  ListParts
- Correct multipart ETags (`md5-of-md5s-N`)
- Composite and full-object checksums

### Static website hosting

- Index and error documents, folder redirects
- `x-amz-website-redirect-location` and `RedirectAllRequestsTo`
- Served for anonymous GET/HEAD requests on buckets with a website
  configuration; make the bucket `public-read`, as on real S3

### CORS

- Preflight (`OPTIONS`) evaluation and response headers, driven by the
  bucket's CORS configuration

### Not implemented

- Bucket versioning (`PutBucketVersioning` with `Enabled` returns
  `NotImplemented`), object locking, lifecycle execution, bucket policies/IAM
- Per-chunk signatures inside `aws-chunked` bodies are not re-verified (the
  seed signature is)

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
