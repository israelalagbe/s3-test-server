'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { FilesystemStore } = require('./stores/filesystem');
const { createRequestHandler } = require('./routes');
const { awsUriEncode } = require('./utils');
const { S3Error } = require('./models/error');

const DEFAULT_OPTIONS = {
  address: 'localhost',
  port: 4568,
  key: undefined,
  cert: undefined,
  silent: false,
  directory: undefined,
  resetOnStart: false,
  resetOnClose: false,
  allowMismatchedSignatures: false,
  vhostBuckets: true,
  serviceEndpoint: 'amazonaws.com',
  accessKeyId: 'S3TEST',
  secretAccessKey: 'S3TEST',
  region: 'us-east-1',
  // Like real S3, buckets are private by default: anonymous requests get
  // 403 AccessDenied unless the bucket's ACL makes it public.
  defaultBucketAcl: 'private',
  configureBuckets: [],
};

class S3TestServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    // When the user pins a region, behave like a regional endpoint and
    // reject requests signed for other regions. Otherwise accept any.
    this.options.enforceRegion = Object.prototype.hasOwnProperty.call(
      options,
      'region'
    );
    this.logger = {
      info: (...args) => {
        if (!this.options.silent) console.log(...args);
      },
      error: (...args) => {
        if (!this.options.silent) console.error(...args);
      },
    };
    this.httpServer = null;
    this.store = null;
    this.hostPort = null;
    this.endpoint = null;
    this._middleware = null;
    this._sequencer = 0;
  }

  _ensureStore() {
    if (this.store) return this.store;
    let root = this.options.directory;
    if (!root) {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-test-server-'));
      this._createdTempDir = true;
    }
    fs.mkdirSync(root, { recursive: true });
    this.store = new FilesystemStore(root);
    return this.store;
  }

  /**
   * Returns a `(req, res)` handler usable with http.createServer() or as an
   * Express/Connect middleware.
   */
  callback() {
    this._ensureStore();
    if (!this._middleware) this._middleware = createRequestHandler(this);
    return this._middleware;
  }

  getMiddleware() {
    return this.callback();
  }

  /** Starts the server. Returns a promise of `{ address, port, ... }`. */
  run(callback) {
    const promise = (async () => {
      this._ensureStore();
      await this.store.initialize();
      // Start from an empty data directory when asked, so a persistent
      // `directory` does not leak state between runs.
      if (this.options.resetOnStart) {
        await this.store.reset();
      }
      await this.configureBuckets();
      const handler = this.callback();
      this.httpServer =
        this.options.key && this.options.cert
          ? https.createServer(
              { key: this.options.key, cert: this.options.cert },
              handler
            )
          : http.createServer(handler);
      await new Promise((resolve, reject) => {
        this.httpServer.once('error', reject);
        this.httpServer.listen(this.options.port, this.options.address, () => {
          this.httpServer.removeListener('error', reject);
          resolve();
        });
      });
      const address = this.httpServer.address();
      const protocol = this.options.key && this.options.cert ? 'https' : 'http';
      this.hostPort = `${this.options.address}:${address.port}`;
      this.endpoint = `${protocol}://${this.hostPort}`;
      this.logger.info(`S3 test server listening on ${this.endpoint}`);
      return {
        ...address,
        protocol,
        hostPort: this.hostPort,
        endpoint: this.endpoint,
      };
    })();
    if (typeof callback === 'function') {
      promise.then(
        (address) => callback(null, address),
        (err) => callback(err)
      );
      return this;
    }
    return promise;
  }

  /** Stops the server. With `resetOnClose`, removes all bucket data. */
  close(callback) {
    const promise = (async () => {
      if (this.httpServer) {
        this.httpServer.closeAllConnections?.();
        await new Promise((resolve, reject) => {
          this.httpServer.close((err) => (err ? reject(err) : resolve()));
        });
        this.httpServer = null;
      }
      if (this.store && this.options.resetOnClose) {
        if (this._createdTempDir) await this.store.destroy();
        else await this.store.reset();
      }
    })();
    if (typeof callback === 'function') {
      promise.then(
        () => callback(null),
        (err) => callback(err)
      );
      return this;
    }
    return promise;
  }

  /**
   * Creates the buckets given in `options.configureBuckets` (name plus raw
   * XML configs: CORS, website or tagging documents, detected by their root
   * element) without going through the S3 API.
   */
  async configureBuckets() {
    this._ensureStore();
    await this.store.initialize();
    const {
      parseCorsConfig,
      parseWebsiteConfig,
      parseTaggingConfig,
      validateCannedAcl,
    } = require('./controllers/bucket');
    const { validateBucketName } = require('./utils');
    for (const { name, configs = [], acl } of this.options.configureBuckets ||
      []) {
      validateBucketName(name);
      await this.store.createBucket(name);
      if (acl) {
        await this.store.putBucketConfig(name, 'acl', validateCannedAcl(acl));
      }
      for (const rawConfig of configs) {
        const xml = Buffer.isBuffer(rawConfig)
          ? rawConfig.toString('utf8')
          : String(rawConfig);
        if (/^\s*\{/.test(xml)) {
          const { parseBucketPolicy } = require('./models/policy');
          await this.store.putBucketConfig(
            name,
            'policy',
            parseBucketPolicy(xml)
          );
        } else if (/<\s*(\w+:)?CORSConfiguration[\s>]/.test(xml)) {
          await this.store.putBucketConfig(name, 'cors', parseCorsConfig(xml));
        } else if (/<\s*(\w+:)?WebsiteConfiguration[\s>]/.test(xml)) {
          await this.store.putBucketConfig(
            name,
            'website',
            parseWebsiteConfig(xml)
          );
        } else if (/<\s*(\w+:)?Tagging[\s>]/.test(xml)) {
          await this.store.putBucketConfig(
            name,
            'tagging',
            parseTaggingConfig(xml)
          );
        } else {
          throw new S3Error(
            'MalformedXML',
            'Unrecognized bucket configuration document'
          );
        }
      }
    }
  }

  /** Deletes all buckets, objects and bucket configurations. */
  async reset() {
    this._ensureStore();
    await this.store.reset();
  }

  // ---------------------------------------------------------------- helpers

  _toSummary(meta) {
    return {
      key: meta.key,
      size: meta.size,
      etag: meta.etag,
      lastModified: new Date(meta.lastModified),
      contentType: meta.contentType,
      metadata: { ...(meta.userMetadata || {}) },
    };
  }

  /**
   * Lists the completed objects in a bucket (multipart parts in flight are
   * never included), sorted by key. With `bodies: true`, each entry also
   * carries its content as a Buffer.
   */
  async getObjects(bucket, { prefix = '', bodies = false } = {}) {
    this._ensureStore();
    if (!(await this.store.getBucket(bucket))) {
      throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', {
        BucketName: bucket,
      });
    }
    const metas = (await this.store.listObjects(bucket)).filter(
      (meta) => !prefix || meta.key.startsWith(prefix)
    );
    const summaries = metas.map((meta) => this._toSummary(meta));
    if (bodies) {
      for (const summary of summaries) {
        summary.body = await this._readObject(bucket, summary.key);
      }
    }
    return summaries;
  }

  _readObject(bucket, key) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      this.store
        .createObjectReadStream(bucket, key)
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });
  }

  /**
   * Resolves with the bucket's objects once at least `count` of them exist
   * (optionally under `prefix`). Useful when the code under test uploads in
   * the background. A bucket that does not exist yet simply counts as empty.
   */
  async waitForObjects(bucket, count, { prefix = '', timeout = 10000 } = {}) {
    this._ensureStore();
    const matching = async () => {
      if (!(await this.store.getBucket(bucket))) return null;
      const metas = (await this.store.listObjects(bucket)).filter(
        (meta) => !prefix || meta.key.startsWith(prefix)
      );
      return metas.length >= count
        ? metas.map((meta) => this._toSummary(meta))
        : null;
    };

    const found = await matching();
    if (found) return found;

    return new Promise((resolve, reject) => {
      let interval;
      let timer;
      const check = async () => {
        const objects = await matching().catch(() => null);
        if (objects) {
          cleanup();
          resolve(objects);
        }
      };
      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(timer);
        this.removeListener('event', check);
      };
      this.on('event', check);
      // Poll as well, so out-of-band writes (e.g. putObjects) are seen too.
      interval = setInterval(check, 150);
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeout}ms waiting for ${count} object(s) in "${bucket}"` +
              (prefix ? ` under "${prefix}"` : '')
          )
        );
      }, timeout);
    });
  }

  /**
   * Seeds objects directly into the store, bypassing the HTTP API. The
   * bucket is created when missing. Each entry is
   * `{ key, body, contentType?, metadata? }` with a string or Buffer body.
   * No S3 event notifications are emitted for seeded objects.
   */
  async putObjects(bucket, objects) {
    this._ensureStore();
    await this.store.initialize();
    const { validateBucketName } = require('./utils');
    validateBucketName(bucket);
    await this.store.createBucket(bucket);
    const { Readable } = require('stream');
    const results = [];
    for (const object of objects) {
      if (!object || typeof object.key !== 'string') {
        throw new TypeError('putObjects entries need a string `key`');
      }
      const body = Buffer.isBuffer(object.body)
        ? object.body
        : Buffer.from(object.body ?? '');
      const staged = await this.store.stageObject(
        bucket,
        Readable.from([body]),
        ['CRC64NVME']
      );
      const meta = await staged.commit(object.key, {
        contentType: object.contentType || 'binary/octet-stream',
        userMetadata: { ...(object.metadata || {}) },
        tagging: {},
        checksums: staged.digests.checksums,
        checksumAlgorithm: 'CRC64NVME',
        checksumType: 'FULL_OBJECT',
      });
      results.push(this._toSummary(meta));
    }
    return results;
  }

  _emitEvent(eventName, bucket, objectMeta) {
    if (!objectMeta) return;
    this._sequencer += 1;
    const record = {
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: this.options.region,
      eventTime: new Date().toISOString(),
      eventName,
      userIdentity: { principalId: 'AIDAJDPLRKLG7UEXAMPLE' },
      requestParameters: { sourceIPAddress: '127.0.0.1' },
      responseElements: {
        'x-amz-request-id': 'C3D13FE58DE4C810',
        'x-amz-id-2':
          'FMyUVURIY8/IgAtTv8xRjskZQpcIZ9KG4V5Wp6S7S/JRWeUWerMUE5JgHvANOjpD',
      },
      s3: {
        s3SchemaVersion: '1.0',
        configurationId: 'testConfigRule',
        bucket: {
          name: bucket,
          ownerIdentity: { principalId: 'A3NL1KOZZKExample' },
          arn: `arn:aws:s3:::${bucket}`,
        },
        object: {
          key: awsUriEncode(objectMeta.key, false),
          size: objectMeta.size,
          eTag: objectMeta.etag,
          sequencer: this._sequencer
            .toString(16)
            .toUpperCase()
            .padStart(16, '0'),
        },
      },
    };
    this.emit('event', { Records: [record] });
  }
}

module.exports = S3TestServer;
module.exports.S3TestServer = S3TestServer;
module.exports.default = S3TestServer;
module.exports.S3Error = S3Error;
