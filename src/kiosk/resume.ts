import { CHUNK_SIZE } from '../download/chunks';

export function resumeOffset(serverOffset: number, localPartSize: number): number {
  return Math.min(serverOffset, localPartSize);
}

export function chunkAlignedStart(offset: number): number {
  return Math.floor(offset / CHUNK_SIZE) * CHUNK_SIZE;
}
