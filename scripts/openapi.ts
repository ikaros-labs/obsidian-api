/**
 * Writes openapi.json at the repo root from the route schemas. `npm run openapi`; a test fails
 * when the committed file is stale.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../src/http/server.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../openapi.json');
writeFileSync(out, `${JSON.stringify(await openApiDocument(), null, 2)}\n`);
console.log(`Wrote ${out}`);
