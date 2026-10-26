'use strict';

const { S3Error } = require('../models/error');
const { parseXml, asArray, escapeXml, S3_XMLNS } = require('../xml');
const {
  send,
  sendXml,
  sendDoc,
  paginate,
  parseListParams,
  encodeListValue,
  contentsEntry,
} = require('../models/response');
const {
  readBody,
  validateBucketName,
  isoDate,
  DUMMY_OWNER,
} = require('../utils');

const CANNED_ACLS = new Set([
  'private',
  'public-read',
  'public-read-write',
  'authenticated-read',
]);

const ALL_USERS_URI = 'http://acs.amazonaws.com/groups/global/AllUsers';

function groupGrant(permission) {
  return (
    '<Grant>' +
    '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group">' +
    `<URI>${ALL_USERS_URI}</URI></Grantee>` +
    `<Permission>${permission}</Permission>` +
    '</Grant>'
  );
}

/** Renders an AccessControlPolicy document reflecting a canned ACL. */
function aclXml(acl = 'private') {
  let grants =
    '<Grant>' +
    '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">' +
    `<ID>${DUMMY_OWNER.ID}</ID><DisplayName>${DUMMY_OWNER.DisplayName}</DisplayName></Grantee>` +
    '<Permission>FULL_CONTROL</Permission>' +
    '</Grant>';
  if (acl === 'public-read' || acl === 'public-read-write') {
    grants += groupGrant('READ');
  }
  if (acl === 'public-read-write') {
    grants += groupGrant('WRITE');
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<AccessControlPolicy xmlns="${S3_XMLNS}">` +
    `<Owner><ID>${DUMMY_OWNER.ID}</ID><DisplayName>${DUMMY_OWNER.DisplayName}</DisplayName></Owner>` +
    `<AccessControlList>${grants}</AccessControlList></AccessControlPolicy>`
  );
}

const dummyAclXml = () => aclXml('private');

function validateCannedAcl(acl) {
  if (!CANNED_ACLS.has(acl)) {
    throw new S3Error('InvalidArgument', 'The ACL you provided is not valid', {
      ArgumentName: 'x-amz-acl',
      ArgumentValue: acl,
    });
  }
  return acl;
}

async function requireBucket(ctx) {
  const meta = await ctx.store.getBucket(ctx.bucket);
  if (!meta) {
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', {
      BucketName: ctx.bucket,
    });
  }
  return meta;
}

// ---------------------------------------------------------------- GET

async function getBucket(ctx) {
  const { query, res } = ctx;

  if (query.has('location')) {
    await requireBucket(ctx);
    const location =
      (await ctx.store.getBucket(ctx.bucket)).configs.location || '';
    sendXml(
      res,
      200,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<LocationConstraint xmlns="${S3_XMLNS}">${escapeXml(location)}</LocationConstraint>`
    );
    return;
  }
  if (query.has('acl')) {
    const meta = await requireBucket(ctx);
    sendXml(res, 200, aclXml(meta.configs.acl || ctx.options.defaultBucketAcl));
    return;
  }
  if (query.has('cors')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.cors) {
      throw new S3Error(
        'NoSuchCORSConfiguration',
        'The CORS configuration does not exist',
        {
          BucketName: ctx.bucket,
        }
      );
    }
    sendXml(res, 200, meta.configs.cors.xml);
    return;
  }
  if (query.has('website')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.website) {
      throw new S3Error(
        'NoSuchWebsiteConfiguration',
        'The specified bucket does not have a website configuration',
        { BucketName: ctx.bucket }
      );
    }
    sendXml(res, 200, meta.configs.website.xml);
    return;
  }
  if (query.has('tagging')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.tagging) {
      throw new S3Error('NoSuchTagSet', 'The TagSet does not exist', {
        BucketName: ctx.bucket,
      });
    }
    sendXml(res, 200, meta.configs.tagging.xml);
    return;
  }
  if (query.has('versioning')) {
    const meta = await requireBucket(ctx);
    sendDoc(
      res,
      200,
      'VersioningConfiguration',
      meta.configs.versioning ? { Status: meta.configs.versioning } : {}
    );
    return;
  }
  if (query.has('versions')) {
    await listObjectVersions(ctx);
    return;
  }
  if (query.has('uploads')) {
    await listMultipartUploads(ctx);
    return;
  }
  if (query.has('policy')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.policy) {
      throw new S3Error(
        'NoSuchBucketPolicy',
        'The bucket policy does not exist',
        {
          BucketName: ctx.bucket,
        }
      );
    }
    send(
      res,
      200,
      { 'Content-Type': 'application/json' },
      meta.configs.policy.json
    );
    return;
  }
  if (query.has('lifecycle')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.lifecycle) {
      throw new S3Error(
        'NoSuchLifecycleConfiguration',
        'The lifecycle configuration does not exist'
      );
    }
    sendXml(res, 200, meta.configs.lifecycle.xml);
    return;
  }
  if (query.has('encryption')) {
    await requireBucket(ctx);
    sendDoc(res, 200, 'ServerSideEncryptionConfiguration', {
      Rule: {
        ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        BucketKeyEnabled: false,
      },
    });
    return;
  }
  if (query.has('object-lock')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.objectLock) {
      throw new S3Error(
        'ObjectLockConfigurationNotFoundError',
        'Object Lock configuration does not exist for this bucket',
        { statusCode: 404, BucketName: ctx.bucket }
      );
    }
    const lock = meta.configs.objectLock;
    sendDoc(res, 200, 'ObjectLockConfiguration', {
      ObjectLockEnabled: 'Enabled',
      Rule: lock.defaultMode
        ? {
            DefaultRetention: {
              Mode: lock.defaultMode,
              Days: lock.defaultRetentionDays,
            },
          }
        : undefined,
    });
    return;
  }
  if (query.has('publicAccessBlock')) {
    await requireBucket(ctx);
    throw new S3Error(
      'NoSuchPublicAccessBlockConfiguration',
      'The public access block configuration was not found',
      { statusCode: 404 }
    );
  }
  if (query.has('notification')) {
    await requireBucket(ctx);
    sendDoc(res, 200, 'NotificationConfiguration', {});
    return;
  }
  if (query.has('requestPayment')) {
    await requireBucket(ctx);
    sendDoc(res, 200, 'RequestPaymentConfiguration', { Payer: 'BucketOwner' });
    return;
  }
  if (query.has('logging')) {
    await requireBucket(ctx);
    sendDoc(res, 200, 'BucketLoggingStatus', {});
    return;
  }
  if (query.has('accelerate')) {
    await requireBucket(ctx);
    sendDoc(res, 200, 'AccelerateConfiguration', {});
    return;
  }
  if (query.get('list-type') === '2') {
    await listObjectsV2(ctx);
    return;
  }
  await listObjectsV1(ctx);
}

async function listObjectsV1(ctx) {
  await requireBucket(ctx);
  await ctx.store.applyLifecycle(ctx.bucket);
  const params = parseListParams(ctx.query);
  const marker = ctx.query.get('marker') || '';
  const metas = await ctx.store.listObjects(ctx.bucket);
  const page = paginate(metas, { ...params, marker });

  const result = {
    Name: ctx.bucket,
    Prefix: encodeListValue(params.prefix, params.encodingType) || '',
    Marker: encodeListValue(marker, params.encodingType) || '',
    MaxKeys: params.maxKeys,
    EncodingType: params.encodingType,
    Delimiter:
      encodeListValue(params.delimiter, params.encodingType) || undefined,
    IsTruncated: page.truncated,
    Contents: page.contents.map((meta) =>
      contentsEntry(meta, params.encodingType)
    ),
    CommonPrefixes: page.prefixes.map((prefix) => ({
      Prefix: encodeListValue(prefix, params.encodingType),
    })),
  };
  if (page.truncated && params.delimiter) {
    result.NextMarker = encodeListValue(page.lastItem, params.encodingType);
  }
  sendDoc(ctx.res, 200, 'ListBucketResult', result);
}

async function listObjectsV2(ctx) {
  await requireBucket(ctx);
  await ctx.store.applyLifecycle(ctx.bucket);
  const params = parseListParams(ctx.query);
  const token = ctx.query.get('continuation-token');
  const startAfter = ctx.query.get('start-after') || '';
  const fetchOwner = ctx.query.get('fetch-owner') === 'true';
  let marker = startAfter;
  if (token) {
    try {
      marker = Buffer.from(token, 'base64').toString('utf8');
    } catch {
      throw new S3Error(
        'InvalidArgument',
        'The continuation token provided is incorrect'
      );
    }
  }
  const metas = await ctx.store.listObjects(ctx.bucket);
  const page = paginate(metas, { ...params, marker });

  const result = {
    Name: ctx.bucket,
    Prefix: encodeListValue(params.prefix, params.encodingType) || '',
    MaxKeys: params.maxKeys,
    EncodingType: params.encodingType,
    Delimiter:
      encodeListValue(params.delimiter, params.encodingType) || undefined,
    KeyCount: page.contents.length + page.prefixes.length,
    IsTruncated: page.truncated,
    ContinuationToken: token || undefined,
    StartAfter: encodeListValue(startAfter, params.encodingType) || undefined,
    Contents: page.contents.map((meta) =>
      contentsEntry(meta, params.encodingType, { owner: fetchOwner })
    ),
    CommonPrefixes: page.prefixes.map((prefix) => ({
      Prefix: encodeListValue(prefix, params.encodingType),
    })),
  };
  if (page.truncated) {
    result.NextContinuationToken = Buffer.from(page.lastItem, 'utf8').toString(
      'base64'
    );
  }
  sendDoc(ctx.res, 200, 'ListBucketResult', result);
}

async function listObjectVersions(ctx) {
  await requireBucket(ctx);
  await ctx.store.applyLifecycle(ctx.bucket);
  const params = parseListParams(ctx.query);
  const marker = ctx.query.get('key-marker') || '';

  // flatten version chains, group delimiter matches into common prefixes
  const all = (await ctx.store.listVersions(ctx.bucket)).filter(
    (meta) =>
      (!params.prefix || meta.key.startsWith(params.prefix)) &&
      (!marker || meta.key > marker)
  );
  const entries = [];
  const prefixes = [];
  const seenPrefixes = new Set();
  for (const meta of all) {
    if (params.delimiter) {
      const rest = meta.key.slice(params.prefix.length);
      const idx = rest.indexOf(params.delimiter);
      if (idx !== -1) {
        const commonPrefix =
          params.prefix + rest.slice(0, idx + params.delimiter.length);
        if (!seenPrefixes.has(commonPrefix)) {
          seenPrefixes.add(commonPrefix);
          prefixes.push(commonPrefix);
        }
        continue;
      }
    }
    entries.push(meta);
  }
  const page = entries.slice(0, params.maxKeys);
  const truncated = entries.length > page.length;

  const entryXml = (meta) => ({
    Key: encodeListValue(meta.key, params.encodingType),
    VersionId: meta.versionId || 'null',
    IsLatest: Boolean(meta.isLatest),
    LastModified: isoDate(meta.lastModified),
    Owner: DUMMY_OWNER,
  });

  const result = {
    Name: ctx.bucket,
    Prefix: encodeListValue(params.prefix, params.encodingType) || '',
    KeyMarker: encodeListValue(marker, params.encodingType) || '',
    VersionIdMarker: '',
    MaxKeys: params.maxKeys,
    EncodingType: params.encodingType,
    Delimiter:
      encodeListValue(params.delimiter, params.encodingType) || undefined,
    IsTruncated: truncated,
    Version: page
      .filter((meta) => !meta.isDeleteMarker)
      .map((meta) => ({
        ...entryXml(meta),
        ETag: `"${meta.etag}"`,
        Size: meta.size,
        StorageClass: meta.storageClass || 'STANDARD',
      })),
    DeleteMarker: page
      .filter((meta) => meta.isDeleteMarker)
      .map((meta) => entryXml(meta)),
    CommonPrefixes: prefixes.map((prefix) => ({
      Prefix: encodeListValue(prefix, params.encodingType),
    })),
  };
  if (truncated) {
    const last = page[page.length - 1];
    result.NextKeyMarker = encodeListValue(last.key, params.encodingType);
    result.NextVersionIdMarker = last.versionId || 'null';
  }
  sendDoc(ctx.res, 200, 'ListVersionsResult', result);
}

async function listMultipartUploads(ctx) {
  await requireBucket(ctx);
  const params = parseListParams(ctx.query);
  const keyMarker = ctx.query.get('key-marker') || '';
  const uploads = (await ctx.store.listUploads(ctx.bucket)).filter(
    (upload) =>
      (!params.prefix || upload.key.startsWith(params.prefix)) &&
      (!keyMarker || upload.key > keyMarker)
  );
  const maxUploads = Math.min(
    parseInt(ctx.query.get('max-uploads') || '1000', 10) || 1000,
    1000
  );
  const page = uploads.slice(0, maxUploads);
  const truncated = uploads.length > page.length;

  sendDoc(ctx.res, 200, 'ListMultipartUploadsResult', {
    Bucket: ctx.bucket,
    KeyMarker: keyMarker,
    UploadIdMarker: '',
    NextKeyMarker: truncated ? page[page.length - 1].key : undefined,
    NextUploadIdMarker: truncated ? page[page.length - 1].uploadId : undefined,
    Prefix: encodeListValue(params.prefix, params.encodingType) || '',
    Delimiter:
      encodeListValue(params.delimiter, params.encodingType) || undefined,
    EncodingType: params.encodingType,
    MaxUploads: maxUploads,
    IsTruncated: truncated,
    Upload: page.map((upload) => ({
      Key: encodeListValue(upload.key, params.encodingType),
      UploadId: upload.uploadId,
      Initiator: DUMMY_OWNER,
      Owner: DUMMY_OWNER,
      StorageClass: upload.storageClass || 'STANDARD',
      Initiated: isoDate(upload.initiated),
      ChecksumAlgorithm: upload.checksumAlgorithm,
      ChecksumType: upload.checksumType,
    })),
  });
}

// ---------------------------------------------------------------- PUT

const SUPPORTED_CORS_METHODS = new Set([
  'GET',
  'PUT',
  'POST',
  'DELETE',
  'HEAD',
]);

function parseCorsConfig(xmlString) {
  let parsed;
  try {
    parsed = parseXml(xmlString);
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  if (!parsed.CORSConfiguration) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const rules = asArray(parsed.CORSConfiguration.CORSRule).map((rule) => {
    const allowedMethods = asArray(rule.AllowedMethod);
    for (const method of allowedMethods) {
      if (!SUPPORTED_CORS_METHODS.has(method)) {
        throw new S3Error(
          'InvalidRequest',
          `Found unsupported HTTP method in CORS config. Unsupported method is ${method}`
        );
      }
    }
    return {
      allowedOrigins: asArray(rule.AllowedOrigin),
      allowedMethods,
      allowedHeaders: asArray(rule.AllowedHeader).map((header) =>
        header.toLowerCase()
      ),
      exposeHeaders: asArray(rule.ExposeHeader),
      maxAgeSeconds: rule.MaxAgeSeconds
        ? parseInt(rule.MaxAgeSeconds, 10)
        : undefined,
    };
  });
  if (rules.length === 0) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  return { xml: xmlString, rules };
}

function parseWebsiteConfig(xmlString) {
  let parsed;
  try {
    parsed = parseXml(xmlString);
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const config = parsed.WebsiteConfiguration;
  if (!config) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const website = { xml: xmlString };
  if (config.RedirectAllRequestsTo) {
    website.redirectAllRequestsTo = {
      hostName: config.RedirectAllRequestsTo.HostName,
      protocol: config.RedirectAllRequestsTo.Protocol || 'http',
    };
    return website;
  }
  if (!config.IndexDocument || !config.IndexDocument.Suffix) {
    throw new S3Error(
      'InvalidArgument',
      'A value for IndexDocument Suffix must be provided if RedirectAllRequestsTo is empty'
    );
  }
  website.indexDocument = config.IndexDocument.Suffix;
  if (config.ErrorDocument) website.errorDocument = config.ErrorDocument.Key;
  return website;
}

function parseLifecycleConfig(xmlString) {
  let parsed;
  try {
    parsed = parseXml(xmlString);
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const config = parsed.LifecycleConfiguration;
  if (!config) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const rules = asArray(config.Rule).map((rule) => {
    const status = rule.Status;
    if (status !== 'Enabled' && status !== 'Disabled') {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
    const filterPrefix =
      (rule.Filter && typeof rule.Filter === 'object'
        ? rule.Filter.Prefix
        : rule.Filter) ?? rule.Prefix;
    const expiration = rule.Expiration || {};
    const noncurrent = rule.NoncurrentVersionExpiration || {};
    return {
      id: typeof rule.ID === 'string' ? rule.ID : undefined,
      status,
      prefix: typeof filterPrefix === 'string' ? filterPrefix : '',
      expirationDays:
        expiration.Days !== undefined
          ? parseInt(expiration.Days, 10)
          : undefined,
      expirationDate:
        expiration.Date !== undefined ? Date.parse(expiration.Date) : undefined,
      expiredObjectDeleteMarker:
        expiration.ExpiredObjectDeleteMarker === 'true',
      noncurrentDays:
        noncurrent.NoncurrentDays !== undefined
          ? parseInt(noncurrent.NoncurrentDays, 10)
          : undefined,
    };
  });
  if (rules.length === 0) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  return { xml: xmlString, rules };
}

function parseObjectLockConfig(xmlString) {
  let parsed;
  try {
    parsed = parseXml(xmlString);
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const config = parsed.ObjectLockConfiguration;
  if (!config || config.ObjectLockEnabled !== 'Enabled') {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const result = {};
  const retention = config.Rule && config.Rule.DefaultRetention;
  if (retention) {
    const mode = String(retention.Mode || '').toUpperCase();
    if (mode !== 'GOVERNANCE' && mode !== 'COMPLIANCE') {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
    result.defaultMode = mode;
    result.defaultRetentionDays =
      retention.Days !== undefined
        ? parseInt(retention.Days, 10)
        : parseInt(retention.Years, 10) * 365;
    if (!Number.isInteger(result.defaultRetentionDays)) {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
  }
  return result;
}

function parseTaggingConfig(xmlString) {
  let parsed;
  try {
    parsed = parseXml(xmlString);
  } catch {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const tagging = parsed.Tagging;
  if (!tagging || !tagging.TagSet) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema'
    );
  }
  const tags = {};
  for (const tag of asArray(tagging.TagSet.Tag)) {
    if (typeof tag.Key !== 'string') {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
    tags[tag.Key] = typeof tag.Value === 'string' ? tag.Value : '';
  }
  return { xml: xmlString, tags };
}

async function putBucket(ctx) {
  const { query, res } = ctx;

  if (query.has('cors')) {
    await requireBucket(ctx);
    const body = await readBody(ctx.req);
    const config = parseCorsConfig(body.toString('utf8'));
    await ctx.store.putBucketConfig(ctx.bucket, 'cors', config);
    send(res, 200, {});
    return;
  }
  if (query.has('website')) {
    await requireBucket(ctx);
    const body = await readBody(ctx.req);
    const config = parseWebsiteConfig(body.toString('utf8'));
    await ctx.store.putBucketConfig(ctx.bucket, 'website', config);
    send(res, 200, {});
    return;
  }
  if (query.has('tagging')) {
    await requireBucket(ctx);
    const body = await readBody(ctx.req);
    const config = parseTaggingConfig(body.toString('utf8'));
    await ctx.store.putBucketConfig(ctx.bucket, 'tagging', config);
    send(res, 204, {});
    return;
  }
  if (query.has('acl')) {
    await requireBucket(ctx);
    await readBody(ctx.req);
    const acl = ctx.req.headers['x-amz-acl'];
    if (acl) {
      await ctx.store.putBucketConfig(
        ctx.bucket,
        'acl',
        validateCannedAcl(String(acl))
      );
    }
    send(res, 200, {});
    return;
  }
  if (query.has('policy')) {
    await requireBucket(ctx);
    const body = await readBody(ctx.req);
    const { parseBucketPolicy } = require('../models/policy');
    const policy = parseBucketPolicy(body.toString('utf8'));
    await ctx.store.putBucketConfig(ctx.bucket, 'policy', policy);
    send(res, 204, {});
    return;
  }
  if (query.has('versioning')) {
    const meta = await requireBucket(ctx);
    const body = await readBody(ctx.req);
    let status;
    try {
      status = parseXml(body.toString('utf8')).VersioningConfiguration?.Status;
    } catch {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
    if (status !== 'Enabled' && status !== 'Suspended') {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
    if (status === 'Suspended' && meta.configs.objectLock) {
      throw new S3Error(
        'InvalidBucketState',
        'An Object Lock configuration is present on this bucket, so the versioning state cannot be changed.',
        { statusCode: 409 }
      );
    }
    await ctx.store.putBucketConfig(ctx.bucket, 'versioning', status);
    send(res, 200, {});
    return;
  }
  if (query.has('lifecycle')) {
    await requireBucket(ctx);
    const body = await readBody(ctx.req);
    const config = parseLifecycleConfig(body.toString('utf8'));
    await ctx.store.putBucketConfig(ctx.bucket, 'lifecycle', config);
    send(res, 200, {});
    return;
  }
  if (query.has('object-lock')) {
    const meta = await requireBucket(ctx);
    if (!meta.configs.objectLock && meta.configs.versioning !== 'Enabled') {
      throw new S3Error(
        'InvalidBucketState',
        'Object Lock configuration cannot be enabled on existing buckets without versioning',
        { statusCode: 409 }
      );
    }
    const body = await readBody(ctx.req);
    const config = parseObjectLockConfig(body.toString('utf8'));
    await ctx.store.putBucketConfig(ctx.bucket, 'objectLock', config);
    // object lock pins versioning on
    await ctx.store.putBucketConfig(ctx.bucket, 'versioning', 'Enabled');
    send(res, 200, {});
    return;
  }
  const knownUnsupported = [
    'encryption',
    'publicAccessBlock',
    'notification',
    'replication',
    'requestPayment',
    'logging',
    'accelerate',
    'analytics',
    'metrics',
    'inventory',
    'intelligent-tiering',
    'ownershipControls',
  ];
  for (const subresource of knownUnsupported) {
    if (query.has(subresource)) {
      await readBody(ctx.req);
      // Accept and ignore so provisioning scripts keep working.
      send(res, 200, {});
      return;
    }
  }

  // CreateBucket
  validateBucketName(ctx.bucket);
  const body = await readBody(ctx.req);
  let location;
  if (body.length > 0) {
    try {
      const parsed = parseXml(body.toString('utf8'));
      location =
        parsed.CreateBucketConfiguration?.LocationConstraint || undefined;
      if (location && typeof location !== 'string') location = undefined;
    } catch {
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema'
      );
    }
  }
  if (
    ctx.options.enforceRegion &&
    location &&
    location !== ctx.options.region
  ) {
    throw new S3Error(
      'IllegalLocationConstraintException',
      `The ${location} location constraint is incompatible for the region specific endpoint this request was sent to.`,
      { statusCode: 400 }
    );
  }
  const acl = ctx.req.headers['x-amz-acl'];
  if (acl) validateCannedAcl(String(acl));
  const lockEnabled =
    String(
      ctx.req.headers['x-amz-bucket-object-lock-enabled'] || ''
    ).toLowerCase() === 'true';
  const { created } = await ctx.store.createBucket(ctx.bucket);
  if (created && lockEnabled) {
    // object lock requires (and pins) versioning
    await ctx.store.putBucketConfig(ctx.bucket, 'versioning', 'Enabled');
    await ctx.store.putBucketConfig(ctx.bucket, 'objectLock', {});
  }
  if (created && location) {
    await ctx.store.putBucketConfig(ctx.bucket, 'location', location);
  }
  if (created && acl) {
    await ctx.store.putBucketConfig(ctx.bucket, 'acl', String(acl));
  }
  // Matching us-east-1 behavior: re-creating a bucket you own succeeds.
  send(ctx.res, 200, { Location: `/${ctx.bucket}` });
}

// ---------------------------------------------------------------- DELETE

async function deleteBucket(ctx) {
  const { query, res } = ctx;
  const configSubresources = {
    cors: 'cors',
    website: 'website',
    tagging: 'tagging',
    lifecycle: 'lifecycle',
    policy: 'policy',
    encryption: null,
    publicAccessBlock: null,
    replication: null,
  };
  for (const [subresource, configKey] of Object.entries(configSubresources)) {
    if (query.has(subresource)) {
      await requireBucket(ctx);
      if (configKey)
        await ctx.store.putBucketConfig(ctx.bucket, configKey, null);
      send(res, 204, {});
      return;
    }
  }
  await requireBucket(ctx);
  const result = await ctx.store.deleteBucket(ctx.bucket);
  if (!result.deleted) {
    throw new S3Error(
      'BucketNotEmpty',
      'The bucket you tried to delete is not empty',
      {
        BucketName: ctx.bucket,
      }
    );
  }
  send(res, 204, {});
}

// ---------------------------------------------------------------- HEAD

async function headBucket(ctx) {
  const meta = await ctx.store.getBucket(ctx.bucket);
  if (!meta) {
    send(ctx.res, 404, {});
    return;
  }
  send(ctx.res, 200, {
    'x-amz-bucket-region': meta.configs.location || ctx.options.region,
  });
}

module.exports = {
  requireBucket,
  getBucket,
  putBucket,
  deleteBucket,
  headBucket,
  dummyAclXml,
  validateCannedAcl,
  parseCorsConfig,
  parseWebsiteConfig,
  parseTaggingConfig,
};
