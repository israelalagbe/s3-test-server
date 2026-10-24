'use strict';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return match;
    }
  });
}

/**
 * Serialize a plain JS structure to XML.
 *   buildXml('Foo', { Bar: 1, Baz: ['a', 'b'] })
 *     → <?xml ...?><Foo><Bar>1</Bar><Baz>a</Baz><Baz>b</Baz></Foo>
 * null/undefined values are skipped; `{}` renders an empty element;
 * Date values render as ISO strings.
 */
function buildXml(rootName, content, { xmlns } = {}) {
  const serialize = (name, value) => {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
      return value.map((item) => serialize(name, item)).join('');
    }
    let inner;
    if (value instanceof Date) {
      inner = value.toISOString();
    } else if (typeof value === 'object') {
      inner = Object.entries(value)
        .map(([childName, childValue]) => serialize(childName, childValue))
        .join('');
    } else {
      inner = escapeXml(value);
    }
    return `<${name}>${inner}</${name}>`;
  };

  let innerXml;
  if (
    content &&
    typeof content === 'object' &&
    !(content instanceof Date) &&
    !Array.isArray(content)
  ) {
    innerXml = Object.entries(content)
      .map(([name, value]) => serialize(name, value))
      .join('');
  } else {
    innerXml =
      content === undefined || content === null ? '' : escapeXml(content);
  }
  const nsAttr = xmlns ? ` xmlns="${xmlns}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}${nsAttr}>${innerXml}</${rootName}>`;
}

const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

/**
 * A deliberately small XML parser sufficient for the element-only documents
 * S3 clients send (CompleteMultipartUpload, Delete, Tagging, CORS, Website…).
 * Attributes are ignored. Repeated sibling elements become arrays.
 * Returns `{ [rootName]: value }` where value is a string (text-only element)
 * or a nested object. Throws on malformed input.
 */
function parseXml(input) {
  const xml = String(input);
  const tokenRe =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\?[\s\S]*?\?>|<\/\s*([^>\s]+)\s*>|<([^>/\s]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

  const root = { name: null, children: [], text: '' };
  const stack = [root];
  let match;
  let consumed = 0;

  while ((match = tokenRe.exec(xml)) !== null) {
    if (match.index !== consumed) {
      throw new Error(`Unexpected content in XML at offset ${consumed}`);
    }
    consumed = tokenRe.lastIndex;
    const [, cdata, closeName, openName, , selfClose, text] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) {
      top.text += cdata;
    } else if (text !== undefined) {
      top.text += decodeEntities(text);
    } else if (openName !== undefined) {
      const node = { name: stripNs(openName), children: [], text: '' };
      top.children.push(node);
      if (!selfClose) stack.push(node);
    } else if (closeName !== undefined) {
      const node = stack.pop();
      if (!node || node.name !== stripNs(closeName)) {
        throw new Error(`Mismatched closing tag </${closeName}>`);
      }
    }
  }
  if (consumed !== xml.length || stack.length !== 1) {
    throw new Error('Malformed XML document');
  }
  const rootNode = root.children.find((child) => child.name);
  if (!rootNode) throw new Error('XML document has no root element');
  return { [rootNode.name]: collapse(rootNode) };
}

function stripNs(name) {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

function collapse(node) {
  if (node.children.length === 0) {
    return node.text;
  }
  const result = {};
  for (const child of node.children) {
    const value = collapse(child);
    if (Object.prototype.hasOwnProperty.call(result, child.name)) {
      if (!Array.isArray(result[child.name])) {
        result[child.name] = [result[child.name]];
      }
      result[child.name].push(value);
    } else {
      result[child.name] = value;
    }
  }
  return result;
}

/** Coerce a parsed XML field to an array (missing → [], single → [x]). */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = { escapeXml, buildXml, parseXml, asArray, S3_XMLNS };
