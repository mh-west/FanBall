// Every script and stylesheet the site loads carries ?v=<content hash> (tools/stamp-assets.py), because
// dist/_headers lets browsers cache them for a year. A stale stamp would keep old code in people's browsers,
// so this fails until `python3 -I tools/stamp-assets.py` has been run after a change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dist = new URL('../dist/', import.meta.url);
const hash = rel => createHash('sha256').update(readFileSync(new URL(rel, dist))).digest('hex').slice(0, 10);

test('index.html loads each local script and stylesheet with its current content hash', () => {
  const html = readFileSync(new URL('index.html', dist), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\/([A-Za-z0-9_./-]+\.(?:js|css))(\?v=([0-9a-f]+))?"/g)];
  assert.ok(refs.length >= 20, `found ${refs.length} local assets`);
  for (const [, file, , v] of refs) assert.equal(v, hash(file), `${file}: run python3 -I tools/stamp-assets.py`);
});

test('module imports carry the current hash (except the engine’s count tables)', () => {
  for (const file of ['ai-game.js', 'ai-manager.js', 'local-game.js']) {
    const src = readFileSync(new URL(file, dist), 'utf8');
    for (const [, path, , v] of src.matchAll(/from\s+['"]\.\/([A-Za-z0-9_./-]+\.js)(\?v=([0-9a-f]+))?['"]/g)) {
      assert.equal(v, hash(path), `${file} imports ${path}: run python3 -I tools/stamp-assets.py`);
    }
  }
  assert.match(readFileSync(new URL('engine/pitch-engine.js', dist), 'utf8'), /from '\.\/count-tables\.js';/, 'the engine import stays unstamped');
});

test('_headers caches scripts for a year but never the page or the count tables', () => {
  const h = readFileSync(new URL('_headers', dist), 'utf8');
  assert.match(h, /\/\*\.js\n\s+Cache-Control: public, max-age=31536000, immutable/);
  assert.match(h, /\/index\.html\n\s+Cache-Control: no-store/);
  assert.match(h, /\/engine\/count-tables\.js\n\s+! Cache-Control\n\s+Cache-Control: no-cache/);
});
