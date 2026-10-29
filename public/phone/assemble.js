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
    // Stored as a Blob so browsers can keep large chunks on disk instead of in memory.
    await store.put(keyFor(sessionId, index), new Blob([bytes]));
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
  // Hash one chunk at a time, so the whole movie is never held in memory.
  const hash = new Sha256();
  for (const part of parts) hash.update(new Uint8Array(await part.arrayBuffer()));
  if (hash.hex() !== fileChecksum) {
    return { ok: false, reason: 'checksum_mismatch' };
  }
  return { ok: true, blob };
}

// Incremental SHA-256. WebCrypto cannot hash a stream, and a whole movie must not sit in memory at once.
// Constants are derived from the primes (fractional parts of cube and square roots) rather than typed in.
function primesUpTo(count) {
  const found = [];
  for (let n = 2; found.length < count; n++) {
    if (found.every((p) => n % p !== 0)) found.push(n);
  }
  return found;
}
const fractionBits = (x) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = primesUpTo(64).map((p) => fractionBits(Math.cbrt(p)));
const H0 = primesUpTo(8).map((p) => fractionBits(Math.sqrt(p)));

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function compress(h, data, offset) {
  const w = new Array(64);
  for (let i = 0; i < 16; i++) {
    const o = offset + i * 4;
    w[i] = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    hh = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  const out = [a, b, c, d, e, f, g, hh];
  for (let i = 0; i < 8; i++) h[i] = (h[i] + out[i]) >>> 0;
}

export class Sha256 {
  constructor() {
    this.h = [...H0];
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.length = 0;
  }

  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take;
      offset = take;
      if (this.bufLen === 64) {
        compress(this.h, this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (bytes.length - offset >= 64) {
      compress(this.h, bytes, offset);
      offset += 64;
    }
    if (offset < bytes.length) {
      this.buf.set(bytes.subarray(offset));
      this.bufLen = bytes.length - offset;
    }
    return this;
  }

  hex() {
    const padBlocks = this.bufLen < 56 ? 64 : 128;
    const tail = new Uint8Array(padBlocks);
    tail.set(this.buf.subarray(0, this.bufLen));
    tail[this.bufLen] = 0x80;
    const bitLength = this.length * 8;
    const view = new DataView(tail.buffer);
    view.setUint32(padBlocks - 8, Math.floor(bitLength / 2 ** 32));
    view.setUint32(padBlocks - 4, bitLength >>> 0);
    for (let o = 0; o < padBlocks; o += 64) compress(this.h, tail, o);
    return this.h.map((x) => x.toString(16).padStart(8, '0')).join('');
  }
}
