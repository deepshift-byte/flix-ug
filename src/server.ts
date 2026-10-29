import { openDb } from './db.js';
import { loadCatalog } from './catalog/title-catalog.js';
import { buildApp } from './http/app.js';

const signingSecret = process.env.FLIX_SIGNING_SECRET;
if (!signingSecret) {
  console.error('FLIX_SIGNING_SECRET is required');
  process.exit(1);
}

const db = openDb(process.env.FLIX_DB_PATH ?? 'flix.db');
const catalog = loadCatalog(process.env.FLIX_CATALOG_FILE ?? 'catalog.json');
const app = buildApp({ db, signingSecret: Buffer.from(signingSecret, 'utf8'), catalog });

app.listen({ port: Number(process.env.FLIX_PORT ?? 8080), host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
