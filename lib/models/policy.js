'use strict';

const { S3Error } = require('./error');

/**
 * A small subset of S3 bucket policies, used to grant anonymous access per
 * key prefix (e.g. make only `public/*` readable without signing).
 *
 * Supported: Effect Allow/Deny, Principal "*" (or {"AWS": "*"}), Action
 * strings with wildcards (s3:GetObject, s3:ListBucket, s3:PutObject,
 * s3:DeleteObject, s3:*), Resource ARNs with * and ? wildcards.
 *
 * Statements with other principals are stored but never match anonymous
 * requests. Signed requests always have full access, so policies only widen
 * or narrow what anonymous callers may do.
 */

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function malformed(message) {
  return new S3Error('MalformedPolicy', message, { statusCode: 400 });
}

const UNSUPPORTED_FIELDS = [
  'NotAction',
  'NotResource',
  'NotPrincipal',
  'Condition',
];

function parseBucketPolicy(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw malformed('Policies must be valid JSON and the first byte must be {');
  }
  const rawStatements = asList(doc.Statement);
  if (rawStatements.length === 0) {
    throw malformed('Missing required field Statement');
  }
  const statements = rawStatements.map((statement) => {
    if (typeof statement !== 'object' || statement === null) {
      throw malformed('Statement must be an object or an array of objects');
    }
    for (const field of UNSUPPORTED_FIELDS) {
      if (statement[field] !== undefined) {
        throw new S3Error(
          'NotImplemented',
          `Bucket policy element ${field} is not supported by this server`
        );
      }
    }
    const effect = statement.Effect;
    if (effect !== 'Allow' && effect !== 'Deny') {
      throw malformed('Statement Effect must be Allow or Deny');
    }
    let principals;
    if (statement.Principal === '*') {
      principals = ['*'];
    } else if (statement.Principal && typeof statement.Principal === 'object') {
      principals = asList(statement.Principal.AWS).map(String);
    } else if (statement.Principal === undefined) {
      throw malformed('Missing required field Principal');
    } else {
      principals = [String(statement.Principal)];
    }
    const actions = asList(statement.Action).map((action) =>
      String(action).toLowerCase()
    );
    if (actions.length === 0) {
      throw malformed('Missing required field Action');
    }
    const resources = asList(statement.Resource).map(String);
    if (resources.length === 0) {
      throw malformed('Missing required field Resource');
    }
    return { effect, principals, actions, resources };
  });
  return {
    json: typeof text === 'string' ? text : JSON.stringify(doc),
    statements,
  };
}

function wildcardMatch(pattern, value) {
  const regex = new RegExp(
    '^' +
      String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return regex.test(value);
}

/**
 * Evaluates a parsed policy for an anonymous request.
 * Returns 'deny', 'allow' or 'none' (no matching statement).
 */
function evaluateBucketPolicy(policy, action, resource) {
  const wantedAction = action.toLowerCase();
  let allowed = false;
  for (const statement of policy.statements) {
    if (!statement.principals.includes('*')) continue;
    const actionMatches = statement.actions.some((pattern) =>
      wildcardMatch(pattern, wantedAction)
    );
    const resourceMatches = statement.resources.some((pattern) =>
      wildcardMatch(pattern, resource)
    );
    if (actionMatches && resourceMatches) {
      if (statement.effect === 'Deny') return 'deny';
      allowed = true;
    }
  }
  return allowed ? 'allow' : 'none';
}

module.exports = { parseBucketPolicy, evaluateBucketPolicy };
