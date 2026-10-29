import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { CHUNK_SIZE, chunkCount, chunkRange } from '../download/chunks';
import { deleteJournal, JOURNAL_FILE, readJournal, writeJournal } from './journal';
import { chunkAlignedStart, resumeOffset } from './resume';

export type SignedLink = { exp: string; sig: string };

export type StartInfo = {
  sessionId: string;
  fileSize: number;
  chunkHashes: string[];
  fileChecksum: string;
  links: SignedLink[];
};

export type StartResult = { ok: true; info: StartInfo } | { ok: false; reason: string };
export type CompleteResult = { ok: true; chargedUgx: number } | { ok: false; reason: string };

export interface ServerClient {
  startSession(input: { tokenNumber: string; pin: string; titleId: string }): Promise<StartResult>;
  fetchChunk(sessionId: string, index: number, link: SignedLink): Promise<Buffer>;
  confirm(sessionId: string, offset: number): Promise<void>;
  status(sessionId: string): Promise<StartInfo & { status: string; bytesConfirmed: number }>;
  complete(sessionId: string, checksum: string): Promise<CompleteResult>;
  abandon(sessionId: string): Promise<void>;
}

export type DownloadOptions = {
  client: ServerClient;
  usbDir: string;
  tokenNumber: string;
  pin: string;
  titleId: string;
  fileName: string;
  resumeSessionId?: string;
};

export type DownloadResult = { ok: true; path: string } | { ok: false; reason: string };

const MAX_CHUNK_ATTEMPTS = 3;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read: number;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function createEmptyFile(path: string): void {
  closeSync(openSync(path, 'w'));
}

function writeChunk(path: string, position: number, bytes: Buffer): void {
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, bytes, 0, bytes.length, position);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function fetchVerifiedChunk(
  client: ServerClient,
  info: StartInfo,
  index: number,
): Promise<Buffer | 'hash_failed' | 'network_error'> {
  let sawHashFailure = false;
  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
    let bytes: Buffer;
    try {
      bytes = await client.fetchChunk(info.sessionId, index, info.links[index]);
    } catch {
      return 'network_error';
    }
    if (sha256(bytes) === info.chunkHashes[index]) return bytes;
    sawHashFailure = true;
  }
  return sawHashFailure ? 'hash_failed' : 'network_error';
}

export async function downloadToUsb(opts: DownloadOptions): Promise<DownloadResult> {
  const journalFile = join(opts.usbDir, JOURNAL_FILE);
  const partPath = join(opts.usbDir, `${opts.fileName}.part`);
  const finalPath = join(opts.usbDir, opts.fileName);
  const journal = readJournal(journalFile);
  const resuming = journal !== null && journal.titleId === opts.titleId && journal.sessionId === opts.resumeSessionId;

  let info: StartInfo;
  let startIndex = 0;

  if (resuming) {
    const status = await opts.client.status(journal.sessionId);
    info = status;

    if (status.status === 'complete') {
      // Charged already; only the local rename may still be missing.
      if (!existsSync(partPath) || sha256File(partPath) !== status.fileChecksum) {
        return { ok: false, reason: 'completed_but_local_file_invalid' };
      }
      renameSync(partPath, finalPath);
      deleteJournal(journalFile);
      return { ok: true, path: finalPath };
    }
    if (status.status !== 'active') {
      rmSync(partPath, { force: true });
      deleteJournal(journalFile);
      return { ok: false, reason: 'session_not_active' };
    }

    const localSize = existsSync(partPath) ? statSync(partPath).size : 0;
    const offset = chunkAlignedStart(resumeOffset(status.bytesConfirmed, localSize));
    if (existsSync(partPath)) {
      const fd = openSync(partPath, 'r+');
      try {
        ftruncateSync(fd, offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      createEmptyFile(partPath);
    }
    startIndex = offset / CHUNK_SIZE;
  } else {
    // A journal for another session or title belongs to a different copy: discard it and its partial file.
    rmSync(partPath, { force: true });
    deleteJournal(journalFile);

    const started = await opts.client.startSession({
      tokenNumber: opts.tokenNumber,
      pin: opts.pin,
      titleId: opts.titleId,
    });
    if (!started.ok) return { ok: false, reason: started.reason };
    info = started.info;

    writeJournal(journalFile, { sessionId: info.sessionId, titleId: opts.titleId });
    createEmptyFile(partPath);
  }

  const total = chunkCount(info.fileSize);
  for (let index = startIndex; index < total; index++) {
    const { start, end } = chunkRange(info.fileSize, index);
    const bytes = await fetchVerifiedChunk(opts.client, info, index);
    if (bytes === 'network_error') return { ok: false, reason: 'network_error' };
    if (bytes === 'hash_failed') {
      await opts.client.abandon(info.sessionId);
      return { ok: false, reason: 'chunk_failed' };
    }
    writeChunk(partPath, start, bytes);
    await opts.client.confirm(info.sessionId, end);
  }

  const done = await opts.client.complete(info.sessionId, sha256File(partPath));
  if (!done.ok) return { ok: false, reason: done.reason };

  renameSync(partPath, finalPath);
  deleteJournal(journalFile);
  return { ok: true, path: finalPath };
}
