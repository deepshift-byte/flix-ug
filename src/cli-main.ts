import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as sea from 'node:sea';
import { openDb, type Db } from './db.js';
import { buildApp } from './http/app.js';
import { jsonCatalog, type TitleCatalog, type TitleEntry } from './catalog/title-catalog.js';
import { readAssetBytes } from './assets.js';
import { describeMovieFile } from './catalog/describe-file.js';
import { createToken } from './tokens/token-service.js';
import { getBalance, topUp } from './tokens/ledger.js';
import { priceFor } from './pricing.js';
import { httpServerClient } from './kiosk/http-client.js';
import { downloadToUsb } from './kiosk/usb-download.js';
import { VERSION } from './index.js';

const HELP = `FLIX-UG ${VERSION} — test build

  flix-ug                                  Start the shop server (demo movie and token on first run)
  flix-ug add-movie <file> [--title ID] [--series EPISODES]
                                           Add a movie or series file to the catalog
  flix-ug new-token [--amount UGX] [--pin PIN]
                                           Sell a token (default 5000 UGX, random 4-digit PIN)
  flix-ug top-up <token> <amount>          Add UGX to an existing token
  flix-ug balance <token>                  Show a token's balance
  flix-ug kiosk <folder> <token> <pin> <title> [--server URL]
                                           Copy a movie to a flash disk or folder (resumable)

Data is kept in the flix-data folder next to the program.`;

function dataHome(): string {
  if (process.env.FLIX_HOME) return resolve(process.env.FLIX_HOME);
  const base = sea.isSea() ? dirname(process.execPath) : process.cwd();
  return join(base, 'flix-data');
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const openCatalog = (home: string) => jsonCatalog(join(home, 'catalog.json'));

function openHome(): { home: string; db: Db } {
  const home = dataHome();
  mkdirSync(home, { recursive: true });
  return { home, db: openDb(join(home, 'flix.db')) };
}

function signingSecret(home: string): Buffer {
  const path = join(home, 'secret.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'));
  return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
}

const randomPin = () => String(randomInt(0, 10_000)).padStart(4, '0');
const slug = (name: string) => name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function sellToken(db: Db, amount: number, pin: string): string {
  const { tokenNumber } = createToken(db, pin);
  topUp(db, tokenNumber, amount, `counter-${randomUUID()}`);
  return tokenNumber;
}

const DEMO_TITLES: Omit<TitleEntry, 'filePath' | 'fileSize' | 'chunkHashes' | 'fileChecksum'>[] = [
  { titleId: 'demo-kampala-nights', name: 'Kampala Nights', kind: 'movie', episodes: 1, year: 2025, genre: 'Drama',
    description: 'On his last night driving a taxi through Kampala, Musa picks up a passenger who knows far too much about him.' },
  { titleId: 'demo-the-last-boda', name: 'The Last Boda', kind: 'movie', episodes: 1, year: 2024, genre: 'Action',
    description: 'A boda boda rider caught between two gangs has one night to deliver a package that both sides want.' },
  { titleId: 'demo-rwenzori-rising', name: 'Rwenzori Rising', kind: 'movie', episodes: 1, year: 2023, genre: 'Adventure',
    description: 'Three friends attempt the Mountains of the Moon in the rainy season, and the mountain has other plans.' },
  { titleId: 'demo-matooke-money', name: 'Matooke Money', kind: 'movie', episodes: 1, year: 2025, genre: 'Comedy',
    description: 'A market trader accidentally becomes the most famous investor in town. Nobody, least of all him, knows why.' },
  { titleId: 'demo-nile-runners', name: 'Nile Runners', kind: 'series', episodes: 12, year: 2024, genre: 'Action',
    description: 'Twelve episodes of smugglers, river police and one stubborn fisherman on the source of the Nile.' },
  { titleId: 'demo-silent-city', name: 'Silent City', kind: 'movie', episodes: 1, year: 2022, genre: 'Thriller',
    description: 'When every phone in the city goes dead, a radio presenter is the only voice people can hear.' },
  { titleId: 'demo-lake-victoria', name: 'Lake Victoria Secrets', kind: 'movie', episodes: 1, year: 2024, genre: 'Romance',
    description: 'Two families, one island, and a wedding that nobody agreed to.' },
  { titleId: 'demo-code-breakers', name: 'Code Breakers', kind: 'series', episodes: 8, year: 2025, genre: 'Drama',
    description: 'Eight episodes following students at a Kampala coding school as they build an app that could change everything.' },
  { titleId: 'demo-market-day', name: 'Market Day', kind: 'movie', episodes: 1, year: 2023, genre: 'Comedy',
    description: 'Everything that can go wrong at Owino market goes wrong on the busiest day of the year.' },
  { titleId: 'demo-shadow-protocol', name: 'Shadow Protocol', kind: 'movie', episodes: 1, year: 2025, genre: 'Thriller',
    description: 'A retired agent is pulled back for one job: find the leak before the summit begins.' },
];

// First run, or an older build's single bare "demo-movie": fill the shop with demo titles so there is something to browse.
async function ensureDemoCatalog(home: string, catalog: TitleCatalog): Promise<void> {
  const entries = catalog.list();
  const onlyOldDemo = entries.length === 1 && entries[0].titleId === 'demo-movie' && !entries[0].name;
  if (entries.length > 0 && !onlyOldDemo) return;
  if (onlyOldDemo) catalog.remove('demo-movie');

  // Test data, not a playable video: 12 MB spans three 4 MB chunks, enough to see resume and charging work.
  const moviePath = join(home, 'demo-movie.mp4');
  if (!existsSync(moviePath)) {
    const content = Buffer.alloc(12 * 1024 * 1024 + 321);
    for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;
    writeFileSync(moviePath, content);
  }
  const media = join(home, 'media');
  mkdirSync(media, { recursive: true });
  const trailerPath = join(media, 'demo-trailer.webm');
  writeFileSync(trailerPath, readAssetBytes('shop/demo-trailer.webm'));

  const described = await describeMovieFile(moviePath, { titleId: 'demo', kind: 'movie', episodes: 1 });
  DEMO_TITLES.forEach((t, i) => {
    catalog.upsert({
      ...described, ...t, trailerPath,
      addedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    });
  });
}

function adminPassword(home: string): string {
  const path = join(home, 'admin-password.txt');
  if (!existsSync(path)) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    writeFileSync(path, Array.from({ length: 8 }, () => alphabet[randomInt(0, alphabet.length)]).join('') + '\n');
  }
  return readFileSync(path, 'utf8').trim();
}

function ensureDemoToken(home: string, db: Db): { tokenNumber: string; pin: string } {
  const path = join(home, 'demo-token.txt');
  if (existsSync(path)) {
    const [tokenNumber, pin] = readFileSync(path, 'utf8').trim().split(/\s+/);
    return { tokenNumber, pin };
  }
  const pin = randomPin();
  const tokenNumber = sellToken(db, 5000, pin);
  writeFileSync(path, `${tokenNumber} ${pin}\n`);
  return { tokenNumber, pin };
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser available: the address is printed in the window.
  }
}

async function serve(args: string[]): Promise<void> {
  const noBrowser = args.includes('--no-browser');
  const { home, db } = openHome();
  const catalog = openCatalog(home);
  await ensureDemoCatalog(home, catalog);
  const demo = ensureDemoToken(home, db);
  const password = adminPassword(home);
  const port = Number(process.env.FLIX_PORT ?? 8080);
  const app = buildApp({
    db, signingSecret: signingSecret(home), catalog, mediaDir: join(home, 'media'), adminPassword: password,
  });
  await app.listen({ port, host: '0.0.0.0' });

  const shopUrl = `http://localhost:${port}/`;
  console.log(`\nFLIX-UG ${VERSION} is running.  Data folder: ${home}\n`);
  console.log(`Shop screen (customers):     ${shopUrl}`);
  console.log(`Attendant screen:            http://localhost:${port}/admin     password: ${password}`);
  for (const ip of lanAddresses()) console.log(`From a phone on the same Wi-Fi: http://${ip}:${port}/`);
  console.log(`\nDemo token: ${demo.tokenNumber}   PIN: ${demo.pin}   Balance: ${getBalance(db, demo.tokenNumber)} UGX`);
  console.log(`${catalog.list().length} titles in the shop. Add your own on the attendant screen.`);
  console.log('\nTo copy to a flash disk, use Google Chrome or Microsoft Edge on this PC.');
  console.log('Keep this window open while the shop is in use. Press Ctrl+C to stop.\n');
  if (!noBrowser) openBrowser(shopUrl);
}

async function addMovie(args: string[]): Promise<void> {
  const titleOpt = option(args, '--title');
  const episodesOpt = option(args, '--series');
  const file = args[0];
  if (!file) throw new Error('add-movie needs a file: flix-ug add-movie <file>');
  const path = resolve(file);
  const titleId = titleOpt ?? slug(basename(path));
  const kind = episodesOpt ? 'series' : 'movie';
  const episodes = episodesOpt ? Number(episodesOpt) : 1;
  console.log(`Reading ${path} ...`);
  const entry = await describeMovieFile(path, { titleId, kind, episodes });
  const { home } = openHome();
  openCatalog(home).upsert({ ...entry, name: titleOpt ?? basename(path).replace(/\.[^.]+$/, ''), addedAt: new Date().toISOString() });
  console.log(`Added "${titleId}" (${(entry.fileSize / 1048576).toFixed(1)} MB, ${priceFor(kind, episodes)} UGX).`);
  console.log('Restart the server to offer it.');
}

function newToken(args: string[]): void {
  const amount = Number(option(args, '--amount') ?? 5000);
  const pin = option(args, '--pin') ?? randomPin();
  const { db } = openHome();
  const tokenNumber = sellToken(db, amount, pin);
  console.log(`Token: ${tokenNumber}   PIN: ${pin}   Balance: ${getBalance(db, tokenNumber)} UGX`);
}

function topUpToken(args: string[]): void {
  const [tokenNumber, amount] = args;
  if (!tokenNumber || !amount) throw new Error('usage: flix-ug top-up <token> <amount>');
  const { db } = openHome();
  topUp(db, tokenNumber, Number(amount), `counter-${randomUUID()}`);
  console.log(`Token ${tokenNumber} balance: ${getBalance(db, tokenNumber)} UGX`);
}

function balance(args: string[]): void {
  const [tokenNumber] = args;
  if (!tokenNumber) throw new Error('usage: flix-ug balance <token>');
  const { db } = openHome();
  console.log(`Token ${tokenNumber} balance: ${getBalance(db, tokenNumber)} UGX`);
}

async function kiosk(args: string[]): Promise<void> {
  const server = option(args, '--server') ?? `http://localhost:${process.env.FLIX_PORT ?? 8080}`;
  const [folder, tokenNumber, pin, titleId] = args;
  if (!folder || !tokenNumber || !pin || !titleId) throw new Error('usage: flix-ug kiosk <folder> <token> <pin> <title>');
  const base = httpServerClient(server);
  let fileSize = 0;
  const client = {
    ...base,
    startSession: async (input: Parameters<typeof base.startSession>[0]) => {
      const r = await base.startSession(input);
      if (r.ok) fileSize = r.info.fileSize;
      return r;
    },
    status: async (sessionId: string) => {
      const s = await base.status(sessionId);
      fileSize = s.fileSize;
      return s;
    },
    confirm: async (sessionId: string, offset: number) => {
      await base.confirm(sessionId, offset);
      if (fileSize) process.stdout.write(`\r  copied ${Math.floor((offset / fileSize) * 100)}%   `);
    },
  };
  console.log(`Copying "${titleId}" to ${resolve(folder)} ...`);
  const result = await downloadToUsb({
    client, usbDir: resolve(folder), tokenNumber, pin, titleId, fileName: `${titleId}.mp4`,
  });
  process.stdout.write('\n');
  if (result.ok) console.log(`Done: ${result.path}`);
  else console.log(`Stopped: ${result.reason}. Run the same command again to resume; nothing extra is charged.`);
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((done) => rl.question('Press Enter to close.', () => done()));
  rl.close();
}

export async function main(argv: string[]): Promise<void> {
  const [command = 'serve', ...args] = argv;
  try {
    if (command === 'serve' || command === '--no-browser') await serve(argv);
    else if (command === 'add-movie') await addMovie(args);
    else if (command === 'new-token') newToken(args);
    else if (command === 'top-up') topUpToken(args);
    else if (command === 'balance') balance(args);
    else if (command === 'kiosk') await kiosk(args);
    else console.log(HELP);
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    // A double-clicked window would otherwise close before the message can be read.
    if (sea.isSea() && process.platform === 'win32') await waitForEnter();
    process.exitCode = 1;
  }
}
