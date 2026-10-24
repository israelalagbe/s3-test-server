'use strict';

const { escapeRegExp } = require('../utils');

/**
 * Resolves the bucket name from the Host header for virtual-host-style
 * requests (bucket.localhost, bucket.s3.<region>.<serviceEndpoint>, ...).
 * Returns null for path-style requests.
 */
function resolveVhostBucket(req, options) {
  if (!options.vhostBuckets) return null;
  const host = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    /^[\d.]+$/.test(host) ||
    host === '[::1]'
  ) {
    return null;
  }
  if (host === options.address || host === options.serviceEndpoint) return null;

  const patterns = [
    // bucket.s3.region.amazonaws.com / bucket.s3-region.amazonaws.com
    new RegExp(
      `^(.+)\\.s3[.-][a-z0-9-]+\\.${escapeRegExp(options.serviceEndpoint)}$`
    ),
    // bucket.s3.amazonaws.com
    new RegExp(`^(.+)\\.s3\\.${escapeRegExp(options.serviceEndpoint)}$`),
    // bucket.amazonaws.com-style custom endpoints
    new RegExp(`^(.+)\\.${escapeRegExp(options.serviceEndpoint)}$`),
    // bucket.localhost
    /^(.+)\.localhost$/,
  ];
  if (
    options.address &&
    options.address !== 'localhost' &&
    !/^[\d.]+$/.test(options.address)
  ) {
    patterns.push(new RegExp(`^(.+)\\.${escapeRegExp(options.address)}$`));
  }
  for (const pattern of patterns) {
    const match = pattern.exec(host);
    if (match) {
      const prefix = match[1];
      if (
        prefix === 's3' ||
        prefix.startsWith('s3.') ||
        prefix.startsWith('s3-')
      ) {
        return null;
      }
      return prefix;
    }
  }
  return null;
}

module.exports = { resolveVhostBucket };
