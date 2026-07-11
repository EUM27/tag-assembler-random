(function attachSavedV2RuntimeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerSavedV2Runtime = api;
})(typeof globalThis === 'object' ? globalThis : this, function createRuntimeCore() {
  'use strict';

  const RUNTIME_FIELDS = new Set([
    'schemaVersion', 'metadata', 'image', 'images', 'likedImages', 'imageIds', 'likedImageIds',
  ]);

  function uniqueIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
  }

  function createSavedV2Runtime(options = {}) {
    const store = options.store;
    const savedCore = options.savedCore;
    const assetCore = options.assetCore;
    if (!store?.saved || !store?.assets || !store?.migration) throw new TypeError('A complete v2 store adapter is required.');
    if (!savedCore?.normalizePreset || !assetCore?.prepareOriginal) throw new TypeError('Saved and asset cores are required.');

    const readSource = options.readSource;
    const createDisplayUrl = options.createDisplayUrl || (() => '');
    const revokeDisplayUrl = options.revokeDisplayUrl || (() => {});
    const displayUrls = new Map();
    const displayUrlPromises = new Map();
    const urlToAssetId = new Map();
    let snapshots = new Map();
    let records = new Map();
    let queue = Promise.resolve();

    async function isActive(migrationId) {
      const state = await store.migration.get(String(migrationId || ''));
      return state?.status === 'active';
    }

    async function displayUrlFor(assetId) {
      if (displayUrls.has(assetId)) return displayUrls.get(assetId);
      if (displayUrlPromises.has(assetId)) return await displayUrlPromises.get(assetId);
      const pending = (async () => {
        const [bytes, metadata] = await Promise.all([
          store.assets.readOriginal(assetId),
          store.assets.get(assetId),
        ]);
        const url = await createDisplayUrl(bytes, { ...metadata, assetId });
        displayUrls.set(assetId, url);
        if (url) urlToAssetId.set(url, assetId);
        return url;
      })();
      displayUrlPromises.set(assetId, pending);
      try {
        return await pending;
      } finally {
        displayUrlPromises.delete(assetId);
      }
    }

    async function hydrate(record) {
      const normalized = savedCore.normalizePreset(record);
      const images = await Promise.all(normalized.imageIds.map(displayUrlFor));
      const likedImages = await Promise.all(normalized.likedImageIds.map(displayUrlFor));
      return {
        ...normalized.metadata,
        id: String(record.id || ''),
        schemaVersion: normalized.schemaVersion,
        imageIds: [...normalized.imageIds],
        likedImageIds: [...normalized.likedImageIds],
        image: images[0] || '',
        images,
        likedImages,
      };
    }

    async function load(options = {}) {
      const list = await store.saved.list();
      records = new Map();
      snapshots = new Map();
      for (const value of Array.isArray(list) ? list : []) {
        const id = String(value?.id || '').trim();
        if (!id) continue;
        const record = { id, ...savedCore.normalizePreset(value) };
        records.set(id, record);
        snapshots.set(id, savedCore.serializePreset(record));
      }
      const items = [...records.values()].map(record => ({
        ...record.metadata,
        id: record.id,
        schemaVersion: record.schemaVersion,
        imageIds: [...record.imageIds],
        likedImageIds: [...record.likedImageIds],
        image: '',
        images: [],
        likedImages: [],
      }));
      return options.hydrate === false ? items : await Promise.all([...records.values()].map(hydrate));
    }

    async function hydrateItem(item) {
      if (!item || typeof item !== 'object') return item;
      const images = await Promise.all((item.imageIds || []).map(displayUrlFor));
      const likedImages = await Promise.all((item.likedImageIds || []).map(displayUrlFor));
      item.image = images[0] || '';
      item.images = images;
      item.likedImages = likedImages;
      return item;
    }

    async function hydrateItems(items) {
      return await Promise.all((Array.isArray(items) ? items : []).map(hydrateItem));
    }

    function releaseUnused(keepAssetIds, items = []) {
      const keep = new Set(uniqueIds(keepAssetIds));
      const released = new Set();
      for (const [assetId, url] of displayUrls) {
        if (keep.has(assetId)) continue;
        if (url) revokeDisplayUrl(url);
        displayUrls.delete(assetId);
        displayUrlPromises.delete(assetId);
        urlToAssetId.delete(url);
        released.add(assetId);
      }
      for (const item of Array.isArray(items) ? items : []) {
        if (![...(item?.imageIds || []), ...(item?.likedImageIds || [])].some(id => released.has(id))) continue;
        item.image = '';
        item.images = [];
        item.likedImages = [];
      }
      return [...released];
    }

    function metadataFor(item) {
      const metadata = {};
      for (const [key, value] of Object.entries(item && typeof item === 'object' ? item : {})) {
        if (!RUNTIME_FIELDS.has(key) && key !== 'id') metadata[key] = value;
      }
      return savedCore.normalizeMetadata(metadata);
    }

    async function assetIdForSource(source, alignedId) {
      const mapped = urlToAssetId.get(source);
      if (mapped) return mapped;
      if (alignedId) return alignedId;
      if (typeof readSource !== 'function') throw new Error('No original-byte source reader is configured.');
      const original = await readSource(source);
      const prepared = await assetCore.prepareOriginal(original?.bytes, { mediaType: original?.mediaType });
      await store.assets.putOriginal(prepared.readBytes(), {
        assetId: prepared.assetId,
        sha256: prepared.sha256,
        byteLength: prepared.byteLength,
        mediaType: prepared.mediaType,
        role: prepared.role,
      });
      if (typeof source === 'string' && source) urlToAssetId.set(source, prepared.assetId);
      return prepared.assetId;
    }

    async function normalizeItem(item) {
      const sources = Array.isArray(item?.images) && item.images.length
        ? item.images
        : (item?.image ? [item.image] : []);
      const existingIds = Array.isArray(item?.imageIds) ? item.imageIds : [];
      const imageIds = [];
      for (let index = 0; index < sources.length; index += 1) {
        imageIds.push(await assetIdForSource(sources[index], existingIds[index]));
      }
      if (!sources.length) imageIds.push(...uniqueIds(existingIds));

      const likedSources = Array.isArray(item?.likedImages) ? item.likedImages : [];
      const existingLikedIds = Array.isArray(item?.likedImageIds) ? item.likedImageIds : [];
      const likedImageIds = [];
      for (let index = 0; index < likedSources.length; index += 1) {
        likedImageIds.push(await assetIdForSource(likedSources[index], existingLikedIds[index]));
      }
      if (!likedSources.length) likedImageIds.push(...uniqueIds(existingLikedIds));

      item.imageIds = uniqueIds(imageIds);
      item.likedImageIds = uniqueIds(likedImageIds);
      return {
        id: String(item?.id || '').trim(),
        ...savedCore.normalizePreset({
          metadata: metadataFor(item),
          imageIds: item.imageIds,
          likedImageIds: item.likedImageIds,
        }),
      };
    }

    async function performSync(items) {
      const nextRecords = new Map();
      for (const item of Array.isArray(items) ? items : []) {
        const record = await normalizeItem(item);
        if (!record.id) throw new TypeError('Saved v2 records require an id.');
        nextRecords.set(record.id, record);
      }

      const putIds = [];
      for (const [id, record] of nextRecords) {
        const serialized = savedCore.serializePreset(record);
        if (snapshots.get(id) === serialized) continue;
        await store.saved.put(id, record);
        snapshots.set(id, serialized);
        putIds.push(id);
      }

      const deleteIds = [];
      const previousAssetIds = [];
      for (const [id, record] of records) {
        previousAssetIds.push(...record.imageIds, ...record.likedImageIds);
        if (nextRecords.has(id)) continue;
        await store.saved.delete(id);
        snapshots.delete(id);
        deleteIds.push(id);
      }

      const retainedRecords = [...nextRecords.values()];
      const retention = assetCore.planRetention(previousAssetIds, retainedRecords);
      const quarantineIds = retention.quarantine.map(entry => entry.assetId);
      const quarantinedAssetIds = quarantineIds.length
        ? uniqueIds(await store.assets.quarantine(quarantineIds))
        : [];
      records = nextRecords;
      return { putIds, deleteIds, quarantinedAssetIds };
    }

    function sync(items) {
      const operation = queue.then(() => performSync(items));
      queue = operation.catch(() => {});
      return operation;
    }

    function dispose() {
      for (const url of new Set(displayUrls.values())) {
        if (url) revokeDisplayUrl(url);
      }
      displayUrls.clear();
      displayUrlPromises.clear();
      urlToAssetId.clear();
    }

    return Object.freeze({ dispose, hydrateItem, hydrateItems, isActive, load, releaseUnused, sync });
  }

  return Object.freeze({ createSavedV2Runtime });
});
