'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { FilesystemStore } = require('./store');
const { createMiddleware } = require('./middleware');
const { awsUriEncode } = require('./utils');
const { S3Error } = require('./errors');

const DEFAULT_OPTIONS = {
  address: 'localhost',
  port: 4568,
  key: undefined,
  cert: undefined,
  silent: false,
  directory: undefined,
  resetOnClose: false,
  allowMismatchedSignatures: false,
  vhostBuckets: true,
  serviceEndpoint: 'amazonaws.com',
  accessKeyId: 'S3TEST',
  secretAccessKey: 'S3TEST',
  region: 'us-east-1',
  configureBuckets: [],
};

class S3TestServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
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
    if (!this._middleware) this._middleware = createMiddleware(this);
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
      this.logger.info(
        `S3 test server listening on ${protocol}://${this.options.address}:${address.port}`
      );
      return { ...address, protocol, endpoint: `${protocol}://${this.options.address}:${address.port}` };
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
    } = require('./controllers/bucket');
    const { validateBucketName } = require('./utils');
    for (const { name, configs = [] } of this.options.configureBuckets || []) {
      validateBucketName(name);
      await this.store.createBucket(name);
      for (const rawConfig of configs) {
        const xml = Buffer.isBuffer(rawConfig) ? rawConfig.toString('utf8') : String(rawConfig);
        if (/<\s*(\w+:)?CORSConfiguration[\s>]/.test(xml)) {
          await this.store.putBucketConfig(name, 'cors', parseCorsConfig(xml));
        } else if (/<\s*(\w+:)?WebsiteConfiguration[\s>]/.test(xml)) {
          await this.store.putBucketConfig(name, 'website', parseWebsiteConfig(xml));
        } else if (/<\s*(\w+:)?Tagging[\s>]/.test(xml)) {
          await this.store.putBucketConfig(name, 'tagging', parseTaggingConfig(xml));
        } else {
          throw new S3Error('MalformedXML', 'Unrecognized bucket configuration document');
        }
      }
    }
  }

  /** Deletes all buckets, objects and bucket configurations. */
  async reset() {
    this._ensureStore();
    await this.store.reset();
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
        'x-amz-id-2': 'FMyUVURIY8/IgAtTv8xRjskZQpcIZ9KG4V5Wp6S7S/JRWeUWerMUE5JgHvANOjpD',
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
          sequencer: this._sequencer.toString(16).toUpperCase().padStart(16, '0'),
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
