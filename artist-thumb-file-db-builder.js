(function attachArtistThumbFileDbBuilder(root) {
  const LOOKUP_GLOBAL = 'TAG_ASSEMBLER_ARTIST_THUMB_LOOKUP';
  const SCHEMA = 'tag-assembler-artist-thumb-file-db-v1';
  const DATA_URL_RE = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/is;

  function cleanLooseText(value) {
    return String(value || '')
      .replace(/\\([()_])/g, '$1')
      .replace(/[_\s]+/g, ' ')
      .replace(/\s+\)/g, ')')
      .replace(/\(\s+/g, '(')
      .trim();
  }

  function normalizeArtistKey(value) {
    const withoutPrefix = String(value || '').trim().replace(/^artist:\s*/i, '');
    return cleanLooseText(withoutPrefix).toLowerCase();
  }

  function displayArtistName(value) {
    return cleanLooseText(String(value || '').trim().replace(/^artist:\s*/i, ''));
  }

  function safeShardPart(value, fallback) {
    const text = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return text || fallback;
  }

  function shardName(key) {
    const first = safeShardPart(String(key || '').slice(0, 1), 'x').slice(0, 40);
    const second = safeShardPart(String(key || '').slice(0, 2), first).slice(0, 40);
    return `shards/${first}/${second}.json`;
  }

  function imageExtension(mime, payload) {
    const normalized = String(mime || '').toLowerCase();
    const text = String(payload || '').trim();
    if (normalized.includes('png') || text.startsWith('iVBOR')) return 'png';
    if (normalized.includes('webp') || text.startsWith('UklGR')) return 'webp';
    if (normalized.includes('gif') || text.startsWith('R0lGOD')) return 'gif';
    return 'jpg';
  }

  function base64Payload(value) {
    const text = String(value || '').trim();
    const match = DATA_URL_RE.exec(text);
    if (match) {
      return { mime: match[1] || '', payload: match[2] || '' };
    }
    return { mime: '', payload: text };
  }

  function decodeBase64Bytes(value) {
    const { mime, payload } = base64Payload(value);
    const clean = String(payload || '').replace(/\s+/g, '');
    if (!clean) return null;
    if (typeof Buffer !== 'undefined') {
      return {
        bytes: new Uint8Array(Buffer.from(clean, 'base64')),
        mime,
        ext: imageExtension(mime, clean),
      };
    }
    if (typeof root.atob !== 'function') return null;
    const binary = root.atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { bytes, mime, ext: imageExtension(mime, clean) };
  }

  async function sha256Hex(bytes) {
    if (root.crypto?.subtle) {
      const digest = await root.crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    if (typeof require === 'function') {
      const crypto = require('node:crypto');
      return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }
    throw new Error('SHA-256 계산을 지원하지 않습니다.');
  }

  function imagePath(digest, ext) {
    const cleanDigest = String(digest || '').toLowerCase().replace(/[^a-f0-9]/g, '');
    if (!cleanDigest) return '';
    return `images/${cleanDigest.slice(0, 2)}/${cleanDigest}.${ext || 'jpg'}`;
  }

  async function recordFromImageValue(artist, value, options = {}) {
    const key = normalizeArtistKey(artist);
    if (!key) return null;
    const decoded = decodeBase64Bytes(Array.isArray(value) ? value[0] : value);
    if (!decoded?.bytes?.length) return null;
    const digest = options.digest || await sha256Hex(decoded.bytes);
    const path = imagePath(digest, decoded.ext);
    if (!path) return null;
    const displayName = displayArtistName(artist) || key;
    return {
      key,
      image: {
        bytes: decoded.bytes,
        path,
        type: decoded.mime || `image/${decoded.ext === 'jpg' ? 'jpeg' : decoded.ext}`,
      },
      record: {
        artist: displayName,
        path,
        variants: [{ path, source: 0 }],
      },
    };
  }

  function createFileDbCollections(seed = {}) {
    const seededImagePaths = seed.imagePaths
      || Object.values(seed.lookup || {}).map(item => item?.path).filter(Boolean);
    return {
      lookup: { ...(seed.lookup || {}) },
      index: {
        schema: SCHEMA,
        items: { ...(seed.index?.items || seed.index || {}) },
      },
      shards: new Map(seed.shards || []),
      imagePaths: new Set(seededImagePaths),
    };
  }

  function addRecordToCollections(collections, entry) {
    if (!collections || !entry?.key || !entry.record?.path) return false;
    if (collections.lookup[entry.key] || collections.index.items[entry.key]) return false;
    const shard = shardName(entry.key);
    const shardPayload = collections.shards.get(shard) || { items: {} };
    shardPayload.items[entry.key] = entry.record;
    collections.shards.set(shard, shardPayload);
    collections.index.items[entry.key] = {
      artist: entry.record.artist || entry.key,
      shard,
    };
    collections.lookup[entry.key] = {
      artist: entry.record.artist || entry.key,
      path: entry.record.path,
    };
    collections.imagePaths.add(entry.record.path);
    return true;
  }

  function serializeFileDbCollections(collections, options = {}) {
    const lookup = collections?.lookup || {};
    const index = collections?.index || { schema: SCHEMA, items: {} };
    const shards = collections?.shards || new Map();
    const images = collections?.imagePaths || new Set(Object.values(lookup).map(item => item?.path).filter(Boolean));
    return {
      lookup,
      lookupText: `globalThis.${LOOKUP_GLOBAL}=${JSON.stringify(lookup)};`,
      index,
      indexText: JSON.stringify(index),
      shards,
      manifest: {
        schemaVersion: 1,
        status: options.status || 'ready',
        installedAt: options.installedAt || new Date().toISOString(),
        counts: {
          artists: Object.keys(index.items || {}).length,
          images: images.size,
        },
      },
    };
  }

  const api = {
    LOOKUP_GLOBAL,
    SCHEMA,
    normalizeArtistKey,
    displayArtistName,
    shardName,
    decodeBase64Bytes,
    imagePath,
    sha256Hex,
    recordFromImageValue,
    createFileDbCollections,
    addRecordToCollections,
    serializeFileDbCollections,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArtistThumbFileDbBuilder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
