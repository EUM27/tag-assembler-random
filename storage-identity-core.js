(function attachStorageIdentityCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerStorageIdentity = api;
})(typeof globalThis === 'object' ? globalThis : this, function createStorageIdentityCore() {
  'use strict';

  const LOCATOR_SCHEMA = 'tag-assembler-asset-locator-v1';
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;
  const STORAGE_ROOT_PATTERN = /^[a-z][a-z0-9._-]*$/i;
  const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

  function normalizeRelativePath(value) {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text || text.startsWith('/') || /^[a-z]:\//i.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return '';
    const parts = text.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return '';
    return parts.join('/');
  }

  function normalizeContent(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const digest = String(source.digest || source.sha256 || '').trim().toLowerCase();
    const size = Number(source.size);
    const mediaType = String(source.mediaType || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(digest) || !Number.isSafeInteger(size) || size <= 0 || !MEDIA_TYPE_PATTERN.test(mediaType)) return null;
    return { algorithm: 'sha256', digest, size, mediaType };
  }

  function createAssetLocator(input) {
    const source = input && typeof input === 'object' ? input : {};
    const storageRoot = String(source.storageRoot || '').trim();
    const relativePath = normalizeRelativePath(source.relativePath);
    const content = normalizeContent(source.content || source);
    if (!STORAGE_ROOT_PATTERN.test(storageRoot) || !relativePath || !content) return null;
    return {
      schema: LOCATOR_SCHEMA,
      status: 'verified',
      content,
      location: { storageRoot, relativePath },
    };
  }

  function normalizeAssetLocator(value) {
    const source = value && typeof value === 'object' ? value : {};
    if (source.schema !== LOCATOR_SCHEMA || source.status !== 'verified') return null;
    return createAssetLocator({
      storageRoot: source.location?.storageRoot,
      relativePath: source.location?.relativePath,
      content: source.content,
    });
  }

  function contentIdentity(value) {
    const locator = normalizeAssetLocator(value) || createAssetLocator(value);
    if (!locator) return '';
    const content = locator.content;
    return `${content.algorithm}:${content.digest}:${content.size}:${content.mediaType}`;
  }

  function sameContentIdentity(left, right) {
    const leftIdentity = contentIdentity(left);
    return Boolean(leftIdentity) && leftIdentity === contentIdentity(right);
  }

  function classifyAssetReference(record) {
    const source = record && typeof record === 'object' ? record : {};
    const locator = normalizeAssetLocator(source.locator || source.assetLocator || source.originalAssetLocator);
    if (locator) return { status: 'verified', locator, contentIdentity: contentIdentity(locator) };
    return {
      status: 'unresolved_legacy',
      legacyPath: String(source.legacyPath || source.autoSavedImagePath || source.originalPath || source.src || '').trim(),
    };
  }

  function backupAssetInventory(records) {
    const assets = [];
    const unresolved = [];
    for (const record of Array.isArray(records) ? records : []) {
      const recordId = String(record?.recordId || record?.id || '').trim();
      const classified = classifyAssetReference(record);
      if (classified.status === 'verified') {
        assets.push({ recordId, locator: classified.locator, contentIdentity: classified.contentIdentity });
      } else {
        unresolved.push({ recordId, status: classified.status, legacyPath: classified.legacyPath });
      }
    }
    return {
      schema: 'tag-assembler-backup-asset-inventory-v1',
      assets,
      unresolved,
      complete: unresolved.length === 0,
    };
  }

  return Object.freeze({
    LOCATOR_SCHEMA,
    backupAssetInventory,
    classifyAssetReference,
    contentIdentity,
    createAssetLocator,
    normalizeAssetLocator,
    normalizeRelativePath,
    sameContentIdentity,
  });
});
