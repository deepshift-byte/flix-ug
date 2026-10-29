export const CHUNK_SIZE = 4 * 1024 * 1024;

export function chunkCount(fileSize: number): number {
  return Math.ceil(fileSize / CHUNK_SIZE);
}

export function chunkRange(fileSize: number, index: number): { start: number; end: number } {
  const start = index * CHUNK_SIZE;
  return { start, end: Math.min(start + CHUNK_SIZE, fileSize) };
}
