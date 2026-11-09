// Post-install sanity check: verifies the SQLite driver compiled/loaded.
// It never blocks installation — the server prints a clear diagnostic instead.
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a INTEGER)');
  db.close();
  console.log('[#ash Mesh] better-sqlite3 OK');
} catch (err) {
  console.warn('[#ash Mesh] better-sqlite3 failed to load:', err.message);
  console.warn('[#ash Mesh] run: npm rebuild better-sqlite3');
}
