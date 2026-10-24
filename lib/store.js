'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { DigestCalculator } = require('./checksums');
const { compareKeys } = require('./utils');

const BUCKET_META_FILE = '.bucket.json';
const OBJECTS_DIR = 'objects';
const UPLOADS_DIR = 'uploads';

/**
 * Filesystem-backed store.
 *
 * Layout:
 *   <root>/<bucket>/.bucket.json                     bucket metadata + configs
 *   <root>/<bucket>/objects/<h2>/<sha256(key)>       object content
 *   <root>/<bucket>/objects/<h2>/<sha256(key)>.json  object metadata (incl. real key)
 *   <root>/<bucket>/uploads/<uploadId>/upload.json   multipart upload metadata
 *   <root>/<bucket>/uploads/<uploadId>/part.<n>      part content
 *   <root>/<bucket>/uploads/<uploadId>/part.<n>.json part metadata
 *
 * Object content is addressed by a hash of the key, so any legal S3 key
 * (slashes, unicode, 1024 chars) maps to a safe filename on every platform.
 * A per-bucket in-memory index (rebuilt lazily from the metadata files) backs
 * listings, so data survives restarts.
 */
class FilesystemStore {
  constructor(root) {
    this.root = root;
    this.indexes = new Map(); // bucket → Map(key → meta)
  }

  async initialize() {
    await fsp.mkdir(this.root, { recursive: true });
  }

  _bucketPath(bucket) {
    return path.join(this.root, bucket);
  }

  _keyHash(key) {
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  }

  _contentPath(bucket, key) {
    const hash = this._keyHash(key);
    return path.join(this._bucketPath(bucket), OBJECTS_DIR, hash.slice(0, 2), hash);
  }

  // ---------- buckets ----------

  async listBuckets() {
    const entries = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const buckets = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.getBucket(entry.name);
      if (meta) buckets.push(meta);
    }
    buckets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return buckets;
  }

  async getBucket(bucket) {
    try {
      const raw = await fsp.readFile(
        path.join(this._bucketPath(bucket), BUCKET_META_FILE),
        'utf8'
      );
      return { name: bucket, ...JSON.parse(raw) };
    } catch {
      return null;
    }
  }

  async createBucket(bucket) {
    const existing = await this.getBucket(bucket);
    if (existing) return { created: false, meta: existing };
    const dir = this._bucketPath(bucket);
    await fsp.mkdir(path.join(dir, OBJECTS_DIR), { recursive: true });
    await fsp.mkdir(path.join(dir, UPLOADS_DIR), { recursive: true });
    const meta = { creationDate: Date.now(), configs: {} };
    await this._writeJson(path.join(dir, BUCKET_META_FILE), meta);
    this.indexes.set(bucket, new Map());
    return { created: true, meta: { name: bucket, ...meta } };
  }

  async deleteBucket(bucket) {
    const index = await this._index(bucket);
    if (index.size > 0) return { deleted: false, reason: 'objects' };
    const uploads = await this.listUploads(bucket);
    if (uploads.length > 0) return { deleted: false, reason: 'uploads' };
    await fsp.rm(this._bucketPath(bucket), { recursive: true, force: true });
    this.indexes.delete(bucket);
    return { deleted: true };
  }

  async putBucketConfig(bucket, type, value) {
    const meta = await this.getBucket(bucket);
    if (!meta) return false;
    const { name, ...rest } = meta;
    rest.configs = rest.configs || {};
    if (value === null) delete rest.configs[type];
    else rest.configs[type] = value;
    await this._writeJson(path.join(this._bucketPath(bucket), BUCKET_META_FILE), rest);
    return true;
  }

  // ---------- object index ----------

  async _index(bucket) {
    let index = this.indexes.get(bucket);
    if (index) return index;
    index = new Map();
    const objectsDir = path.join(this._bucketPath(bucket), OBJECTS_DIR);
    const shards = await fsp.readdir(objectsDir).catch(() => []);
    for (const shard of shards) {
      const files = await fsp
        .readdir(path.join(objectsDir, shard))
        .catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(
            await fsp.readFile(path.join(objectsDir, shard, file), 'utf8')
          );
          index.set(meta.key, meta);
        } catch {
          // skip unreadable metadata
        }
      }
    }
    this.indexes.set(bucket, index);
    return index;
  }

  async listObjects(bucket) {
    const index = await this._index(bucket);
    return [...index.values()].sort((a, b) => compareKeys(a.key, b.key));
  }

  async getObject(bucket, key) {
    const index = await this._index(bucket);
    return index.get(key) || null;
  }

  // ---------- object content ----------

  /**
   * Streams `readable` into a temp file while computing digests. Returns a
   * staging handle: inspect `size`/`digests`, then `commit(key, fields)` or
   * `abort()`.
   */
  async stageObject(bucket, readable, algorithms = []) {
    const bucketDir = this._bucketPath(bucket);
    const tmpPath = path.join(
      bucketDir,
      `.tmp-${crypto.randomBytes(8).toString('hex')}`
    );
    const calculator = new DigestCalculator(algorithms);
    const writable = fs.createWriteStream(tmpPath, { flags: 'wx' });
    try {
      await pipeline(
        readable,
        async function* (source) {
          for await (const chunk of source) {
            calculator.update(chunk);
            yield chunk;
          }
        },
        writable
      );
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      throw err;
    }
    const digests = calculator.digest();
    const store = this;
    return {
      size: digests.size,
      digests,
      async commit(key, fields) {
        const contentPath = store._contentPath(bucket, key);
        await fsp.mkdir(path.dirname(contentPath), { recursive: true });
        await fsp.rename(tmpPath, contentPath);
        const meta = {
          key,
          size: digests.size,
          etag: fields.etag || digests.md5Hex,
          lastModified: Date.now(),
          ...fields,
        };
        await store._writeJson(`${contentPath}.json`, meta);
        const index = await store._index(bucket);
        index.set(key, meta);
        return meta;
      },
      async abort() {
        await fsp.rm(tmpPath, { force: true });
      },
    };
  }

  createObjectReadStream(bucket, key, range) {
    const contentPath = this._contentPath(bucket, key);
    const opts = {};
    if (range) {
      opts.start = range.start;
      opts.end = range.end;
    }
    return fs.createReadStream(contentPath, opts);
  }

  async updateObjectMeta(bucket, key, meta) {
    const contentPath = this._contentPath(bucket, key);
    await this._writeJson(`${contentPath}.json`, meta);
    const index = await this._index(bucket);
    index.set(key, meta);
  }

  async deleteObject(bucket, key) {
    const index = await this._index(bucket);
    const existed = index.delete(key);
    const contentPath = this._contentPath(bucket, key);
    await fsp.rm(contentPath, { force: true });
    await fsp.rm(`${contentPath}.json`, { force: true });
    return existed;
  }

  // ---------- multipart uploads ----------

  _uploadDir(bucket, uploadId) {
    return path.join(this._bucketPath(bucket), UPLOADS_DIR, uploadId);
  }

  async createUpload(bucket, key, fields) {
    const uploadId = crypto.randomBytes(24).toString('hex');
    const dir = this._uploadDir(bucket, uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const meta = { uploadId, key, initiated: Date.now(), ...fields };
    await this._writeJson(path.join(dir, 'upload.json'), meta);
    return meta;
  }

  async getUpload(bucket, uploadId) {
    if (!/^[0-9a-f]+$/.test(uploadId)) return null;
    try {
      const raw = await fsp.readFile(
        path.join(this._uploadDir(bucket, uploadId), 'upload.json'),
        'utf8'
      );
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async listUploads(bucket) {
    const uploadsDir = path.join(this._bucketPath(bucket), UPLOADS_DIR);
    const ids = await fsp.readdir(uploadsDir).catch(() => []);
    const uploads = [];
    for (const id of ids) {
      const meta = await this.getUpload(bucket, id);
      if (meta) uploads.push(meta);
    }
    uploads.sort(
      (a, b) => compareKeys(a.key, b.key) || (a.initiated - b.initiated)
    );
    return uploads;
  }

  async putPart(bucket, uploadId, partNumber, readable, algorithms = []) {
    const dir = this._uploadDir(bucket, uploadId);
    const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    const calculator = new DigestCalculator(algorithms);
    try {
      await pipeline(
        readable,
        async function* (source) {
          for await (const chunk of source) {
            calculator.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(tmpPath, { flags: 'wx' })
      );
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      throw err;
    }
    const digests = calculator.digest();
    const store = this;
    return {
      digests,
      async commit() {
        const partPath = path.join(dir, `part.${partNumber}`);
        await fsp.rename(tmpPath, partPath);
        const meta = {
          partNumber,
          size: digests.size,
          etag: digests.md5Hex,
          lastModified: Date.now(),
          checksums: digests.checksums,
        };
        await store._writeJson(`${partPath}.json`, meta);
        return meta;
      },
      async abort() {
        await fsp.rm(tmpPath, { force: true });
      },
    };
  }

  async listParts(bucket, uploadId) {
    const dir = this._uploadDir(bucket, uploadId);
    const files = await fsp.readdir(dir).catch(() => []);
    const parts = [];
    for (const file of files) {
      if (!/^part\.\d+\.json$/.test(file)) continue;
      try {
        parts.push(JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8')));
      } catch {
        // skip unreadable part metadata
      }
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return parts;
  }

  createPartReadStream(bucket, uploadId, partNumber) {
    return fs.createReadStream(
      path.join(this._uploadDir(bucket, uploadId), `part.${partNumber}`)
    );
  }

  async removeUpload(bucket, uploadId) {
    await fsp.rm(this._uploadDir(bucket, uploadId), {
      recursive: true,
      force: true,
    });
  }

  // ---------- maintenance ----------

  async reset() {
    const entries = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        fsp.rm(path.join(this.root, entry.name), { recursive: true, force: true })
      )
    );
    this.indexes.clear();
  }

  async destroy() {
    await fsp.rm(this.root, { recursive: true, force: true });
    this.indexes.clear();
  }

  async _writeJson(filePath, value) {
    const tmpPath = `${filePath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmpPath, JSON.stringify(value));
    await fsp.rename(tmpPath, filePath);
  }
}

module.exports = { FilesystemStore };
