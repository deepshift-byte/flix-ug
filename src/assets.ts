import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sea from 'node:sea';

// Files the server needs at runtime. Inside the packaged .exe they are embedded assets;
// in development they are read from the source tree.
const SOURCE_PATHS: Record<string, string> = {
  'schema.sql': 'schema.sql',
  'phone/index.html': '../public/phone/index.html',
  'phone/assemble.js': '../public/phone/assemble.js',
};

export function readAsset(name: string): string {
  if (sea.isSea()) return sea.getAsset(name, 'utf8');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, SOURCE_PATHS[name]), 'utf8');
}
