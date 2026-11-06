import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function inlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script');
}

export function buildDemoHtml() {
  const template = readFileSync(join(root, 'demo/template.html'), 'utf8');
  const receipt = inlineScript(readFileSync(join(root, 'src/receiptImport.js'), 'utf8'));
  const ledger = inlineScript(readFileSync(join(root, 'src/mockLedger.js'), 'utf8'));
  return template
    .replace('/*__RECEIPT_IMPORT__*/', () => receipt)
    .replace('/*__MOCK_LEDGER__*/', () => ledger);
}

export function buildHarnessGs() {
  const photo = readFileSync(join(root, 'gas/photoReceiptImport.gs'), 'utf8');
  const harness = readFileSync(join(root, 'gas/synthetic-harness/Harness.gs'), 'utf8');
  return [
    '/**',
    ' * Synthetic-only Apps Script. Install in a NEW spreadsheet project.',
    ' * Do not paste this over the production コード.gs.',
    ' * Generated from gas/photoReceiptImport.gs and gas/synthetic-harness/Harness.gs.',
    ' */',
    '',
    photo.trim(),
    '',
    harness.trim(),
    ''
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('build-demo.mjs')) {
  writeFileSync(join(root, 'demo/receipt-photo-demo.html'), buildDemoHtml());
  writeFileSync(join(root, 'gas/synthetic-harness/Code.gs'), buildHarnessGs());
}
