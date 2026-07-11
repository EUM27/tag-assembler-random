(function attachAssetStoreCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerAssetStore = api;
})(typeof globalThis === 'object' ? globalThis : this, function createAssetStoreCore() {
  'use strict';

  const SHA256_PREFIX = 'sha256:';
  const MEDIA_TYPE_PATTERN = /^image\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

  function copyBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    throw new TypeError('Asset bytes must be an ArrayBuffer or an ArrayBuffer view.');
  }

  function digestToHex(digest) {
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function sha256Identity(value) {
    const bytes = copyBytes(value);
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('SHA-256 is unavailable in this runtime.');
    const digest = await subtle.digest('SHA-256', bytes);
    return `${SHA256_PREFIX}${digestToHex(digest)}`;
  }

  async function prepareOriginal(value, options = {}) {
    const bytes = copyBytes(value);
    const mediaType = String(options.mediaType || '').trim().toLowerCase();
    if (!MEDIA_TYPE_PATTERN.test(mediaType)) throw new TypeError('Original assets require a valid image media type.');
    const assetId = await sha256Identity(bytes);
    const sha256 = assetId.slice(SHA256_PREFIX.length);
    return Object.freeze({
      assetId,
      sha256,
      byteLength: bytes.byteLength,
      mediaType,
      role: 'original',
      readBytes: () => Uint8Array.from(bytes),
    });
  }

  function selectOriginal(value) {
    const original = value && typeof value === 'object' ? value.original : null;
    return original && original.role === 'original' ? original : null;
  }

  function normalizedReferenceIds(preset) {
    const source = preset && typeof preset === 'object' ? preset : {};
    const references = new Set();
    for (const values of [source.imageIds, source.likedImageIds]) {
      for (const value of Array.isArray(values) ? values : []) {
        const assetId = typeof value === 'string' ? value.trim() : '';
        if (assetId) references.add(assetId);
      }
    }
    return references;
  }

  function countReferences(presets) {
    const counts = {};
    for (const preset of Array.isArray(presets) ? presets : []) {
      for (const assetId of normalizedReferenceIds(preset)) {
        counts[assetId] = (counts[assetId] || 0) + 1;
      }
    }
    return counts;
  }

  function planRetention(assetIds, presets) {
    const counts = countReferences(presets);
    const referenced = [];
    const quarantine = [];
    const seen = new Set();
    for (const value of Array.isArray(assetIds) ? assetIds : []) {
      const assetId = typeof value === 'string' ? value.trim() : '';
      if (!assetId || seen.has(assetId)) continue;
      seen.add(assetId);
      const refCount = counts[assetId] || 0;
      const entry = Object.freeze({ assetId, refCount });
      if (refCount > 0) referenced.push(entry);
      else quarantine.push(entry);
    }
    return Object.freeze({
      referenced: Object.freeze(referenced),
      quarantine: Object.freeze(quarantine),
      delete: Object.freeze([]),
    });
  }

  return Object.freeze({
    SHA256_PREFIX,
    countReferences,
    planRetention,
    prepareOriginal,
    selectOriginal,
    sha256Identity,
  });
});
