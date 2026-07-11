(function attachBackupInventoryCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerBackupInventory = api;
})(typeof globalThis === 'object' ? globalThis : this, function createBackupInventoryCore() {
  'use strict';

  const INVENTORY_SCHEMA = 'tag-assembler-backup-inventory-v1';
  const LOCATOR_SCHEMA = 'tag-assembler-asset-locator-v1';
  const CUSTOM_MANIFEST_SCHEMA = 'tag-assembler-custom-thumb-manifest-v1';
  const CUSTOM_ASSET_SCHEMA = 'tag-assembler-custom-thumb-asset-v1';
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array();
  }

  async function sha256Hex(value) {
    const bytes = asBytes(value);
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this runtime.');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function safeState(userState) {
    const source = userState && typeof userState === 'object' ? userState : {};
    return {
      presets: source.presets && typeof source.presets === 'object' ? source.presets : {},
      userTags: source.userTags && typeof source.userTags === 'object' ? source.userTags : {},
      artistPrefs: source.artistPrefs && typeof source.artistPrefs === 'object' ? source.artistPrefs : {},
      heartTally: source.heartTally && typeof source.heartTally === 'object' ? source.heartTally : {},
    };
  }

  function normalizeLocator(value) {
    const source = value && typeof value === 'object' ? value : {};
    const content = source.content && typeof source.content === 'object' ? source.content : {};
    const digest = String(content.digest || '').trim().toLowerCase();
    const size = Number(content.size);
    const mediaType = String(content.mediaType || '').trim().toLowerCase();
    if (source.schema !== LOCATOR_SCHEMA || source.status !== 'verified' || content.algorithm !== 'sha256'
      || !SHA256_PATTERN.test(digest) || !Number.isSafeInteger(size) || size <= 0 || !mediaType) return null;
    return {
      content: { algorithm: 'sha256', digest, size, mediaType },
      location: source.location && typeof source.location === 'object' ? { ...source.location } : {},
    };
  }

  function contentIdentity(locator) {
    const value = locator.content;
    return `${value.algorithm}:${value.digest}:${value.size}:${value.mediaType}`;
  }

  function decodeDataUrl(value) {
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(value || ''));
    if (!match) return null;
    const binary = atob(match[2].replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { mediaType: match[1].toLowerCase(), bytes };
  }

  function mapValue(mapLike, key) {
    if (mapLike instanceof Map) return mapLike.get(key);
    return mapLike && typeof mapLike === 'object' ? mapLike[key] : undefined;
  }

  async function classifyLocatorReference(reference, assetsByIdentity, validators) {
    if (reference.sourceType === 'embedded_data_url') {
      return {
        recordId: reference.recordId,
        recordType: reference.recordType,
        status: 'unresolved_legacy',
        sourceType: reference.sourceType,
      };
    }
    const locator = normalizeLocator(reference.locator);
    if (!locator) {
      return {
        recordId: reference.recordId,
        recordType: reference.recordType,
        status: 'unresolved_legacy',
        legacyPath: reference.legacyPath,
      };
    }
    const identity = contentIdentity(locator);
    const rawBytes = mapValue(assetsByIdentity, identity);
    if (rawBytes === undefined || rawBytes === null) {
      return { recordId: reference.recordId, recordType: reference.recordType, status: 'missing', contentIdentity: identity, locator };
    }
    const bytes = asBytes(rawBytes);
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== locator.content.digest || bytes.length !== locator.content.size) {
      return { recordId: reference.recordId, recordType: reference.recordType, status: 'hash_mismatch', contentIdentity: identity, locator, actualHash, actualSize: bytes.length };
    }
    const validator = validators instanceof Map ? validators.get(locator.content.mediaType) : validators?.[locator.content.mediaType];
    if (typeof validator === 'function' && validator(bytes) !== true) {
      return { recordId: reference.recordId, recordType: reference.recordType, status: 'invalid_bytes', contentIdentity: identity, locator };
    }
    return { recordId: reference.recordId, recordType: reference.recordType, status: 'verified_included', contentIdentity: identity, locator, bytes };
  }

  function metadataReferences(source) {
    const references = [];
    const coverage = [];
    for (const item of Array.isArray(source.savedCombinations) ? source.savedCombinations : []) {
      const itemId = String(item?.id || '').trim();
      const startCount = references.length;
      const direct = item?.assetLocator;
      if (direct || item?.autoSavedImagePath) references.push({ recordId: itemId, recordType: 'saved', locator: direct, legacyPath: String(item?.autoSavedImagePath || '') });
      for (const ref of Array.isArray(item?.imageRefs) ? item.imageRefs : []) {
        if (ref?.assetLocator || ref?.autoSavedImagePath) references.push({ recordId: itemId, recordType: 'saved_image_ref', locator: ref?.assetLocator, legacyPath: String(ref?.autoSavedImagePath || '') });
      }
      const embeddedSources = new Set([
        item?.image,
        ...(Array.isArray(item?.images) ? item.images : []),
        ...(Array.isArray(item?.imageRefs) ? item.imageRefs.map(ref => ref?.src) : []),
      ].map(value => String(value || '')).filter(value => value.startsWith('data:image/')));
      embeddedSources.forEach(() => references.push({ recordId: itemId, recordType: 'saved_embedded_image', sourceType: 'embedded_data_url' }));
      coverage.push({ recordId: itemId, recordType: 'saved_metadata', status: references.length > startCount ? 'covered' : 'missing' });
    }
    for (const item of Array.isArray(source.history) ? source.history : []) {
      const itemId = String(item?.id || '');
      const startCount = references.length;
      if (item?.originalAssetLocator || item?.autoSavedImagePath) references.push({ recordId: itemId, recordType: 'history', locator: item?.originalAssetLocator, legacyPath: String(item?.autoSavedImagePath || '') });
      if (String(item?.imageDataUrl || '').startsWith('data:image/')) {
        references.push({ recordId: itemId, recordType: 'history_thumbnail', sourceType: 'embedded_data_url' });
      }
      coverage.push({ recordId: itemId, recordType: 'history_metadata', status: references.length > startCount ? 'covered' : 'missing' });
    }
    return { references, coverage };
  }

  async function customReferences(customThumbs) {
    const records = [];
    for (const artistKey of Object.keys(customThumbs?.legacy || {})) {
      records.push({ recordId: artistKey, recordType: 'custom_thumb_legacy', status: 'unresolved_legacy' });
    }
    const manifest = customThumbs?.manifest?.schema === CUSTOM_MANIFEST_SCHEMA ? customThumbs.manifest : { entries: {} };
    for (const [artistKey, entry] of Object.entries(manifest.entries || {})) {
      const record = mapValue(customThumbs?.recordsByKey, entry?.assetKey);
      if (!record) {
        records.push({ recordId: artistKey, recordType: 'custom_thumb', status: 'missing', assetKey: entry?.assetKey });
        continue;
      }
      const decoded = decodeDataUrl(record.dataUrl);
      if (!decoded || record.schema !== CUSTOM_ASSET_SCHEMA) {
        records.push({ recordId: artistKey, recordType: 'custom_thumb', status: 'invalid_bytes', assetKey: entry?.assetKey });
        continue;
      }
      const actualHash = await sha256Hex(decoded.bytes);
      const matches = actualHash === entry.sha256 && decoded.bytes.length === entry.size && decoded.mediaType === entry.mediaType
        && record.sha256 === entry.sha256 && record.size === entry.size && record.mediaType === entry.mediaType;
      records.push({
        recordId: artistKey,
        recordType: 'custom_thumb',
        status: matches ? 'verified_included' : 'hash_mismatch',
        contentIdentity: `sha256:${entry.sha256}:${entry.size}:${entry.mediaType}`,
        assetKey: entry.assetKey,
        bytes: matches ? decoded.bytes : undefined,
      });
    }
    return records;
  }

  async function buildBackupInventory(sourceValue) {
    const source = sourceValue && typeof sourceValue === 'object' ? sourceValue : {};
    const records = [];
    const metadata = metadataReferences(source);
    for (const reference of metadata.references) {
      records.push(await classifyLocatorReference(reference, source.assetsByContentIdentity, source.validators));
    }
    const customRecords = await customReferences(source.customThumbs || {});
    records.push(...customRecords);
    const coverage = [
      ...metadata.coverage,
      ...customRecords.map(record => ({ recordId: record.recordId, recordType: 'custom_thumb_metadata', status: 'covered' })),
    ];
    const included = new Map();
    for (const record of records) {
      if (record.status !== 'verified_included' || !record.contentIdentity || included.has(record.contentIdentity)) continue;
      included.set(record.contentIdentity, {
        contentIdentity: record.contentIdentity,
        size: record.bytes?.length || record.locator?.content?.size || 0,
        mediaType: record.locator?.content?.mediaType || '',
      });
    }
    const publicRecords = records.map(({ bytes, ...record }) => record);
    return {
      schema: INVENTORY_SCHEMA,
      complete: coverage.every(entry => entry.status === 'covered')
        && publicRecords.every(record => record.status === 'verified_included'),
      safeState: safeState(source.userState),
      metadata: {
        savedCombinations: Array.isArray(source.savedCombinations) ? source.savedCombinations.length : 0,
        history: Array.isArray(source.history) ? source.history.length : 0,
      },
      records: publicRecords,
      coverage,
      assets: [...included.values()],
    };
  }

  function pendingInventory(input = {}) {
    return {
      schema: INVENTORY_SCHEMA,
      complete: false,
      status: 'verification_required',
      metadata: {
        savedCombinations: Array.isArray(input.savedCombinations) ? input.savedCombinations.length : 0,
        history: Array.isArray(input.history) ? input.history.length : 0,
        customManifestEntries: Object.keys(input.customManifest?.entries || {}).length,
        legacyCustomThumbs: Number(input.legacyCustomThumbs || 0),
      },
    };
  }

  return Object.freeze({ buildBackupInventory, pendingInventory });
});
