# AWS S3 Local Emulator Test Server

A lightweight Amazon S3 emulator for local development and testing.

Zero runtime dependencies and wire-level compatibility with old and new S3
clients: AWS SDK for JavaScript v3 (flexible checksums, `aws-chunked`
streaming, multipart), v2 (SigV4 and legacy SigV2), and any other client that
signs with Signature V2/V4, header-based or presigned, path-style or
virtual-host-style. Objects are stored on the filesystem and persist across
restarts when you point `directory` at a folder of your own.

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

### Running it as a standalone server

The package ships a CLI, so the emulator can run on its own, outside your
test process, and serve several apps at once. No install needed:

```bash
npx s3-test-server
```

That listens on `http://localhost:4568` with a temporary data directory and
the default `S3TEST`/`S3TEST` credentials. For a longer-lived setup, install
it (`npm install -g s3-test-server`, or as a dev dependency and run it from
`package.json` scripts) and give it persistent storage and buckets:

```bash
s3-test-server \
  --directory ./s3-data \
  --port 4568 \
  --configure-bucket uploads \
  --configure-bucket "site,./fixtures/cors.xml,./fixtures/website.xml,./fixtures/policy.json"
```

`--configure-bucket` takes a bucket name, optionally followed by
comma-separated paths to configuration documents (CORS, website or tagging
XML, or a bucket-policy JSON), and can be repeated. Other useful flags:

```bash
s3-test-server \
  --access-key-id dev --secret-access-key dev-secret \
  --region eu-west-1 \
  --default-bucket-acl public-read-write \
  --reset-on-start
```

pins credentials and a region (requests signed for other regions are
rejected), makes unconfigured buckets fully public so plain `curl` works,
and starts from an empty data directory on every launch. Add
`--key ./key.pem --cert ./cert.pem` to serve HTTPS, and `--silent` to turn
off request logging. `s3-test-server --help` lists everything.

Any S3 tooling can then talk to it, not just the SDKs. The AWS CLI:

```bash
AWS_ACCESS_KEY_ID=S3TEST AWS_SECRET_ACCESS_KEY=S3TEST \
  aws --endpoint-url http://localhost:4568 s3 mb s3://my-bucket
```

```bash
AWS_ACCESS_KEY_ID=S3TEST AWS_SECRET_ACCESS_KEY=S3TEST \
  aws --endpoint-url http://localhost:4568 s3 cp ./report.csv s3://my-bucket/
```

The process runs until you stop it; Ctrl-C (SIGINT) and SIGTERM shut it down
cleanly, and with `--reset-on-close` the data directory is emptied on the way
out. Data in `--directory` otherwise survives restarts, so a local dev server
keeps its objects between sessions.

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

```js
// bucket configuration documents used below
const corsXml = `<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://app.example.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
  </CORSRule>
</CORSConfiguration>`;

const websiteXml = `<WebsiteConfiguration>
  <IndexDocument><Suffix>index.html</Suffix></IndexDocument>
  <ErrorDocument><Key>error.html</Key></ErrorDocument>
</WebsiteConfiguration>`;

const policyJson = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: '*',
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::site/public/*', // anonymous reads under public/ only
    },
  ],
});

const server = new S3TestServer({
  // server
  address: 'localhost', // hostname or IP the HTTP server binds to (default)
  port: 4568, // listening port (default); 0 picks a free ephemeral port
  key: fs.readFileSync('./key.pem'), // TLS private key; give key AND cert to
  cert: fs.readFileSync('./cert.pem'), // serve HTTPS; omit both for HTTP (default)
  silent: false, // default; true suppresses request and startup logging

  // storage
  directory: './s3-data', // where buckets and objects are stored, persisted
  // across restarts; default: a fresh temporary directory per server
  resetOnStart: false, // default; true empties the directory on every run()
  resetOnClose: false, // default; true deletes all bucket data on close()
  configureBuckets: [
    // buckets created before the server starts; default: none
    { name: 'assets', acl: 'public-read' }, // canned ACL (default: defaultBucketAcl)
    { name: 'site', configs: [corsXml, websiteXml, policyJson] }, // raw CORS or
    // website XML documents and bucket-policy JSON, applied at startup
  ],

  // credentials and addressing
  accessKeyId: 'S3TEST', // access key id clients must sign with (default)
  secretAccessKey: 'S3TEST', // matching SigV2/SigV4 secret key (default)
  region: 'eu-west-1', // pinning a region rejects requests signed for others;
  // omit to accept any region (reported as us-east-1)
  defaultBucketAcl: 'private', // default, like real S3; ACL for buckets without
  // one: 'private', 'public-read' (anonymous GETs) or 'public-read-write'
  vhostBuckets: true, // default; resolve bucket.localhost and
  // bucket.s3.<region>.amazonaws.com style Host headers to the bucket
  serviceEndpoint: 'amazonaws.com', // default; root domain recognized for
  // virtual-host-style addressing
  allowMismatchedSignatures: false, // default; true accepts well-formed but
  // incorrect signatures (useful with exotic clients)
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

## Test helpers

Three helpers make assertions and fixtures easy without building an S3
client; they talk to the store directly:

```js
// seed fixtures (bucket is created if missing; no events are emitted)
await server.putObjects('reports', [
  { key: 'public/a.csv', body: 'a,b,c', contentType: 'text/csv' },
  { key: 'internal/b.csv', body: Buffer.from('d,e,f') },
]);

// inspect bucket contents in assertions
const all = await server.getObjects('reports');
const csvs = await server.getObjects('reports', {
  prefix: 'public/',
  bodies: true, // each summary gets a `body` Buffer
});

// wait for background uploads from the code under test;
// multipart uploads only count once completed
const files = await server.waitForObjects('reports', 2, { timeout: 5000 });
```

After `run()` resolves, `server.hostPort` (`"localhost:4568"`) and
`server.endpoint` (`"http://localhost:4568"`) are also set on the instance.

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
- `getObjects(bucket, { prefix, bodies })` lists completed objects
- `waitForObjects(bucket, count, { prefix, timeout })` awaits uploads
- `putObjects(bucket, objects)` seeds fixtures without the HTTP API

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
