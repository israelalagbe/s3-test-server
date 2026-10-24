'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const http = require('node:http');
const { startServer } = require('./support');

let ctx;
const BUCKET = 'raw-bucket';

const CORS_XML = `<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://allowed.example</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>1200</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

const WEBSITE_XML = `<WebsiteConfiguration>
  <IndexDocument><Suffix>index.html</Suffix></IndexDocument>
  <ErrorDocument><Key>error.html</Key></ErrorDocument>
</WebsiteConfiguration>`;

before(async () => {
  ctx = await startServer({
    configureBuckets: [{ name: BUCKET, configs: [CORS_XML, WEBSITE_XML] }],
  });
});

after(async () => {
  await ctx.close();
});

function rawRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: ctx.port, ...options },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('anonymous PUT/GET round-trip and error XML shape', async () => {
  const put = await fetch(`${ctx.endpoint}/${BUCKET}/index.html`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html' },
    body: '<h1>home</h1>',
  });
  assert.strictEqual(put.status, 200);
  await fetch(`${ctx.endpoint}/${BUCKET}/error.html`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html' },
    body: '<h1>custom error page</h1>',
  });

  const missing = await fetch(`${ctx.endpoint}/${BUCKET}/nope.txt?tagging`);
  assert.strictEqual(missing.status, 404);
  const xml = await missing.text();
  assert.match(xml, /<Code>NoSuchKey<\/Code>/);
  assert.match(xml, /<RequestId>[0-9A-F]+<\/RequestId>/);
  assert.ok(missing.headers.get('x-amz-request-id'));
});

test('website mode serves the index and error documents anonymously', async () => {
  const index = await fetch(`${ctx.endpoint}/${BUCKET}/`);
  assert.strictEqual(index.status, 200);
  assert.strictEqual(await index.text(), '<h1>home</h1>');
  assert.match(index.headers.get('content-type'), /text\/html/);

  const missing = await fetch(`${ctx.endpoint}/${BUCKET}/does-not-exist.html`);
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(await missing.text(), '<h1>custom error page</h1>');
});

test('CORS preflight honors the bucket configuration', async () => {
  const allowed = await rawRequest({
    method: 'OPTIONS',
    path: `/${BUCKET}/index.html`,
    headers: {
      Origin: 'https://allowed.example',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(
    allowed.headers['access-control-allow-origin'],
    'https://allowed.example'
  );
  assert.match(allowed.headers['access-control-allow-methods'], /PUT/);
  assert.strictEqual(allowed.headers['access-control-max-age'], '1200');

  const denied = await rawRequest({
    method: 'OPTIONS',
    path: `/${BUCKET}/index.html`,
    headers: {
      Origin: 'https://denied.example',
      'Access-Control-Request-Method': 'DELETE',
    },
  });
  assert.strictEqual(denied.status, 403);
});

test('simple CORS headers are set on matching GET requests', async () => {
  const res = await rawRequest({
    method: 'GET',
    path: `/${BUCKET}/index.html?list-type-not-api`,
    headers: { Origin: 'https://allowed.example' },
  });
  assert.strictEqual(
    res.headers['access-control-allow-origin'],
    'https://allowed.example'
  );
  assert.match(res.headers['access-control-expose-headers'], /ETag/);
});

test('virtual-host-style addressing resolves the bucket from the Host header', async () => {
  const res = await rawRequest({
    method: 'GET',
    path: '/index.html',
    headers: { Host: `${BUCKET}.localhost:${ctx.port}` },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, '<h1>home</h1>');

  const vhostAws = await rawRequest({
    method: 'GET',
    path: '/index.html',
    headers: { Host: `${BUCKET}.s3.us-west-2.amazonaws.com` },
  });
  assert.strictEqual(vhostAws.status, 200);
  assert.strictEqual(vhostAws.body, '<h1>home</h1>');
});

test('service-level GET lists buckets as XML', async () => {
  const res = await fetch(`${ctx.endpoint}/`);
  assert.strictEqual(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<ListAllMyBucketsResult/);
  assert.match(xml, new RegExp(`<Name>${BUCKET}</Name>`));
});

test('browser-style form POST uploads an object', async () => {
  const form = new FormData();
  form.append('key', 'uploads/${filename}');
  form.append('Content-Type', 'text/plain');
  form.append('success_action_status', '201');
  form.append(
    'file',
    new Blob(['posted content'], { type: 'text/plain' }),
    'posted.txt'
  );

  const res = await fetch(`${ctx.endpoint}/${BUCKET}`, {
    method: 'POST',
    body: form,
  });
  assert.strictEqual(res.status, 201);
  const xml = await res.text();
  assert.match(xml, /<PostResponse[\s>]/);
  assert.match(xml, /<Key>uploads\/posted.txt<\/Key>/);

  const direct = await fetch(`${ctx.endpoint}/${BUCKET}/uploads/posted.txt`);
  assert.strictEqual(await direct.text(), 'posted content');
});

test('unicode and slash-heavy keys survive round-trips', async () => {
  const key = 'דיר/פאַנסי keys/emoji 🪣/ü.txt';
  const put = await fetch(
    `${ctx.endpoint}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'PUT', body: 'unicode works' }
  );
  assert.strictEqual(put.status, 200);
  const res = await fetch(
    `${ctx.endpoint}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}?attributes-not-api`
  );
  assert.strictEqual(await res.text(), 'unicode works');
});

test('reset() clears every bucket', async () => {
  const other = await startServer();
  try {
    await other.server.store.createBucket('reset-me');
    await other.server.reset();
    const res = await fetch(`${other.endpoint}/`);
    const xml = await res.text();
    assert.doesNotMatch(xml, /reset-me/);
  } finally {
    await other.close();
  }
});

test('a persistent directory survives restarts unless resetOnStart is set', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's3-restart-'));
  try {
    const first = await startServer({ directory, resetOnClose: false });
    await fetch(`${first.endpoint}/durable`, { method: 'PUT' });
    await fetch(`${first.endpoint}/durable/kept.txt`, {
      method: 'PUT',
      body: 'still here',
    });
    await first.close();

    // Restart on the same directory: the data is still there.
    const second = await startServer({ directory, resetOnClose: false });
    const kept = await fetch(`${second.endpoint}/durable/kept.txt`);
    assert.strictEqual(kept.status, 200);
    assert.strictEqual(await kept.text(), 'still here');
    await second.close();

    // Restart with resetOnStart: the directory is cleared first.
    const third = await startServer({
      directory,
      resetOnClose: false,
      resetOnStart: true,
    });
    const buckets = await fetch(`${third.endpoint}/`);
    assert.doesNotMatch(await buckets.text(), /durable/);
    await third.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
