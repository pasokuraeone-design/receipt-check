import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = mkdtempSync(join(tmpdir(), 'receipt-ui-'));
const REQUIRED = {
  photoReceiptImport: 1,
  purchaseDate: true,
  idempotency: true,
  cardBreakdown: true,
  taxAsAllocatedLines: true,
  rejectsCardOnPlainImport: true,
  cardRowId: true
};
const cards = [
  { rowIndex: 5, id: 'gmail-sample-a', name: 'サンプル商店', amount: 1080, datetime: '2026/04/01' },
  { rowIndex: 6, id: 'gmail-sample-b', name: '別のサンプル', amount: 500, datetime: '2026/03/01' }
];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const cardPhoto = Buffer.concat([png, Buffer.from('card-sample')]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function receipt(extra) {
  return {
    schemaVersion: 1,
    source: 'grok-bot-photo',
    photo: extra.photo,
    receipt: {
      purchaseDate: '2026-04-01',
      purchaseTime: '12:34',
      storeName: 'サンプル商店',
      paymentMethod: extra.paymentMethod,
      taxMode: 'exclusive',
      subtotalYen: 1000,
      discountYen: 0,
      taxYen: 80,
      totalYen: 1080,
      items: [
        { name: 'サンプル卵<img src=x onerror="window.__xss=1">', amountYen: 400, qty: 1, category: '食費', facility: '山手', taxRate: 8 },
        { name: 'サンプル洗剤', amountYen: 600, qty: 1, category: '日用品費', facility: '新神野', taxRate: 8 }
      ]
    },
    unreadable: [],
    notes: null
  };
}

async function waitForDialogs(dialogs, count) {
  const start = Date.now();
  while (dialogs.length < count) {
    if (Date.now() - start > 5000) throw new Error(`dialog timeout: ${dialogs.join(' | ')}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('receipt page reviews a photo import without calling the live sheet', { timeout: 60000 }, async () => {
  const cashPhoto = join(shotDir, 'cash.png');
  const cardFile = join(shotDir, 'card.png');
  const cashJson = join(shotDir, 'cash.json');
  const cardJson = join(shotDir, 'card.json');
  writeFileSync(cashPhoto, png);
  writeFileSync(cardFile, cardPhoto);
  writeFileSync(cashJson, JSON.stringify(receipt({
    paymentMethod: '現金',
    photo: { sha256: sha256(png), byteLength: png.length }
  })));
  writeFileSync(cardJson, JSON.stringify(receipt({
    paymentMethod: 'カード',
    photo: { sha256: sha256(cardPhoto), byteLength: cardPhoto.length }
  })));

  let serveCaps = false;
  let failNextPhoto = false;
  const posts = [];
  const unexpected = [];
  const dialogs = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const type = extname(file) === '.js' ? 'text/javascript' : extname(file) === '.json' ? 'application/json' : 'text/html';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => unexpected.push(String(error)));
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.setViewport({ width: 460, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = request.url();
      if (url.startsWith('https://script.google.com/')) {
        if (request.method() === 'GET') {
          await request.respond({
            status: 200,
            headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
            body: JSON.stringify({
              pending: [],
              cardPending: cards,
              ...(serveCaps ? { capabilities: REQUIRED } : {})
            })
          });
          return;
        }
        const body = JSON.parse(request.postData());
        posts.push(body);
        const photo = typeof body.action === 'string' && body.action.startsWith('photo');
        const legacyFail = photo && failNextPhoto;
        if (legacyFail) failNextPhoto = false;
        await request.respond({
          status: 200,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify(legacyFail ? { status: 'success', updated: 0, added: body.lines?.length || 1 } : {
            status: 'success',
            photoReceipt: photo,
            action: body.action,
            receiptId: body.receiptId,
            purchaseDate: body.purchaseDate,
            added: Array.isArray(body.lines) ? body.lines.length : 1,
            skipped: 0,
            duplicate: false
          })
        });
        return;
      }
      if (url.startsWith(`http://127.0.0.1:${port}`) || url.startsWith('blob:') || url.startsWith('data:')) {
        await request.continue();
        return;
      }
      unexpected.push(url);
      await request.abort();
    });

    await page.goto(`http://127.0.0.1:${port}/index.html?total=99999&receipt=%7B%22store%22%3A%22leak%22%7D`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('photoCapability').textContent.includes('従来の保存処理には切り替えません'));
    assert.equal(await page.$eval('#receiptTotal', el => el.value), '');
    assert.equal(await page.$eval('#photoStoreName', el => el.value), '');
    assert.equal(posts.length, 0);

    await page.click('#modeToggle button[data-mode="card"]');
    await page.waitForFunction(() => document.getElementById('cardReviewWrap').style.display === 'block');
    assert.match(await page.$eval('#cardReviewList', el => el.textContent), /サンプル商店/);
    assert.match(await page.$eval('#cardReviewList', el => el.textContent), /内訳を入力する/);
    await page.click('#modeToggle button[data-mode="receipt"]');

    await page.$('#photoImportFile').then(input => input.uploadFile(join(root, 'examples/receipt-photo-import.example.json')));
    await page.waitForSelector('#photoExampleBanner:not([hidden])');
    const blocked = await page.evaluate(() => ({
      banner: document.getElementById('photoExampleBanner').textContent,
      save: document.getElementById('saveBtn').classList.contains('enabled'),
      stamp: document.getElementById('stamp').classList.contains('show'),
      diff: document.getElementById('diffRow').textContent,
      unset: [...document.querySelectorAll('#items .fac-btn')].map(el => el.textContent),
      xss: window.__xss || null,
      images: document.querySelectorAll('#items img').length
    }));
    assert.match(blocked.banner, /合成/);
    assert.equal(blocked.save, false);
    assert.equal(blocked.stamp, false);
    assert.match(blocked.diff, /保存できません/);
    assert.ok(blocked.unset.filter(text => text === '未選択').length >= 2);
    assert.equal(blocked.xss, null);
    assert.equal(blocked.images, 0);
    assert.equal(posts.length, 0);
    await page.screenshot({ path: join(shotDir, 'import-blocked.png'), fullPage: true });

    serveCaps = true;
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('photoCapability').textContent.includes('成功の応答を確認できるまで'));
    await page.click('#addItem');
    await page.$$eval('.item-row input', inputs => {
      inputs[0].value = '手入力サンプル';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = '250';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.$eval('#receiptTotal', input => {
      input.value = '250';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('saveBtn').classList.contains('enabled'));
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 0);
    assert.equal(posts.at(-1).action, 'confirmReceipt');
    assert.equal(posts.at(-1).items.some(item => item.name === '手入力サンプル'), true);

    failNextPhoto = true;
    await page.$('#photoImportFile').then(input => input.uploadFile(cashJson));
    await page.waitForFunction(() => document.getElementById('photoIdentity').textContent.includes('写真ID'));
    assert.equal(await page.evaluate(() => window.__xss || null), null);
    assert.equal(await page.$eval('#items img', () => 'found').catch(() => 'absent'), 'absent');
    assert.match(await page.$eval('.item-row input[type="text"]', el => el.value), /<img/);
    await page.$('#photoFile').then(input => input.uploadFile(cashPhoto));
    await page.waitForFunction(() => document.getElementById('saveBtn').classList.contains('enabled'));
    await page.screenshot({ path: join(shotDir, 'import-ready.png'), fullPage: true });
    await page.click('#saveBtn');
    await waitForDialogs(dialogs, 1);
    assert.equal(await page.$eval('#receiptTotal', el => el.value), '1080');
    assert.match(dialogs.at(-1), /応答を確認できません/);
    assert.equal(posts.at(-1).action, 'photoReceiptImport');
    assert.equal(posts.at(-1).purchaseDate, '2026-04-01');

    await page.waitForFunction(() => document.getElementById('saveBtn').classList.contains('enabled'));
    await page.click('#saveBtn');
    await waitForDialogs(dialogs, 2);
    await page.waitForFunction(() => document.getElementById('photoImportReview').hidden);
    assert.match(dialogs.at(-1), /保存成功/);
    assert.match(await page.$eval('#history', el => el.textContent), /2026\/04\/01 購入/);
    const saved = posts.at(-1);
    assert.equal(saved.action, 'photoReceiptImport');
    assert.equal(saved.paymentMethod, '現金');
    assert.equal(saved.sourceRowIndex, undefined);
    assert.equal(saved.lines.reduce((sum, line) => sum + line.amount, 0), 1080);
    assert.deepEqual(saved.lines.filter(line => line.role === 'item').map(line => line.amount), [400, 600]);
    assert.equal(JSON.stringify(saved).includes('confirmReceipt'), false);
    assert.equal(JSON.stringify(saved).includes(png.toString('base64')), false);

    await page.$('#photoImportFile').then(input => input.uploadFile(cardJson));
    await page.waitForSelector('#photoCardBox:not([hidden])');
    await page.$('#photoFile').then(input => input.uploadFile(cardFile));
    await page.waitForFunction(() => document.querySelector('#photoCardList').textContent.includes('同じレシートとは判断しません'));
    assert.equal(await page.$eval('#saveBtn', el => el.classList.contains('enabled')), false);
    assert.equal(await page.$eval('#photoCardList', el => el.textContent.includes('選択中')), false);
    await page.click('#photoCardList .photo-card-btn');
    await page.waitForFunction(() => document.getElementById('photoCardList').textContent.includes('選択中'));
    await page.waitForFunction(() => document.getElementById('saveBtn').classList.contains('enabled'));
    await page.screenshot({ path: join(shotDir, 'card-linked.png'), fullPage: true });
    await page.click('#saveBtn');
    await waitForDialogs(dialogs, 3);
    await page.waitForFunction(() => document.getElementById('photoImportReview').hidden);
    const cardPost = posts.at(-1);
    assert.equal(cardPost.action, 'photoReceiptCardBreakdown');
    assert.equal(cardPost.expectedId, 'gmail-sample-a');
    assert.equal(cardPost.expectedAmount, 1080);
    assert.equal(cardPost.ignoreSource, false);
    assert.equal(cardPost.createSeparateCardExpense, false);
    assert.equal(cardPost.zeroSourceAfterWrite, true);
    assert.equal(cardPost.lines.some(line => line.amount === 0), false);
    assert.equal(posts.some(post => post.action === 'ignoreCardImport'), false);
    assert.deepEqual(unexpected, []);
    console.log('SCREENSHOTS', shotDir);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
