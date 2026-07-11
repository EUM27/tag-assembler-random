(function attachCustomThumbStoreCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerCustomThumbStore = api;
})(typeof globalThis === 'object' ? globalThis : this, function createCustomThumbStoreCore() {
  'use strict';

  const MANIFEST_KEY = 'TAG_ASSEMBLER_CUSTOM_THUMB_MANIFEST_V1';
  const MANIFEST_SCHEMA = 'tag-assembler-custom-thumb-manifest-v1';
  const ASSET_SCHEMA = 'tag-assembler-custom-thumb-asset-v1';
  const ASSET_KEY_PREFIX = 'TAG_ASSEMBLER_CUSTOM_THUMB_ASSET_V1:';
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;

  function emptyManifest() {
    return { schema: MANIFEST_SCHEMA, entries: {}, tombstones: {} };
  }

  function normalizeManifest(value) {
    const source = value && typeof value === 'object' && value.schema === MANIFEST_SCHEMA ? value : {};
    const entries = {};
    for (const [artistKey, raw] of Object.entries(source.entries || {})) {
      const assetKey = String(raw?.assetKey || '').trim();
      const sha256 = String(raw?.sha256 || '').trim().toLowerCase();
      const size = Number(raw?.size);
      const mediaType = String(raw?.mediaType || '').trim().toLowerCase();
      if (artistKey && assetKey === `${ASSET_KEY_PREFIX}${sha256}` && SHA256_PATTERN.test(sha256) && Number.isSafeInteger(size) && size > 0 && mediaType) {
        entries[artistKey] = { assetKey, sha256, size, mediaType };
      }
    }
    const tombstones = {};
    for (const artistKey of Object.keys(source.tombstones || {})) {
      if (artistKey) tombstones[artistKey] = true;
    }
    return { schema: MANIFEST_SCHEMA, entries, tombstones };
  }

  function decodeDataUrl(value) {
    const text = String(value || '');
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(text);
    if (!match) return null;
    const binary = atob(match[2].replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (!bytes.length) return null;
    return { dataUrl: text, mediaType: match[1].toLowerCase(), bytes };
  }

  async function sha256Hex(bytes) {
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this runtime.');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function fingerprintDataUrl(value) {
    const decoded = decodeDataUrl(value);
    if (!decoded) return null;
    const sha256 = await sha256Hex(decoded.bytes);
    return {
      sha256,
      size: decoded.bytes.length,
      mediaType: decoded.mediaType,
      dataUrl: decoded.dataUrl,
      assetKey: `${ASSET_KEY_PREFIX}${sha256}`,
    };
  }

  async function planUpsert(manifestValue, artistKeyValue, dataUrl) {
    const artistKey = String(artistKeyValue || '').trim();
    if (!artistKey) throw new TypeError('Custom thumbnail artist key is required.');
    const fingerprint = await fingerprintDataUrl(dataUrl);
    if (!fingerprint) throw new TypeError('Custom thumbnail must be a non-empty base64 data URL.');
    const manifest = normalizeManifest(manifestValue);
    manifest.entries[artistKey] = {
      assetKey: fingerprint.assetKey,
      sha256: fingerprint.sha256,
      size: fingerprint.size,
      mediaType: fingerprint.mediaType,
    };
    delete manifest.tombstones[artistKey];
    const assetRecord = {
      schema: ASSET_SCHEMA,
      sha256: fingerprint.sha256,
      size: fingerprint.size,
      mediaType: fingerprint.mediaType,
      dataUrl: fingerprint.dataUrl,
    };
    return {
      manifest,
      assetKey: fingerprint.assetKey,
      writes: [
        { key: fingerprint.assetKey, value: assetRecord },
        { key: MANIFEST_KEY, value: manifest },
      ],
    };
  }

  function planDelete(manifestValue, artistKeyValue) {
    const artistKey = String(artistKeyValue || '').trim();
    if (!artistKey) throw new TypeError('Custom thumbnail artist key is required.');
    const manifest = normalizeManifest(manifestValue);
    delete manifest.entries[artistKey];
    manifest.tombstones[artistKey] = true;
    return { manifest, writes: [{ key: MANIFEST_KEY, value: manifest }] };
  }

  function composeView(options = {}) {
    const view = new Map(Object.entries(options.legacy && typeof options.legacy === 'object' ? options.legacy : {}));
    const manifest = normalizeManifest(options.manifest);
    const records = options.recordsByKey instanceof Map
      ? options.recordsByKey
      : new Map(Object.entries(options.recordsByKey || {}));
    for (const artistKey of Object.keys(manifest.tombstones)) view.delete(artistKey);
    for (const [artistKey, entry] of Object.entries(manifest.entries)) {
      const record = records.get(entry.assetKey);
      if (record?.schema === ASSET_SCHEMA
        && record.sha256 === entry.sha256
        && record.size === entry.size
        && record.mediaType === entry.mediaType
        && typeof record.dataUrl === 'string') {
        view.set(artistKey, record.dataUrl);
      }
    }
    return view;
  }

  return Object.freeze({
    ASSET_KEY_PREFIX,
    MANIFEST_KEY,
    composeView,
    emptyManifest,
    fingerprintDataUrl,
    normalizeManifest,
    planDelete,
    planUpsert,
  });
});
