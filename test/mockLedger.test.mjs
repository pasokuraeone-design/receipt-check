import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/receiptImport.js');
const { createMockLedger } = require('../src/mockLedger.js');

const CASH = 'ab'.repeat(32);
const CARD = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);

function document(hash, receipt) {
  return {
    schemaVersion: 1,
    source: 'grok-bot-photo',
    photo: { sha256: hash, byteLength: 32 },
    receipt,
    unreadable: []
  };
}

function exclusiveReceipt(payment) {
  return {
    purchaseDate: '2026-04-01',
    purchaseTime: '12:34',
    storeName: 'サンプル商店',
    paymentMethod: payment,
    taxMode: 'exclusive',
    subtotalYen: 1000,
    discountYen: 0,
    taxYen: 80,
    totalYen: 1080,
    items: [
      { name: 'サンプル卵', amountYen: 400, qty: 1, category: '食費', facility: '山手', taxRate: 8 },
      { name: 'サンプル洗剤', amountYen: 600, qty: 1, category: '日用品費', facility: '新神野', taxRate: 8 }
    ]
  };
}

function postOf(ledger, hash, receipt, reviewExtra) {
  const parsed = R.parseImportJson(JSON.stringify(document(hash, receipt)));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  const review = Object.assign(R.initialReview(parsed.document), reviewExtra || {});
  review.addedTaxYen = review.taxMode === 'inclusive' ? 0 : review.taxYen;
  const body = ledger.read();
  const result = R.evaluateReviewed(parsed.document, review, {
    verifiedPhotoSha256: hash,
    verifiedPhotoByteLength: 32,
    capabilitiesBody: body,
    cardPending: body.cardPending
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.post;
}

test('mock ledger keeps the printed date and does not duplicate an exact resend', () => {
  const ledger = createMockLedger();
  const post = postOf(ledger, CASH, exclusiveReceipt('現金'));
  const first = ledger.apply(post);
  assert.equal(first.status, 'success');
  assert.equal(first.demo, true);
  assert.equal(first.purchaseDate, '2026-04-01');
  assert.equal(first.added > 0, true);
  const written = ledger.snapshot().filter(row => row.id.startsWith('photo-' + CASH));
  assert.equal(written[0].purchaseDate, '2026/04/01 12:34');
  assert.deepEqual(written.filter(row => row.category !== '消費税').map(row => row.amount), [400, 600]);
  assert.equal(written.filter(row => row.category === '消費税').reduce((sum, row) => sum + row.amount, 0), 80);
  assert.equal(written.every(row => row.tax === '' && row.total === ''), true);
  assert.equal(written.some(row => row.amount === 1080), false);
  const count = ledger.snapshot().length;
  const again = ledger.apply(post);
  assert.equal(again.duplicate, true);
  assert.equal(again.added, 0);
  assert.equal(ledger.snapshot().length, count);
  assert.equal(R.interpretSaveResponse(again, {
    action: post.action,
    receiptId: post.receiptId,
    purchaseDate: post.purchaseDate
  }).ok, true);
});

test('partial retry writes only the missing photo line', () => {
  const ledger = createMockLedger();
  const post = postOf(ledger, CASH, exclusiveReceipt('現金'));
  ledger.apply(post);
  const before = ledger.snapshot().filter(row => row.id.startsWith('photo-' + CASH)).length;
  assert.equal(ledger.dropLastPhotoLine(post.receiptId), true);
  const retry = ledger.apply(post);
  assert.equal(retry.duplicate, false);
  assert.equal(retry.added, 1);
  const after = ledger.snapshot().filter(row => row.id.startsWith('photo-' + CASH));
  assert.equal(after.length, before);
  assert.equal(after.every(row => row.purchaseDate === '2026/04/01 12:34'), true);
});

test('same date and amount with another hash is stored again', () => {
  const ledger = createMockLedger();
  ledger.apply(postOf(ledger, CASH, exclusiveReceipt('現金')));
  const second = ledger.apply(postOf(ledger, OTHER, exclusiveReceipt('現金')));
  assert.equal(second.duplicate, false);
  assert.equal(second.added > 0, true);
  const ids = ledger.snapshot().map(row => row.id);
  assert.equal(ids.some(id => id.startsWith('photo-' + CASH)), true);
  assert.equal(ids.some(id => id.startsWith('photo-' + OTHER)), true);
});

test('card import is not a second expense and ignores a shifted row index', () => {
  const ledger = createMockLedger();
  const card = exclusiveReceipt('カード');
  const post = postOf(ledger, CARD, card, {
    cardSelection: { rowIndex: 2, id: 'gmail-demo-a', explicit: true }
  });
  assert.equal(post.action, 'photoReceiptCardBreakdown');
  const plain = Object.assign({}, post, { action: 'photoReceiptImport' });
  delete plain.sourceRowIndex;
  delete plain.expectedId;
  delete plain.expectedAmount;
  const rejected = ledger.apply(plain);
  assert.equal(rejected.status, 'error');
  assert.equal(ledger.snapshot().some(row => String(row.id).startsWith('photo-')), false);

  ledger.shift();
  const shifted = ledger.apply(post);
  assert.equal(shifted.status, 'error');
  assert.equal(ledger.snapshot().find(row => row.id === 'gmail-demo-a').amount, 1080);
  assert.equal(ledger.snapshot().find(row => row.id === 'gmail-demo-b').amount, 500);

  ledger.reset();
  const saved = ledger.apply(post);
  assert.equal(saved.status, 'success', JSON.stringify(saved));
  const source = ledger.snapshot().find(row => row.id === 'gmail-demo-a');
  assert.equal(source.amount, 0);
  assert.equal(source.facility, '済');
  assert.equal(source.category, '内訳入力済み');
  assert.equal(ledger.snapshot().find(row => row.id === 'gmail-demo-b').amount, 500);
  const lines = ledger.snapshot().filter(row => row.id.startsWith('photo-' + CARD));
  assert.equal(lines.reduce((sum, row) => sum + row.amount, 0), 1080);
  assert.equal(lines[0].purchaseDate.startsWith('2026/04/01'), true);
  const resend = ledger.apply(post);
  assert.equal(resend.duplicate, true);
  assert.equal(resend.added, 0);
  assert.equal(ledger.snapshot().filter(row => row.id.startsWith('photo-' + CARD)).length, lines.length);
});

test('a non-gmail row with the same date and amount is not a card match', () => {
  const ledger = createMockLedger();
  const body = ledger.read();
  assert.equal(body.demo, true);
  assert.equal(body.capabilities.photoReceiptImport, 1);
  const manual = body.cardPending.find(row => row.id === 'synthetic-manual');
  const parsed = R.parseImportJson(JSON.stringify(document(CARD, exclusiveReceipt('カード'))));
  const review = R.initialReview(parsed.document);
  review.addedTaxYen = 80;
  review.cardSelection = null;
  const result = R.evaluateReviewed(parsed.document, review, {
    verifiedPhotoSha256: CARD,
    verifiedPhotoByteLength: 32,
    capabilitiesBody: body,
    cardPending: body.cardPending
  });
  assert.equal(result.card.candidates.find(row => row.id === 'gmail-demo-a').autoSelected, false);
  assert.equal(result.card.candidates.find(row => row.id === 'gmail-demo-a').proofOfDuplicate, false);
  assert.equal(result.card.candidates.find(row => row.id === manual.id).selectable, false);
  assert.equal(result.post, null);
});
