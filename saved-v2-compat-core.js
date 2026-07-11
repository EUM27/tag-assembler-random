(function attachSavedV2CompatCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerSavedV2Compat = api;
})(typeof globalThis === 'object' ? globalThis : this, function createCompatModule() {
  'use strict';

  const EXTENSIONS = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
  });

  function copyBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    throw new TypeError('Original asset bytes are required.');
  }

  function browserDecodeBase64(value) {
    const binary = globalThis.atob(String(value || ''));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function browserEncodeBase64(bytes) {
    let binary = '';
    const input = copyBytes(bytes);
    const chunkSize = 0x8000;
    for (let index = 0; index < input.length; index += chunkSize) {
      binary += String.fromCharCode(...input.subarray(index, index + chunkSize));
    }
    return globalThis.btoa(binary);
  }

  function decodeDataUrl(value, decodeBase64 = browserDecodeBase64) {
    const match = /^data:(image\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([a-z0-9+/=\s]+)$/i.exec(String(value || '').trim());
    if (!match) throw new TypeError('A base64 image data URL is required.');
    return { mediaType: match[1].toLowerCase(), bytes: copyBytes(decodeBase64(match[2].replace(/\s+/g, ''))) };
  }

  function createSavedV2Compat(options = {}) {
    const assets = options.assets;
    if (!assets?.readOriginal || !assets?.get) throw new TypeError('An asset store adapter is required.');
    const encodeBase64 = options.encodeBase64 || browserEncodeBase64;

    async function read(assetId) {
      const [bytesValue, metadata] = await Promise.all([assets.readOriginal(assetId), assets.get(assetId)]);
      if (!bytesValue || !metadata?.mediaType) throw new Error(`Original asset is unavailable: ${assetId}`);
      const bytes = copyBytes(bytesValue);
      if (Number.isSafeInteger(metadata.byteLength) && metadata.byteLength !== bytes.byteLength) {
        throw new Error(`Original asset length mismatch: ${assetId}`);
      }
      return { assetId, bytes, mediaType: String(metadata.mediaType).toLowerCase() };
    }

    async function dataUrl(assetId, cache) {
      if (cache.has(assetId)) return cache.get(assetId);
      const original = await read(assetId);
      const value = `data:${original.mediaType};base64,${encodeBase64(original.bytes)}`;
      cache.set(assetId, value);
      return value;
    }

    async function exportLegacyItems(items) {
      const cache = new Map();
      const result = [];
      for (const source of Array.isArray(items) ? items : []) {
        const item = { ...source };
        const imageIds = Array.isArray(source?.imageIds) ? source.imageIds : [];
        const likedImageIds = Array.isArray(source?.likedImageIds) ? source.likedImageIds : [];
        item.images = await Promise.all(imageIds.map(id => dataUrl(id, cache)));
        item.image = item.images[0] || '';
        item.likedImages = await Promise.all(likedImageIds.map(id => dataUrl(id, cache)));
        delete item.imageIds;
        delete item.likedImageIds;
        delete item.schemaVersion;
        result.push(item);
      }
      return result;
    }

    async function originalEntries(item) {
      const entries = [];
      const ids = Array.isArray(item?.imageIds) ? item.imageIds : [];
      for (let index = 0; index < ids.length; index += 1) {
        const original = await read(ids[index]);
        const extension = EXTENSIONS[original.mediaType];
        if (!extension) throw new Error(`Unsupported original image media type: ${original.mediaType}`);
        entries.push({ ...original, extension, index });
      }
      return entries;
    }

    return Object.freeze({ exportLegacyItems, originalEntries });
  }

  return Object.freeze({ createSavedV2Compat, decodeDataUrl });
});
