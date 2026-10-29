import { existsSync, openSync, closeSync, fsyncSync, readFileSync, rmSync, writeSync } from 'node:fs';

export const JOURNAL_FILE = '.flix-journal.json';

export type Journal = { sessionId: string; titleId: string };

export function readJournal(path: string): Journal | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Journal>;
    if (typeof parsed.sessionId === 'string' && typeof parsed.titleId === 'string') {
      return { sessionId: parsed.sessionId, titleId: parsed.titleId };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeJournal(path: string, journal: Journal): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, JSON.stringify(journal));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function deleteJournal(path: string): void {
  rmSync(path, { force: true });
}
