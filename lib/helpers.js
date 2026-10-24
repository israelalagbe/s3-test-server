'use strict';

const { buildXml, S3_XMLNS } = require('./xml');
const { S3Error } = require('./errors');
const { compareKeys, awsUriEncode, isoDate, DUMMY_OWNER } = require('./utils');

function send(res, status, headers, body) {
  if (res.headersSent) {
    res.end();
    return;
  }
  for (const [name, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  const isHead = res.req && res.req.method === 'HEAD';
  if (body !== undefined && body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.setHeader('Content-Length', buf.length);
    res.writeHead(status);
    res.end(isHead ? undefined : buf);
  } else {
    res.writeHead(status);
    res.end();
  }
}

function sendXml(res, status, xmlString) {
  send(res, status, { 'Content-Type': 'application/xml' }, xmlString);
}

function sendDoc(res, status, rootName, content, { xmlns = S3_XMLNS } = {}) {
  sendXml(res, status, buildXml(rootName, content, { xmlns }));
}

/**
 * Shared pagination for ListObjects / ListObjectsV2 / ListObjectVersions.
 * `metas` must be sorted by key. Returns included object metas, grouped
 * common prefixes and the last emitted item (for Next* markers).
 */
function paginate(
  metas,
  { prefix = '', delimiter = '', marker = '', maxKeys = 1000 }
) {
  const contents = [];
  const prefixes = [];
  const seenPrefixes = new Set();
  let truncated = false;
  let lastItem = null;

  if (maxKeys === 0) {
    return { contents, prefixes, truncated: false, lastItem: null };
  }
  for (const meta of metas) {
    if (prefix && !meta.key.startsWith(prefix)) continue;
    let item = meta.key;
    let isPrefix = false;
    if (delimiter) {
      const rest = meta.key.slice(prefix.length);
      const idx = rest.indexOf(delimiter);
      if (idx !== -1) {
        item = prefix + rest.slice(0, idx + delimiter.length);
        isPrefix = true;
      }
    }
    if (marker && compareKeys(item, marker) <= 0) continue;
    if (isPrefix && seenPrefixes.has(item)) continue;
    if (contents.length + prefixes.length >= maxKeys) {
      truncated = true;
      break;
    }
    if (isPrefix) {
      seenPrefixes.add(item);
      prefixes.push(item);
    } else {
      contents.push(meta);
    }
    lastItem = item;
  }
  return { contents, prefixes, truncated, lastItem };
}

function parseListParams(query) {
  const maxKeysRaw = query.get('max-keys');
  let maxKeys = 1000;
  if (maxKeysRaw !== null) {
    maxKeys = parseInt(maxKeysRaw, 10);
    if (Number.isNaN(maxKeys) || maxKeys < 0) {
      throw new S3Error(
        'InvalidArgument',
        'Argument max-keys must be an integer between 0 and 2147483647',
        {
          ArgumentName: 'max-keys',
          ArgumentValue: maxKeysRaw,
        }
      );
    }
    maxKeys = Math.min(maxKeys, 1000);
  }
  const encodingType = query.get('encoding-type') || undefined;
  if (encodingType && encodingType !== 'url') {
    throw new S3Error(
      'InvalidArgument',
      'Invalid Encoding Method specified in Request',
      {
        ArgumentName: 'encoding-type',
        ArgumentValue: encodingType,
      }
    );
  }
  return {
    prefix: query.get('prefix') || '',
    delimiter: query.get('delimiter') || '',
    maxKeys,
    encodingType,
  };
}

function encodeListValue(value, encodingType) {
  if (value === undefined || value === null || value === '') return value;
  return encodingType === 'url' ? awsUriEncode(value, false) : value;
}

function contentsEntry(meta, encodingType, { owner = true } = {}) {
  const entry = {
    Key: encodeListValue(meta.key, encodingType),
    LastModified: isoDate(meta.lastModified),
    ETag: `"${meta.etag}"`,
    Size: meta.size,
    StorageClass: meta.storageClass || 'STANDARD',
  };
  if (meta.checksumAlgorithm) {
    entry.ChecksumAlgorithm = meta.checksumAlgorithm;
    if (meta.checksumType) entry.ChecksumType = meta.checksumType;
  }
  if (owner) entry.Owner = DUMMY_OWNER;
  return entry;
}

function quoteEtag(etag) {
  return `"${etag}"`;
}

function stripEtagQuotes(value) {
  return String(value || '').replace(/^(W\/)?"?|"?$/g, '');
}

module.exports = {
  send,
  sendXml,
  sendDoc,
  paginate,
  parseListParams,
  encodeListValue,
  contentsEntry,
  quoteEtag,
  stripEtagQuotes,
};
