(function attachSavedStoreCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerSavedStore = api;
})(typeof globalThis === 'object' ? globalThis : this, function createSavedStoreCore() {
  'use strict';

  const SCHEMA_VERSION = 2;
  const LEGACY_IMAGE_FIELDS = new Set(['image', 'images', 'likedImages', 'imageRefs']);
  const DATA_IMAGE_PATTERN = /^data:image\//i;
  const OMIT = Symbol('omit');

  function normalizeIds(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = typeof value === 'string' ? value.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function sanitizeMetadataValue(value, ancestors) {
    if (typeof value === 'string') {
      const normalized = value.trim();
      return DATA_IMAGE_PATTERN.test(normalized) ? OMIT : normalized;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT;
    if (!value || typeof value !== 'object') return OMIT;
    if (ancestors.has(value)) return OMIT;

    ancestors.add(value);
    let normalized;
    if (Array.isArray(value)) {
      normalized = [];
      for (const item of value) {
        const clean = sanitizeMetadataValue(item, ancestors);
        if (clean !== OMIT) normalized.push(clean);
      }
    } else {
      normalized = {};
      for (const [key, item] of Object.entries(value)) {
        if (LEGACY_IMAGE_FIELDS.has(key)) continue;
        const clean = sanitizeMetadataValue(item, ancestors);
        if (clean !== OMIT) normalized[key] = clean;
      }
    }
    ancestors.delete(value);
    return normalized;
  }

  function normalizeMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized = sanitizeMetadataValue(value, new Set());
    return normalized === OMIT ? {} : normalized;
  }

  function normalizePreset(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      metadata: normalizeMetadata(source.metadata),
      imageIds: normalizeIds(source.imageIds),
      likedImageIds: normalizeIds(source.likedImageIds),
    };
  }

  function serializePreset(value) {
    return JSON.stringify(normalizePreset(value));
  }

  return Object.freeze({
    SCHEMA_VERSION,
    normalizeIds,
    normalizeMetadata,
    normalizePreset,
    serializePreset,
  });
});
