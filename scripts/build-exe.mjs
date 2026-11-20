// Builds the single-file FLIX-UG test program:
//   release/flix-ug.exe   Windows x64
//   release/flix-ug       Linux x64 (same blob; used to test the build here)
// Uses Node's single executable application support. The Windows runtime is the official
// node.exe from nodejs.org for the same Node version, verified against its published SHA-256.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const VERSION = process.version; // the blob must be injected into the same Node version that made it
const OUT = 'build/exe';
const RELEASE = 'release';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
mkdirSync(OUT, { recursive: true });
mkdirSync(RELEASE, { recursive: true });

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: `${OUT}/flix-ug.cjs`,
  logLevel: 'warning',
});

writeFileSync(`${OUT}/sea-config.json`, JSON.stringify({
  main: `${OUT}/flix-ug.cjs`,
  output: `${OUT}/sea-prep.blob`,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {
    'schema.sql': 'src/schema.sql',
    'phone/index.html': 'public/phone/index.html',
    'phone/assemble.js': 'public/phone/assemble.js',
    'shop/index.html': 'public/shop/index.html',
    'shop/shop.css': 'public/shop/shop.css',
    'shop/shop.js': 'public/shop/shop.js',
    'shop/demo-trailer.webm': 'public/shop/demo-trailer.webm',
    'admin/index.html': 'public/admin/index.html',
    'admin/admin.js': 'public/admin/admin.js',
  },
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', `${OUT}/sea-config.json`], { stdio: 'inherit' });

function stripPeSignature(pe) {
  const peOffset = pe.readUInt32LE(0x3c);
  if (pe.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('node.exe is not a PE file');
  const optional = peOffset + 24;
  if (pe.readUInt16LE(optional) !== 0x20b) throw new Error('expected a 64-bit (PE32+) node.exe');
  const securityEntry = optional + 112 + 4 * 8; // data directory 4: the certificate table
  const certOffset = pe.readUInt32LE(securityEntry);
  const certSize = pe.readUInt32LE(securityEntry + 4);
  if (certSize === 0) return pe;
  if (certOffset + certSize !== pe.length) throw new Error('certificate table is not at the end of node.exe');
  const out = Buffer.from(pe.subarray(0, certOffset));
  out.writeUInt32LE(0, securityEntry);
  out.writeUInt32LE(0, securityEntry + 4);
  return out;
}

function inject(binary, extra = []) {
  execFileSync(process.execPath, [
    'node_modules/postject/dist/cli.js', binary, 'NODE_SEA_BLOB', `${OUT}/sea-prep.blob`,
    '--sentinel-fuse', FUSE, ...extra,
  ], { stdio: 'inherit' });
}

// Linux build from this machine's own Node.
copyFileSync(process.execPath, `${RELEASE}/flix-ug`);
chmodSync(`${RELEASE}/flix-ug`, 0o755);
inject(`${RELEASE}/flix-ug`);

// Windows build from the official node.exe of the same version.
const cache = `${OUT}/node-${VERSION}-win-x64.exe`;
if (!existsSync(cache)) {
  const base = `https://nodejs.org/dist/${VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  if (!expected) throw new Error('win-x64/node.exe not listed in SHASUMS256.txt');
  const res = await fetch(`${base}/win-x64/node.exe`);
  if (!res.ok) throw new Error(`node.exe download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`node.exe checksum mismatch: ${actual} != ${expected}`);
  writeFileSync(cache, bytes);
  console.log(`Downloaded and verified node.exe ${VERSION} (sha256 ${expected.slice(0, 12)}…)`);
}
// Adding the blob breaks node.exe's Authenticode signature, and Windows warns harder about a broken
// signature than a missing one, so remove the signature first: the result is a plain unsigned program.
writeFileSync(`${RELEASE}/flix-ug.exe`, stripPeSignature(readFileSync(cache)));
inject(`${RELEASE}/flix-ug.exe`);

const mb = (p) => (readFileSync(p).length / 1048576).toFixed(1);
console.log(`Built ${RELEASE}/flix-ug.exe (${mb(`${RELEASE}/flix-ug.exe`)} MB) and ${RELEASE}/flix-ug (${mb(`${RELEASE}/flix-ug`)} MB)`);
