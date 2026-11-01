// Keeps the site themeable: colors live in app/styles/tokens.css, and every section toggle stays wired up.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../lib/moduleRegistry.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = dir => readdirSync(join(ROOT, dir)).filter(f => /\.(js|css)$/.test(f)).map(f => join(dir, f));
const THEMED_FILES = ['app/globals.css', 'app/styles/system.css', 'app/(public)/page.js', ...files('components'), ...files('components/admin')];
const LITERAL = /(?<![&\w(])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\brgba?\(/gi;

test('themed files contain no color literals', () => {
  const found = THEMED_FILES.flatMap(file => (readFileSync(join(ROOT, file), 'utf8').match(LITERAL) || []).map(m => `${file}: ${m}`));
  assert.deepEqual(found, []);
});

test('every section slug is still referenced', () => {
  const source = [...files('components'), 'app/(public)/page.js'].map(f => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const missing = MODULES.flatMap(m => m.sections.map(([slug]) => slug)).filter(slug => !source.includes(`'${slug}'`));
  assert.deepEqual(missing, []);
});
