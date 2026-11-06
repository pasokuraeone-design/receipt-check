import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { buildDemoHtml } from '../scripts/build-demo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = mkdtempSync(join(tmpdir(), 'receipt-demo-'));

test('standalone demo never calls Google and saves only to the mock ledger', { timeout: 60000 }, async () => {
  const html = readFileSync(join(root, 'demo/receipt-photo-demo.html'), 'utf8');
  assert.equal(html, buildDemoHtml());
  assert.equal(html.includes('script.google.com'), false);
  assert.equal(html.includes('googleapis.com'), false);
  assert.equal(html.includes('https://'), false);
  assert.equal(/<script[^>]+src=/.test(html), false);
  assert.match(html, /模擬台帳/);
  assert.match(html, /Googleスプレッドシートには保存していません/);

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'demo/receipt-photo-demo.html';
    const file = join(root, rel);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const seen = [];
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__net = [];
      const originalFetch = window.fetch;
      window.fetch = function () {
        window.__net.push(String(arguments[0]));
        return originalFetch.apply(this, arguments);
      };
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        window.__net.push(String(url));
        return originalOpen.apply(this, arguments);
      };
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      seen.push(url);
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        request.continue();
        return;
      }
      const host = new URL(url).hostname;
      if (host !== '127.0.0.1') {
        request.abort();
        return;
      }
      request.continue();
    });
    await page.setViewport({ width: 420, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/demo/receipt-photo-demo.html`, { waitUntil: 'networkidle0' });
    assert.match(await page.$eval('#banner', el => el.textContent), /模擬台帳/);
    assert.equal(await page.$eval('#saveDemo', el => el.disabled), true);
    assert.equal(await page.$eval('[data-id="gmail-demo-a"]', el => el.dataset.amount), '1080');

    await page.click('#loadUnresolved');
    await page.waitForSelector('#review:not([hidden])');
    await page.waitForFunction(() => document.getElementById('issues').textContent.includes('支払方法'));
    assert.match(await page.$eval('#issues', el => el.textContent), /拠点/);
    assert.equal(await page.$eval('#saveDemo', el => el.disabled), true);
    await page.screenshot({ path: join(shotDir, 'demo-unresolved.png'), fullPage: true });

    await page.$eval('#form select', select => {
      select.value = '現金';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate(() => {
      document.querySelectorAll('.item')[0].querySelector('button').click();
    });
    await page.evaluate(() => {
      document.querySelectorAll('.item')[1].querySelectorAll('button')[1].click();
    });
    const selects = await page.$$('.item select');
    await selects[0].select('食費');
    await selects[1].select('日用品費');
    await page.waitForFunction(() => !document.getElementById('saveDemo').disabled);
    await page.click('#saveDemo');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('模擬台帳に反映しました'));
    assert.match(await page.$eval('#status', el => el.textContent), /Googleスプレッドシートには送っていません/);
    assert.match(await page.$eval('#ledgerBody', el => el.textContent), /2026\/04\/01 12:34/);
    const savedRows = await page.$$eval('[data-id^="photo-"]', rows => rows.map(row => ({
      amount: row.dataset.amount,
      date: row.dataset.date
    })));
    assert.deepEqual(savedRows.map(row => row.amount), ['400', '600', '32', '48']);
    assert.equal(savedRows.every(row => row.date === '2026/04/01 12:34'), true);
    const afterSave = savedRows.length;
    await page.screenshot({ path: join(shotDir, 'demo-saved.png'), fullPage: true });

    await page.click('#resendDemo');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('行は増えていません'));
    assert.equal((await page.$$('[data-id^="photo-"]')).length, afterSave);

    await page.click('#partialDemo');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('欠けていた 1 行'));
    const restored = await page.$$eval('[data-id^="photo-"]', rows => rows.map(row => row.dataset.date));
    assert.equal(restored.length, afterSave);
    assert.equal(restored.every(date => date === '2026/04/01 12:34'), true);

    await page.click('#resetDemo');
    await page.waitForFunction(() => document.querySelectorAll('[data-id^="photo-"]').length === 0);
    assert.equal(await page.$eval('[data-id="gmail-demo-a"]', el => el.dataset.amount), '1080');

    await page.click('#loadInclusive');
    await page.waitForFunction(() => !document.getElementById('saveDemo').disabled);
    await page.click('#saveDemo');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('模擬台帳に反映しました'));
    const inclusive = await page.$$eval('[data-id^="photo-"]', rows => rows.map(row => row.dataset.amount));
    assert.deepEqual(inclusive, ['400', '600']);

    await page.click('#resetDemo');
    await page.click('#loadCard');
    await page.waitForFunction(() => document.getElementById('cardList').textContent.includes('同じレシートとは判断しません'));
    assert.equal(await page.$eval('#cardList', el => el.textContent.includes('選択中')), false);
    assert.equal(await page.$eval('#saveDemo', el => el.disabled), true);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#cardList button')].find(item => item.textContent.includes('サンプル商店') && item.textContent.includes('1080'));
      button.click();
    });
    await page.waitForFunction(() => document.getElementById('cardList').textContent.includes('選択中') && !document.getElementById('saveDemo').disabled);
    await page.screenshot({ path: join(shotDir, 'demo-card.png'), fullPage: true });
    await page.click('#shiftDemo');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('何も変更しません'));
    assert.equal(await page.$eval('[data-id="gmail-demo-a"]', el => el.dataset.amount), '1080');
    assert.match(await page.$eval('#status', el => el.textContent), /Googleスプレッドシートには送っていません/);

    await page.click('#resetDemo');
    await page.click('#loadCard');
    await page.waitForFunction(() => document.getElementById('cardList').textContent.includes('サンプル商店'));
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#cardList button')].find(item => item.textContent.includes('サンプル商店') && item.textContent.includes('1080'));
      button.click();
    });
    await page.waitForFunction(() => !document.getElementById('saveDemo').disabled);
    await page.click('#saveDemo');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('模擬台帳に反映しました'));
    assert.equal(await page.$eval('[data-id="gmail-demo-a"]', el => el.dataset.amount), '0');
    assert.equal(await page.$eval('[data-id="gmail-demo-a"]', el => el.dataset.facility), '済');
    assert.equal(await page.$eval('[data-id="gmail-demo-b"]', el => el.dataset.amount), '500');
    const cardLines = await page.$$eval('[data-id^="photo-"]', rows => rows.map(row => Number(row.dataset.amount)));
    assert.equal(cardLines.reduce((sum, amount) => sum + amount, 0), 1080);

    const calls = await page.evaluate(() => window.__net);
    assert.deepEqual(calls, []);
    const remote = seen.filter(url => /^https?:/i.test(url) && new URL(url).hostname !== '127.0.0.1');
    assert.deepEqual(remote, []);
    assert.equal(seen.some(url => /script\.google|googleapis|gmail\.com|google\.com/i.test(url)), false);
    console.log('DEMO_SHOTS', shotDir);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
