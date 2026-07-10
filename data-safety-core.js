(function attachDataSafetyCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.TagAssemblerDataSafety = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDataSafetyCore() {
  'use strict';

  const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array();
  }

  function readUint32(bytes, offset) {
    return (((bytes[offset] << 24) >>> 0)
      | (bytes[offset + 1] << 16)
      | (bytes[offset + 2] << 8)
      | bytes[offset + 3]) >>> 0;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunkType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function isCompletePng(value) {
    const bytes = asBytes(value);
    const minimumChunkBytes = 12;
    const ihdrDataBytes = 13;
    if (bytes.length < PNG_SIGNATURE.length + minimumChunkBytes + ihdrDataBytes + minimumChunkBytes) return false;
    if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return false;

    let offset = PNG_SIGNATURE.length;
    let chunkIndex = 0;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;
    while (offset < bytes.length) {
      if (offset + minimumChunkBytes > bytes.length) return false;
      const dataLength = readUint32(bytes, offset);
      const typeOffset = offset + 4;
      const dataOffset = typeOffset + 4;
      const crcOffset = dataOffset + dataLength;
      const nextOffset = crcOffset + 4;
      if (nextOffset > bytes.length) return false;

      const type = chunkType(bytes, typeOffset);
      if (!/^[A-Za-z]{4}$/.test(type)) return false;
      const actualCrc = crc32(bytes.subarray(typeOffset, crcOffset));
      if (actualCrc !== readUint32(bytes, crcOffset)) return false;

      if (chunkIndex === 0) {
        if (type !== 'IHDR' || dataLength !== ihdrDataBytes) return false;
        if (readUint32(bytes, dataOffset) === 0 || readUint32(bytes, dataOffset + 4) === 0) return false;
        sawHeader = true;
      } else if (type === 'IHDR') {
        return false;
      }

      if (type === 'IDAT') sawImageData = true;
      if (type === 'IEND') {
        if (dataLength !== 0 || nextOffset !== bytes.length) return false;
        sawEnd = true;
      } else if (sawEnd) {
        return false;
      }

      offset = nextOffset;
      chunkIndex += 1;
    }
    return sawHeader && sawImageData && sawEnd;
  }

  function normalizeSha256(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return SHA256_HEX_PATTERN.test(normalized) ? normalized : '';
  }

  async function sha256Hex(value) {
    const bytes = asBytes(value);
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle) throw new Error('SHA-256 is unavailable in this runtime.');
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function fingerprintOriginalPng(value) {
    const bytes = asBytes(value);
    if (!isCompletePng(bytes)) return { ok: false, status: 'invalid_png', sha256: '', size: bytes.length };
    return { ok: true, status: 'verified_png', sha256: await sha256Hex(bytes), size: bytes.length };
  }

  async function verifyOriginalPngBytes(value, expectedSha256) {
    const bytes = asBytes(value);
    const expected = normalizeSha256(expectedSha256);
    if (!expected) return { ok: false, status: 'missing_original_hash', expectedSha256: '', sha256: '', size: bytes.length };
    if (!isCompletePng(bytes)) return { ok: false, status: 'invalid_png', expectedSha256: expected, sha256: '', size: bytes.length };
    const actual = await sha256Hex(bytes);
    return {
      ok: actual === expected,
      status: actual === expected ? 'verified_original' : 'original_hash_mismatch',
      expectedSha256: expected,
      sha256: actual,
      size: bytes.length,
    };
  }

  function verifyWholeArchive(items) {
    const records = Array.isArray(items) ? items : [];
    return records.length > 0 && records.every(item => item?.hashVerified === true && Boolean(item.outputFileName));
  }

  function validateParsedImport(payload) {
    if (!payload || typeof payload !== 'object') throw new TypeError('Parsed app data must be an object.');
    if (payload.items !== null && payload.items !== undefined && !Array.isArray(payload.items)) {
      throw new TypeError('Parsed saved items must be an array or null.');
    }
    if (payload.userData !== null && payload.userData !== undefined && typeof payload.userData !== 'object') {
      throw new TypeError('Parsed user data must be an object or null.');
    }
    return payload;
  }

  async function commitReadOnlyImport(options) {
    const sourceConnection = options?.sourceConnection || null;
    const previousConnection = options?.previousConnection || null;
    const mode = options?.mode === 'merge' ? 'merge' : 'replace';
    const setConnection = options?.setConnection;
    const commit = options?.commit;
    if (typeof setConnection !== 'function' || typeof commit !== 'function') {
      throw new TypeError('Import commit requires connection and commit functions.');
    }

    await setConnection(null);
    try {
      const result = await commit();
      await setConnection(mode === 'replace' ? sourceConnection : previousConnection);
      return result;
    } catch (error) {
      try {
        await setConnection(previousConnection);
      } catch (restoreError) {
        error.connectionRestoreError = restoreError;
      }
      throw error;
    }
  }

  return Object.freeze({
    commitReadOnlyImport,
    fingerprintOriginalPng,
    isCompletePng,
    normalizeSha256,
    validateParsedImport,
    verifyOriginalPngBytes,
    verifyWholeArchive,
  });
});
