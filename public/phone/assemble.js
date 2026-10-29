const MAX_CHUNK_ATTEMPTS = 3;

export class StorageFullError extends Error {
  constructor(cause) {
    super('device storage is full');
    this.name = 'StorageFullError';
    this.cause = cause;
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyFor = (sessionId, index) => `${sessionId}:${String(index).padStart(6, '0')}`;

export function memoryStore() {
  const map = new Map();
  return {
    async put(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.get(key);
    },
    async keys(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
    async clear(prefix) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
}

export function indexedDbStore(name = 'flix-phone') {
  const opened = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('chunks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function run(mode, action) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', mode);
      const req = action(tx.objectStore('chunks'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    put: (key, value) => run('readwrite', (s) => s.put(value, key)),
    get: (key) => run('readonly', (s) => s.get(key)),
    keys: async (prefix) => (await run('readonly', (s) => s.getAllKeys())).filter((k) => k.startsWith(prefix)),
    clear: async (prefix) => {
      const keys = (await run('readonly', (s) => s.getAllKeys())).filter((k) => k.startsWith(prefix));
      await Promise.all(keys.map((k) => run('readwrite', (s) => s.delete(k))));
    },
  };
}

// Returns true when stored, false on hash mismatch (nothing stored). Throws StorageFullError when the device is full.
export async function storeChunk(store, sessionId, index, bytes, expectedHash) {
  if ((await sha256Hex(bytes)) !== expectedHash) return false;
  try {
    await store.put(keyFor(sessionId, index), bytes);
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') throw new StorageFullError(err);
    throw err;
  }
  return true;
}

export async function missingChunks(store, sessionId, count) {
  const have = new Set(await store.keys(`${sessionId}:`));
  const missing = [];
  for (let i = 0; i < count; i++) {
    if (!have.has(keyFor(sessionId, i))) missing.push(i);
  }
  return missing;
}

// Fetches, verifies, stores and confirms every missing chunk in index order.
export async function downloadChunks(store, opts) {
  const { sessionId, chunkCount, chunkHashes, links, fetchChunk, confirm, fileSize, chunkSize } = opts;
  for (const index of await missingChunks(store, sessionId, chunkCount)) {
    let stored = false;
    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS && !stored; attempt++) {
      let bytes;
      try {
        bytes = await fetchChunk(index, links[index]);
      } catch {
        return { ok: false, reason: 'network_error' };
      }
      try {
        stored = await storeChunk(store, sessionId, index, bytes, chunkHashes[index]);
      } catch (err) {
        if (err instanceof StorageFullError) return { ok: false, reason: 'storage_full' };
        throw err;
      }
    }
    if (!stored) return { ok: false, reason: 'hash_failed' };
    await confirm(Math.min((index + 1) * chunkSize, fileSize));
  }
  // Re-confirm the full size: a confirm lost after the last chunk would otherwise stall the server at fileSize - chunk.
  if (chunkCount > 0) await confirm(fileSize);
  return { ok: true };
}

export async function assemble(store, sessionId, chunkCount, fileChecksum) {
  if ((await missingChunks(store, sessionId, chunkCount)).length > 0) {
    return { ok: false, reason: 'missing_chunks' };
  }
  const parts = [];
  for (let i = 0; i < chunkCount; i++) parts.push(await store.get(keyFor(sessionId, i)));
  const blob = new Blob(parts);
  if ((await sha256Hex(await blob.arrayBuffer())) !== fileChecksum) {
    return { ok: false, reason: 'checksum_mismatch' };
  }
  return { ok: true, blob };
}
