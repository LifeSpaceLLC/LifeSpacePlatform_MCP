// -- ClaudeCode (2026-07-08): Apply LifeSpace Connect schema. Run once per
// deploy: `npm run apply-schema`. Idempotent + additive (see http/db.ts DDL).
import 'dotenv/config';
import { applySchema, sql } from './db.js';

try {
  await applySchema();
  console.log('\nConnect schema applied successfully.');
} catch (err) {
  console.error('\nFailed:', err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
