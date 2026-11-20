import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TitleKind } from '../pricing.js';

export type TitleEntry = {
  titleId: string;
  kind: TitleKind;
  episodes: number;
  filePath: string;
  fileSize: number;
  chunkHashes: string[];
  fileChecksum: string;
  // What customers see on the storefront. All optional, so older catalog files still load.
  name?: string;
  year?: number;
  genre?: string;
  description?: string;
  posterPath?: string;
  trailerPath?: string;
  addedAt?: string;
};

export interface TitleCatalog {
  get(titleId: string): TitleEntry | undefined;
  list(): TitleEntry[];
  upsert(entry: TitleEntry): void;
  remove(titleId: string): void;
}

export function catalogFromEntries(entries: TitleEntry[], onChange?: (all: TitleEntry[]) => void): TitleCatalog {
  const byId = new Map(entries.map((e) => [e.titleId, e]));
  const changed = () => onChange?.([...byId.values()]);
  return {
    get: (titleId) => byId.get(titleId),
    list: () => [...byId.values()],
    upsert: (entry) => {
      byId.set(entry.titleId, entry);
      changed();
    },
    remove: (titleId) => {
      byId.delete(titleId);
      changed();
    },
  };
}

// A catalog kept in a JSON file; every change is written straight back.
export function jsonCatalog(path: string): TitleCatalog {
  const entries = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as TitleEntry[]) : [];
  return catalogFromEntries(entries, (all) => writeFileSync(path, JSON.stringify(all, null, 2)));
}

export function loadCatalog(jsonPath: string): TitleCatalog {
  return jsonCatalog(jsonPath);
}
