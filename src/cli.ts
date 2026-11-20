// Loaded first, so the warning filter is in place before SQLite is loaded.
import './quiet-warnings.js';
import { main } from './cli-main.js';

main(process.argv.slice(2));
