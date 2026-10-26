'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { DigestCalculator } = require('../checksums');
const { compareKeys } = require('../utils');

const BUCKET_META_FILE = '.bucket.json';
const OBJECTS_DIR = 'objects';
const UPLOADS_DIR = 'uploads';

/**
 * Filesystem-backed store.
 *
 * Layout:
 *   <root>/<bucket>/.bucket.json                        bucket metadata + configs
 *   <root>/<bucket>/objects/<h2>/<sha256(key)>.json     version chain (incl. real key)
 *   <root>/<bucket>/objects/<h2>/<sha256(key)>.<vid>    content of one version
 *   <root>/<bucket>/uploads/<uploadId>/upload.json      multipart upload metadata
 *   <root>/<bucket>/uploads/<uploadId>/part.<n>[.json]  part content / metadata
 *
 * Object content is addressed by a hash of the key, so any legal S3 key
 * (slashes, unicode, 1024 chars) maps to a safe filename on every platform.
 * Each key's sidecar JSON holds its version chain, newest first; unversioned
 * buckets simply keep a single "null" version per key. A per-bucket in-memory
 * index (rebuilt lazily from the sidecar files) backs listings, so data
 * survives restarts.
 */
class FilesystemStore {
  constructor(root) {
    this.root = root;
    this.indexes = new Map(); // bucket → Map(key → { key, versions: [meta, ...] })
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

  _shardDir(bucket, key) {
    const hash = this._keyHash(key);
    return path.join(this._bucketPath(bucket), OBJECTS_DIR, hash.slice(0, 2));
  }

  _chainPath(bucket, key) {
    return path.join(this._shardDir(bucket, key), `${this._keyHash(key)}.json`);
  }

  _contentPathFor(bucket, meta) {
    return path.join(this._shardDir(bucket, meta.key), meta.contentFile);
  }

  _newVersionId() {
    return crypto.randomBytes(16).toString('base64url');
  }

  // ---------- buckets ----------

  async listBuckets() {
    const entries = await fsp
      .readdir(this.root, { withFileTypes: true })
      .catch(() => []);
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
    await this._writeJson(
      path.join(this._bucketPath(bucket), BUCKET_META_FILE),
      rest
    );
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
          const parsed = JSON.parse(
            await fsp.readFile(path.join(objectsDir, shard, file), 'utf8')
          );
          const chain = Array.isArray(parsed.versions)
            ? parsed
            : // sidecar written before versioning existed: a single flat meta
              {
                key: parsed.key,
                versions: [
                  {
                    ...parsed,
                    versionId: 'null',
                    contentFile: file.slice(0, -'.json'.length),
                  },
                ],
              };
          index.set(chain.key, chain);
        } catch {
          // skip unreadable metadata
        }
      }
    }
    this.indexes.set(bucket, index);
    return index;
  }

  async _persistChain(bucket, chain) {
    const index = await this._index(bucket);
    if (chain.versions.length === 0) {
      index.delete(chain.key);
      await fsp.rm(this._chainPath(bucket, chain.key), { force: true });
    } else {
      index.set(chain.key, chain);
      await this._writeJson(this._chainPath(bucket, chain.key), chain);
    }
  }

  /** Latest, non-delete-marker version of every key, sorted by key. */
  async listObjects(bucket) {
    const index = await this._index(bucket);
    return [...index.values()]
      .map((chain) => chain.versions[0])
      .filter((meta) => meta && !meta.isDeleteMarker)
      .sort((a, b) => compareKeys(a.key, b.key));
  }

  /** Every version of every key (delete markers included), newest first. */
  async listVersions(bucket) {
    const index = await this._index(bucket);
    const chains = [...index.values()].sort((a, b) =>
      compareKeys(a.key, b.key)
    );
    const versions = [];
    for (const chain of chains) {
      chain.versions.forEach((meta, position) => {
        versions.push({ ...meta, isLatest: position === 0 });
      });
    }
    return versions;
  }

  /**
   * Returns the latest version of a key (which may be a delete marker, see
   * `isDeleteMarker`), or a specific version when `versionId` is given.
   */
  async getObject(bucket, key, versionId) {
    const index = await this._index(bucket);
    const chain = index.get(key);
    if (!chain) return null;
    if (versionId === undefined) return chain.versions[0] || null;
    return chain.versions.find((meta) => meta.versionId === versionId) || null;
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
      /**
       * Commits the staged content as a new version of `key`. With
       * `versioning: 'Enabled'` the version gets a fresh id and earlier
       * versions are kept; otherwise it replaces the key's "null" version.
       */
      async commit(key, fields, versioning) {
        const enabled = versioning === 'Enabled';
        const versionId = enabled ? store._newVersionId() : 'null';
        const hash = store._keyHash(key);
        const contentFile = `${hash}.${versionId}`;
        const contentPath = path.join(
          store._shardDir(bucket, key),
          contentFile
        );
        await fsp.mkdir(path.dirname(contentPath), { recursive: true });
        await fsp.rename(tmpPath, contentPath);
        const meta = {
          key,
          versionId,
          contentFile,
          size: digests.size,
          etag: fields.etag || digests.md5Hex,
          lastModified: Date.now(),
          ...fields,
        };
        const index = await store._index(bucket);
        const chain = index.get(key) || { key, versions: [] };
        if (!enabled) {
          await store._removeVersion(bucket, chain, 'null');
        }
        chain.versions.unshift(meta);
        await store._persistChain(bucket, chain);
        return meta;
      },
      async abort() {
        await fsp.rm(tmpPath, { force: true });
      },
    };
  }

  /** Removes a version's entry and content file from a chain, if present. */
  async _removeVersion(bucket, chain, versionId) {
    const position = chain.versions.findIndex(
      (meta) => meta.versionId === versionId
    );
    if (position === -1) return null;
    const [removed] = chain.versions.splice(position, 1);
    if (removed.contentFile) {
      await fsp.rm(this._contentPathFor(bucket, removed), { force: true });
    }
    return removed;
  }

  createObjectReadStream(bucket, meta, range) {
    const opts = {};
    if (range) {
      opts.start = range.start;
      opts.end = range.end;
    }
    return fs.createReadStream(this._contentPathFor(bucket, meta), opts);
  }

  /** Replaces one version's metadata (matched by `versionId`) in its chain. */
  async updateObjectMeta(bucket, key, meta) {
    const index = await this._index(bucket);
    const chain = index.get(key);
    if (!chain) return;
    const position = chain.versions.findIndex(
      (entry) => entry.versionId === meta.versionId
    );
    if (position === -1) return;
    chain.versions[position] = meta;
    await this._persistChain(bucket, chain);
  }

  /**
   * Deletes a key or one of its versions.
   *  - With `versionId`: permanently removes that version (or delete marker).
   *  - Without, on a versioning-enabled bucket: inserts a delete marker.
   *  - Without, on a suspended bucket: replaces the "null" version with a
   *    "null" delete marker.
   *  - Without, on an unversioned bucket: removes the key entirely.
   */
  async deleteObject(bucket, key, { versionId, versioning } = {}) {
    const index = await this._index(bucket);
    const chain = index.get(key);
    if (!chain) {
      return { existed: false, deleteMarker: versioning === 'Enabled' };
    }

    if (versionId !== undefined) {
      const removed = await this._removeVersion(bucket, chain, versionId);
      await this._persistChain(bucket, chain);
      return {
        existed: Boolean(removed),
        removedMarker: Boolean(removed && removed.isDeleteMarker),
        versionId,
      };
    }

    if (versioning === 'Enabled' || versioning === 'Suspended') {
      const markerId = versioning === 'Enabled' ? this._newVersionId() : 'null';
      if (versioning === 'Suspended') {
        await this._removeVersion(bucket, chain, 'null');
      }
      const marker = {
        key,
        versionId: markerId,
        isDeleteMarker: true,
        size: 0,
        etag: 'd41d8cd98f00b204e9800998ecf8427e',
        lastModified: Date.now(),
      };
      chain.versions.unshift(marker);
      await this._persistChain(bucket, chain);
      return { existed: true, deleteMarker: true, versionId: markerId };
    }

    for (const meta of [...chain.versions]) {
      await this._removeVersion(bucket, chain, meta.versionId);
    }
    await this._persistChain(bucket, chain);
    return { existed: true };
  }

  // ---------- lifecycle ----------

  /**
   * Applies the bucket's lifecycle rules (if any): current-version
   * expiration, noncurrent-version expiration and expired-delete-marker
   * cleanup. Evaluated lazily before reads and listings, so no timers are
   * needed. Locked versions are never expired.
   */
  async applyLifecycle(bucket) {
    const bucketMeta = await this.getBucket(bucket);
    const config = bucketMeta && bucketMeta.configs.lifecycle;
    if (!config) return;
    const versioning = bucketMeta.configs.versioning;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const index = await this._index(bucket);

    for (const chain of [...index.values()]) {
      const rules = config.rules.filter(
        (rule) =>
          rule.status === 'Enabled' && chain.key.startsWith(rule.prefix || '')
      );
      if (rules.length === 0) continue;
      let changed = false;
      const locked = (meta) =>
        meta.legalHold || (meta.retainUntil && meta.retainUntil > now);

      // noncurrent versions past their window are removed permanently
      for (const rule of rules) {
        if (rule.noncurrentDays === undefined) continue;
        const cutoff = now - rule.noncurrentDays * DAY;
        for (const meta of chain.versions.slice(1)) {
          if (meta.lastModified <= cutoff && !locked(meta)) {
            await this._removeVersion(bucket, chain, meta.versionId);
            changed = true;
          }
        }
      }

      // expired current versions: removed, or shadowed by a delete marker
      // on versioned buckets
      const latest = chain.versions[0];
      if (latest && !latest.isDeleteMarker && !locked(latest)) {
        const expired = rules.some(
          (rule) =>
            (rule.expirationDate !== undefined && rule.expirationDate <= now) ||
            (rule.expirationDays !== undefined &&
              latest.lastModified + rule.expirationDays * DAY <= now)
        );
        if (expired) {
          if (versioning === 'Enabled' || versioning === 'Suspended') {
            chain.versions.unshift({
              key: chain.key,
              versionId:
                versioning === 'Enabled' ? this._newVersionId() : 'null',
              isDeleteMarker: true,
              size: 0,
              etag: 'd41d8cd98f00b204e9800998ecf8427e',
              lastModified: now,
            });
          } else {
            await this._removeVersion(bucket, chain, latest.versionId);
          }
          changed = true;
        }
      }

      // a lone expired delete marker can be cleaned up entirely
      if (
        chain.versions.length === 1 &&
        chain.versions[0].isDeleteMarker &&
        rules.some((rule) => rule.expiredObjectDeleteMarker)
      ) {
        await this._removeVersion(bucket, chain, chain.versions[0].versionId);
        changed = true;
      }

      if (changed) await this._persistChain(bucket, chain);
    }
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
      (a, b) => compareKeys(a.key, b.key) || a.initiated - b.initiated
    );
    return uploads;
  }

  async putPart(bucket, uploadId, partNumber, readable, algorithms = []) {
    const dir = this._uploadDir(bucket, uploadId);
    const tmpPath = path.join(
      dir,
      `.tmp-${crypto.randomBytes(8).toString('hex')}`
    );
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
        parts.push(
          JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'))
        );
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
    const entries = await fsp
      .readdir(this.root, { withFileTypes: true })
      .catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        fsp.rm(path.join(this.root, entry.name), {
          recursive: true,
          force: true,
        })
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
