import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessGs } from '../scripts/build-demo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the synthetic Apps Script pack matches the photo module and stays off production', () => {
  const built = buildHarnessGs();
  const committed = readFileSync(join(root, 'gas/synthetic-harness/Code.gs'), 'utf8');
  assert.equal(committed, built);
  assert.match(committed, /function runSyntheticSelfTest\(/);
  assert.match(committed, /function photoReceiptImport_\(/);
  assert.match(committed, /SYNTHETIC_ONLY/);
  assert.match(committed, /gmail-demo-a/);
  assert.match(committed, /2026\/04\/01 12:34/);
  assert.match(committed, /syntheticIdOk_/);
  assert.equal(committed.includes('script.google.com'), false);
  assert.equal(committed.includes('AKfycb'), false);
  assert.equal(committed.includes("action === 'confirmReceipt'"), false);
  assert.equal(committed.includes('gmail.readonly'), false);
  const checks = committed.match(/check\('/g) || [];
  assert.equal(checks.length, 16);
  const readme = readFileSync(join(root, 'gas/synthetic-harness/README.md'), 'utf8');
  assert.match(readme, /16 件すべて成功/);
  assert.match(readme, /spreadsheets\.currentonly/);
  assert.match(readme, /自分のみ/);
  const manifest = JSON.parse(readFileSync(join(root, 'gas/synthetic-harness/appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets.currentonly']);
});
