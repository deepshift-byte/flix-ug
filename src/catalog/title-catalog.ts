import { readFileSync } from 'node:fs';
import type { TitleKind } from '../pricing.js';

export type TitleEntry = {
  titleId: string;
  kind: TitleKind;
  episodes: number;
  filePath: string;
  fileSize: number;
  chunkHashes: string[];
  fileChecksum: string;
};

export interface TitleCatalog {
  get(titleId: string): TitleEntry | undefined;
}

export function catalogFromEntries(entries: TitleEntry[]): TitleCatalog {
  const byId = new Map(entries.map((e) => [e.titleId, e]));
  return { get: (titleId) => byId.get(titleId) };
}

export function loadCatalog(jsonPath: string): TitleCatalog {
  return catalogFromEntries(JSON.parse(readFileSync(jsonPath, 'utf8')) as TitleEntry[]);
}
