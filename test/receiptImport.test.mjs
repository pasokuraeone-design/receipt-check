import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const R = require('../src/receiptImport.js');
const root = dirname(fileURLToPath(import.meta.url));
const examplePath = join(root, '..', 'examples', 'receipt-photo-import.example.json');

const HASH = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function capabilitiesBody() {
  return { capabilities: { ...R.REQUIRED_CAPABILITIES, extra: true } };
}

function baseReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'grok-bot-photo',
    photo: { sha256: HASH, byteLength: 128 },
    receipt: {
      purchaseDate: '2026-04-01',
      purchaseTime: '12:34',
      storeName: 'サンプル商店',
      paymentMethod: '現金',
      taxMode: 'exclusive',
      subtotalYen: 1000,
      discountYen: 0,
      taxYen: 80,
      totalYen: 1080,
      items: [
        { name: 'サンプル卵', amountYen: 400, qty: 1, category: '食費', facility: '山手', taxRate: 8 },
        { name: 'サンプル洗剤', amountYen: 600, qty: 2, category: '日用品費', facility: '新神野', taxRate: 8 }
      ]
    },
    unreadable: [],
    notes: null,
    ...overrides
  };
}

function parsed(doc) {
  const result = R.parseImportJson(JSON.stringify(doc));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.document;
}

function reviewed(doc, extra = {}) {
  const review = R.initialReview(parsed(doc));
  review.addedTaxYen = review.taxMode === 'inclusive' ? 0 : review.taxYen;
  return { ...review, ...extra };
}

function ctx(doc, extra = {}) {
  return {
    verifiedPhotoSha256: doc.photo.sha256,
    verifiedPhotoByteLength: doc.photo.byteLength,
    capabilitiesBody: capabilitiesBody(),
    cardPending: [],
    ...extra
  };
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test('schema rejects malformed JSON, prototypes, embedded photos, and non-integers', () => {
  assert.equal(R.parseImportJson('{').ok, false);
  assert.equal(R.parseImportJson('[]').errors[0].code, 'not-object');
  assert.equal(R.parseImportJson('{"__proto__":{"admin":true}}').errors[0].code, 'forbidden-key');
  assert.ok(codes(R.parseImportJson(JSON.stringify({ schemaVersion: 2 }))).includes('bad-schema-version'));

  const embedded = baseReceipt();
  embedded.photo.image = 'data:image/jpeg;base64,AAAA';
  assert.ok(codes(R.parseImportJson(JSON.stringify(embedded))).includes('photo-embedded'));

  const upper = baseReceipt();
  upper.photo.sha256 = HASH.toUpperCase();
  assert.ok(codes(R.parseImportJson(JSON.stringify(upper))).includes('bad-sha256'));

  const fraction = baseReceipt();
  fraction.receipt.totalYen = 10.5;
  assert.ok(codes(R.parseImportJson(JSON.stringify(fraction))).includes('bad-money'));

  const textMoney = baseReceipt();
  textMoney.receipt.items[0].amountYen = '400';
  assert.ok(codes(R.parseImportJson(JSON.stringify(textMoney))).includes('bad-money'));

  const badDate = baseReceipt();
  badDate.receipt.purchaseDate = '2026-02-31';
  assert.ok(codes(R.parseImportJson(JSON.stringify(badDate))).includes('bad-date'));

  const contradiction = baseReceipt();
  contradiction.unreadable = ['receipt.totalYen'];
  assert.ok(codes(R.parseImportJson(JSON.stringify(contradiction))).includes('unreadable-contradiction'));

  assert.ok(codes(R.parseImportJson('{"a":1}'.padEnd(R.MAX_JSON_BYTES + 1, ' '))).includes('too-large'));
});

test('missing values stay unresolved and block save without defaulting facility, category, or payment', () => {
  const doc = baseReceipt();
  doc.receipt.paymentMethod = null;
  doc.receipt.taxMode = null;
  doc.receipt.totalYen = null;
  doc.receipt.taxYen = null;
  doc.receipt.discountYen = null;
  doc.receipt.purchaseDate = null;
  doc.receipt.items[0].facility = null;
  doc.receipt.items[0].category = null;
  doc.receipt.items[0].amountYen = null;
  doc.unreadable = [
    'receipt.paymentMethod',
    'receipt.taxMode',
    'receipt.totalYen',
    'receipt.taxYen',
    'receipt.discountYen',
    'receipt.purchaseDate',
    'receipt.items.0.facility',
    'receipt.items.0.category',
    'receipt.items.0.amountYen'
  ];
  const document = parsed(doc);
  const initial = R.initialReview(document);
  assert.equal(initial.paymentMethod, null);
  assert.equal(initial.taxMode, null);
  assert.equal(initial.items[0].facility, null);
  assert.equal(initial.items[0].category, null);
  assert.equal(initial.items[0].amountYen, null);
  assert.notEqual(initial.paymentMethod, 'カード');
  assert.notEqual(initial.items[0].facility, '山手');
  assert.notEqual(initial.items[1].category, '備品');

  const result = R.evaluateReviewed(document, initial, ctx(doc));
  assert.equal(result.ok, false);
  assert.equal(result.post, null);
  for (const code of ['unresolved']) {
    assert.ok(codes(result).includes(code));
  }
  assert.ok(result.errors.some((error) => error.path === 'receipt.purchaseDate'));
  assert.ok(result.errors.some((error) => error.path === 'receipt.items.0.amountYen'));
  assert.ok(result.errors.some((error) => error.path === 'receipt.items.0.facility'));
  assert.ok(result.errors.some((error) => error.path === 'receipt.items.0.category'));
});

test('exclusive tax is allocated once and item amounts stay as read', () => {
  const doc = baseReceipt();
  const document = parsed(doc);
  const result = R.evaluateReviewed(document, reviewed(doc), ctx(doc));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.post.action, 'photoReceiptImport');
  assert.equal(result.post.purchaseDate, '2026-04-01');
  assert.equal(result.post.paymentMethod, '現金');
  const items = result.lines.filter((line) => line.role === 'item');
  const taxes = result.lines.filter((line) => line.role === 'tax');
  assert.deepEqual(items.map((line) => line.amount), [400, 600]);
  assert.equal(items[0].qty, 1);
  assert.equal(items[1].qty, 2);
  assert.equal(taxes.reduce((sum, line) => sum + line.amount, 0), 80);
  assert.equal(result.lines.reduce((sum, line) => sum + line.amount, 0), 1080);
  assert.ok(items.every((line) => line.amount !== 1080 && line.amount !== 80));
  assert.equal(result.post.lines.some((line) => line.amount === 1080), false);
});

test('exclusive split uses the existing yamate-round then remainder allocation', () => {
  const lines = R.allocateExclusiveTax([
    { facility: '山手', amountYen: 100 },
    { facility: '新神野', amountYen: 200 }
  ], 10);
  assert.deepEqual(lines.map((line) => [line.facility, line.amount]), [['山手', 3], ['新神野', 7]]);
});

test('discount is one negative line and is not spread back into the items', () => {
  const doc = baseReceipt();
  doc.receipt.discountYen = 100;
  doc.receipt.taxYen = 72;
  doc.receipt.totalYen = 972;
  doc.receipt.items.forEach((item) => { item.taxRate = null; });
  const document = parsed(doc);
  const missingFacility = R.evaluateReviewed(document, reviewed(doc), ctx(doc));
  assert.ok(codes(missingFacility).includes('discount-facility'));
  assert.equal(missingFacility.post, null);

  const result = R.evaluateReviewed(document, reviewed(doc, { discountFacility: '山手' }), ctx(doc));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const items = result.lines.filter((line) => line.role === 'item');
  const discount = result.lines.find((line) => line.role === 'discount');
  assert.deepEqual(items.map((line) => line.amount), [400, 600]);
  assert.equal(discount.amount, -100);
  assert.equal(discount.facility, '山手');
  assert.equal(result.lines.filter((line) => line.role === 'tax').reduce((sum, line) => sum + line.amount, 0), 72);
  assert.equal(result.lines.reduce((sum, line) => sum + line.amount, 0), 972);
});

test('inclusive tax matches the total without a tax line or an added tax', () => {
  const doc = baseReceipt();
  doc.receipt.taxMode = 'inclusive';
  doc.receipt.subtotalYen = 1000;
  doc.receipt.discountYen = 0;
  doc.receipt.taxYen = 74;
  doc.receipt.totalYen = 1000;
  const document = parsed(doc);
  const doubled = R.evaluateReviewed(document, reviewed(doc, { totalYen: 1074, addedTaxYen: 74 }), ctx(doc));
  assert.ok(codes(doubled).includes('total-mismatch'));
  assert.ok(codes(doubled).includes('inclusive-tax-added'));
  assert.equal(doubled.post, null);

  const result = R.evaluateReviewed(document, reviewed(doc, { addedTaxYen: 0 }), ctx(doc));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.lines.some((line) => line.role === 'tax'), false);
  assert.deepEqual(result.lines.map((line) => line.amount), [400, 600]);
  assert.equal(result.lines.reduce((sum, line) => sum + line.amount, 0), 1000);
  assert.match(result.lines[0].note, /内消費税74円/);
  assert.doesNotMatch(result.lines[1].note, /74/);
});

test('inclusive discount stays a single negative line', () => {
  const doc = baseReceipt();
  doc.receipt.taxMode = 'inclusive';
  doc.receipt.items = [
    { name: 'サンプル弁当', amountYen: 1080, qty: 1, category: '食費', facility: '山手', taxRate: null }
  ];
  doc.receipt.subtotalYen = 1080;
  doc.receipt.discountYen = 80;
  doc.receipt.taxYen = 80;
  doc.receipt.totalYen = 1000;
  const document = parsed(doc);
  const result = R.evaluateReviewed(document, reviewed(doc, { addedTaxYen: 0, discountFacility: '山手' }), ctx(doc));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.lines.map((line) => line.amount), [1080, -80]);
  assert.equal(result.post.totalYen, 1000);
});

test('exclusive totals reject a missing tax and a double-counted tax', () => {
  const doc = baseReceipt();
  const document = parsed(doc);
  const forgotten = R.evaluateReviewed(document, reviewed(doc, { totalYen: 1000 }), ctx(doc));
  assert.ok(codes(forgotten).includes('total-mismatch'));
  const twice = R.evaluateReviewed(document, reviewed(doc, { totalYen: 1160 }), ctx(doc));
  assert.ok(codes(twice).includes('total-mismatch'));
  const bakedIn = R.evaluateReviewed(document, reviewed(doc, { addedTaxYen: 0 }), ctx(doc));
  assert.ok(codes(bakedIn).includes('exclusive-tax-added'));
});

test('stated tax that matches no standard rounding is kept unresolved', () => {
  const doc = baseReceipt();
  doc.receipt.taxYen = 50;
  doc.receipt.totalYen = 1050;
  const result = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc));
  assert.ok(codes(result).includes('exclusive-tax-mismatch'));
  assert.equal(result.post, null);
});

test('same photo is an exact resend; the same date and amount are not', () => {
  const doc = baseReceipt();
  const lines = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc)).lines;
  const first = R.planIdempotentWrite(HASH, lines, []);
  assert.equal(first.kind, 'write');
  assert.deepEqual(first.lines.map((line) => line.id), [0, 1, 2, 3].map((index) => R.lineId(HASH, index)));

  const retry = R.planIdempotentWrite(HASH, lines, first.lines.map((line) => line.id));
  assert.equal(retry.kind, 'duplicate');

  const partial = R.planIdempotentWrite(HASH, lines, [first.lines[0].id]);
  assert.equal(partial.kind, 'retry-partial');
  assert.deepEqual(partial.lines.map((line) => line.id), first.lines.slice(1).map((line) => line.id));

  const conflict = R.planIdempotentWrite(HASH, lines.slice(0, 1), first.lines.map((line) => line.id));
  assert.equal(conflict.kind, 'conflict');

  const other = R.planIdempotentWrite(OTHER, lines, first.lines.map((line) => line.id));
  assert.equal(other.kind, 'write');
  assert.equal(R.duplicateClass(
    { photoSha256: HASH, purchaseDate: '2026-04-01', totalYen: 1080 },
    { photoSha256: OTHER, purchaseDate: '2026-04-01', totalYen: 1080 }
  ), 'not-duplicate');
  assert.equal(R.duplicateClass(
    { photoSha256: HASH, purchaseDate: '2026-04-01', totalYen: 1080 },
    { photoSha256: HASH, purchaseDate: '2026-05-01', totalYen: 1 }
  ), 'exact-photo');
});

test('save stays closed until the backend confirms date and idempotency', () => {
  const doc = baseReceipt();
  const closed = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc, { capabilitiesBody: { pending: [] } }));
  assert.ok(codes(closed).includes('backend-unconfirmed'));
  assert.equal(closed.post, null);

  const partial = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc, {
    capabilitiesBody: { capabilities: { ...R.REQUIRED_CAPABILITIES, idempotency: false } }
  }));
  assert.equal(partial.post, null);

  const legacy = R.interpretSaveResponse(
    { status: 'success', updated: 0, added: 2 },
    { action: 'photoReceiptImport', receiptId: R.receiptKey(HASH), purchaseDate: '2026-04-01' }
  );
  assert.equal(legacy.ok, false);
  assert.equal(legacy.clearForm, false);

  const echoed = R.interpretSaveResponse({
    status: 'success',
    photoReceipt: true,
    action: 'photoReceiptImport',
    receiptId: R.receiptKey(HASH),
    purchaseDate: '2026-04-01',
    added: 4,
    skipped: 0,
    duplicate: false
  }, { action: 'photoReceiptImport', receiptId: R.receiptKey(HASH), purchaseDate: '2026-04-01' });
  assert.equal(echoed.ok, true);
});

test('card rows are reconciled only by an explicit id match and never as a second expense', () => {
  const doc = baseReceipt();
  doc.receipt.paymentMethod = 'カード';
  const document = parsed(doc);
  const pending = [
    { rowIndex: 5, id: 'gmail-sample-a', name: 'サンプル商店', amount: 1080, datetime: '2026/04/01' },
    { rowIndex: 6, id: 'gmail-sample-b', name: '別の店', amount: 500, datetime: '2026/04/02' },
    { rowIndex: 7, id: 'manual-row', name: '手入力', amount: 1080, datetime: '2026/04/01' }
  ];
  const blocked = R.evaluateReviewed(document, reviewed(doc), ctx(doc, { cardPending: pending }));
  assert.ok(codes(blocked).includes('card-row-required'));
  assert.equal(blocked.post, null);
  assert.equal(blocked.card.candidates.every((row) => row.autoSelected === false && row.proofOfDuplicate === false), true);
  assert.equal(blocked.card.candidates[0].similarAmount, true);
  assert.equal(blocked.card.candidates[0].similarDate, true);
  assert.equal(blocked.card.candidates[2].selectable, false);

  const hinted = R.evaluateReviewed(document, reviewed(doc, {
    cardSelection: { rowIndex: 5, id: 'gmail-sample-a', explicit: false }
  }), ctx(doc, { cardPending: pending }));
  assert.equal(hinted.post, null);

  const mismatch = R.evaluateReviewed(document, reviewed(doc, {
    cardSelection: { rowIndex: 6, id: 'gmail-sample-b', explicit: true }
  }), ctx(doc, { cardPending: pending }));
  assert.ok(codes(mismatch).includes('card-amount-mismatch'));
  assert.equal(mismatch.post, null);

  const result = R.evaluateReviewed(document, reviewed(doc, {
    cardSelection: { rowIndex: 5, id: 'gmail-sample-a', explicit: true }
  }), ctx(doc, { cardPending: pending }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.post.action, 'photoReceiptCardBreakdown');
  assert.equal(result.post.sourceRowIndex, 5);
  assert.equal(result.post.expectedId, 'gmail-sample-a');
  assert.equal(result.post.expectedAmount, 1080);
  assert.equal(result.post.ignoreSource, false);
  assert.equal(result.post.createSeparateCardExpense, false);
  assert.equal(result.post.zeroSourceAfterWrite, true);
  assert.equal(JSON.stringify(result.post).includes('confirmReceipt'), false);
  assert.equal(JSON.stringify(result.post).includes('ignoreCardImport'), false);
  assert.equal(result.lines.reduce((sum, line) => sum + line.amount, 0), 1080);
  assert.equal(result.post.lines.some((line) => line.amount === 0), false);
});

test('a cash receipt does not attach itself to a similar card row', () => {
  const doc = baseReceipt();
  const result = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc, {
    cardPending: [{ rowIndex: 5, id: 'gmail-sample-a', name: 'サンプル商店', amount: 1080, datetime: '2026/04/01' }]
  }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.post.action, 'photoReceiptImport');
  assert.equal(result.post.sourceRowIndex, undefined);
  assert.equal(result.post.paymentMethod, '現金');
});

test('photo hash mismatch and unverified bytes block save', async () => {
  const doc = baseReceipt();
  const unverified = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc, {
    verifiedPhotoSha256: '',
    verifiedPhotoByteLength: null
  }));
  assert.ok(codes(unverified).includes('photo-hash-unverified'));
  const mismatch = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc, { verifiedPhotoSha256: OTHER }));
  assert.ok(codes(mismatch).includes('photo-hash-mismatch'));

  const bytes = new TextEncoder().encode('EXAMPLE-PHOTO-BYTES-NOT-A-REAL-RECEIPT');
  const hash = await R.sha256Hex(bytes);
  assert.equal(hash, '47e331f7bb032f9c8bdcf789aff75eea650cc63a51fea67730e9d9d299221d3c');
  const sized = baseReceipt();
  sized.photo.sha256 = hash;
  sized.photo.byteLength = bytes.byteLength;
  const result = R.evaluateReviewed(parsed(sized), reviewed(sized), ctx(sized));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(JSON.stringify(result.post).includes('EXAMPLE-PHOTO-BYTES'), false);
});

test('formula-like item names are neutralized and example data cannot be posted', () => {
  const doc = baseReceipt();
  doc.receipt.items[0].name = '=HYPERLINK("http://example.test")';
  const result = R.evaluateReviewed(parsed(doc), reviewed(doc), ctx(doc));
  assert.equal(result.lines[0].name.startsWith("'="), true);

  const sample = JSON.parse(readFileSync(examplePath, 'utf8'));
  assert.equal(sample.example, true);
  assert.match(sample.exampleNotice, /合成/);
  const sampleDoc = parsed(sample);
  const sampleReview = R.initialReview(sampleDoc);
  sampleReview.paymentMethod = '現金';
  sampleReview.discountFacility = '山手';
  sampleReview.items.forEach((item, index) => {
    item.facility = '山手';
    item.category = index === 0 ? '食費' : '日用品費';
  });
  sampleReview.addedTaxYen = sampleReview.taxYen;
  const blocked = R.evaluateReviewed(sampleDoc, sampleReview, {
    verifiedPhotoSha256: sample.photo.sha256,
    verifiedPhotoByteLength: sample.photo.byteLength,
    capabilitiesBody: capabilitiesBody(),
    cardPending: []
  });
  assert.ok(codes(blocked).includes('example-data'));
  assert.equal(blocked.post, null);
});

test('the page does not send a photo draft through the legacy receipt action', () => {
  const html = readFileSync(join(root, '..', 'index.html'), 'utf8');
  const start = html.indexOf('async function savePhotoDraft');
  const end = html.indexOf('// END savePhotoDraft');
  assert.ok(start > 0 && end > start);
  const fn = html.slice(start, end);
  assert.equal(fn.includes('confirmReceipt'), false);
  assert.equal(fn.includes('ignoreCardImport'), false);
  assert.equal(fn.includes('confirmCardBreakdown'), false);
  assert.match(html, /action: 'confirmReceipt'/);
  assert.equal(html.includes('location.search'), false);
  assert.equal(html.includes('URLSearchParams'), false);
  const gas = readFileSync(join(root, '..', 'gas', 'photoReceiptImport.gs'), 'utf8');
  assert.match(gas, /photoReceiptImport_/);
  assert.match(gas, /photoReceiptCardBreakdown_/);
  assert.match(gas, /gmail-/);
  assert.match(gas, /purchaseDate/);
  assert.match(gas, /do not replace/i);
  assert.doesNotMatch(gas, /eval\(/);
  assert.doesNotMatch(gas, /AKfycb|BEGIN (PRIVATE|SECRET)/);
});
