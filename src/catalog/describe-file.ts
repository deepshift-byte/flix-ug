import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { CHUNK_SIZE } from '../download/chunks.js';
import type { TitleKind } from '../pricing.js';
import type { TitleEntry } from './title-catalog.js';

// Reads a movie file once, 4 MB at a time, and returns the catalog entry the server needs.
export async function describeMovieFile(
  filePath: string,
  title: { titleId: string; kind: TitleKind; episodes: number },
): Promise<TitleEntry> {
  const file = await open(filePath, 'r');
  try {
    const whole = createHash('sha256');
    const chunkHashes: string[] = [];
    const buf = Buffer.alloc(CHUNK_SIZE);
    let fileSize = 0;
    for (;;) {
      // Fill a whole chunk, since a single read may return fewer bytes than asked for.
      let filled = 0;
      while (filled < CHUNK_SIZE) {
        const { bytesRead } = await file.read(buf, filled, CHUNK_SIZE - filled, fileSize + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) break;
      const chunk = buf.subarray(0, filled);
      chunkHashes.push(createHash('sha256').update(chunk).digest('hex'));
      whole.update(chunk);
      fileSize += filled;
      if (filled < CHUNK_SIZE) break;
    }
    if (fileSize === 0) throw new Error(`${filePath} is empty`);
    return { ...title, filePath, fileSize, chunkHashes, fileChecksum: whole.digest('hex') };
  } finally {
    await file.close();
  }
}
