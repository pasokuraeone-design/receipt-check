/**
 * Standalone wrapper for a NEW spreadsheet.
 * Paste Code.gs (this file already concatenated) into a new container-bound
 * Apps Script project. Do not paste it into the production project.
 *
 * Requires Document property SYNTHETIC_ONLY=1, which setupSyntheticSheet sets
 * only after every existing id looks synthetic. Production gmail- ids abort.
 */

function setupSyntheticSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  assertNoForeignIds_(ss);
  PropertiesService.getDocumentProperties().setProperty('SYNTHETIC_ONLY', '1');
  var sheet = ss.getSheetByName('食料品_品目明細');
  if (!sheet) {
    sheet = ss.getSheets()[0];
    if (sheet.getLastRow() > 1) {
      throw new Error('空でないシートは合成用に名前を変えません。新しいスプレッドシートで実行してください。');
    }
    sheet.setName('食料品_品目明細');
  }
  resetSyntheticSheet_(sheet);
  return '合成シートを用意しました。本番の取引はコピーしていません。';
}

function runSyntheticSelfTest() {
  setupSyntheticSheet();
  var sheet = photoReceiptSheet_();
  var checks = [];
  function check(name, ok) {
    if (!ok) throw new Error('失敗: ' + name);
    checks.push(name);
  }
  var cash = syntheticPost_('photoReceiptImport', 'ab', '現金');
  var first = photoReceiptImport_(cash);
  check('cash-added', first.status === 'success' && first.added === 4 && first.purchaseDate === '2026-04-01' && first.photoReceipt === true);
  check('cash-date', syntheticCell_(sheet, 'photo-' + syntheticSha_('ab') + '-00', 2) === '2026/04/01 12:34');
  check('cash-amounts', syntheticAmount_(sheet, 'photo-' + syntheticSha_('ab') + '-00') === 400 && syntheticAmount_(sheet, 'photo-' + syntheticSha_('ab') + '-01') === 600);
  var before = sheet.getLastRow();
  var again = photoReceiptImport_(cash);
  check('exact-resend', again.status === 'success' && again.duplicate === true && again.added === 0 && sheet.getLastRow() === before);
  sheet.deleteRow(sheet.getLastRow());
  var partial = photoReceiptImport_(cash);
  check('partial-retry', partial.status === 'success' && partial.added === 1 && partial.duplicate !== true);
  check('partial-date', syntheticCell_(sheet, 'photo-' + syntheticSha_('ab') + '-03', 2) === '2026/04/01 12:34');

  var card = syntheticPost_('photoReceiptCardBreakdown', 'cd', 'カード');
  card.sourceRowIndex = 3;
  card.expectedId = 'gmail-demo-a';
  card.expectedAmount = 1080;
  card.ignoreSource = false;
  card.createSeparateCardExpense = false;
  card.zeroSourceAfterWrite = true;
  var wrong = photoReceiptCardBreakdown_(card);
  check('shifted-index', wrong.status === 'error');
  check('shifted-untouched', syntheticAmount_(sheet, 'gmail-demo-a') === 1080 && syntheticAmount_(sheet, 'gmail-demo-b') === 500);

  card.sourceRowIndex = 2;
  var saved = photoReceiptCardBreakdown_(card);
  check('card-save', saved.status === 'success' && saved.added === 4 && saved.purchaseDate === '2026-04-01');
  check('card-zeroed', syntheticAmount_(sheet, 'gmail-demo-a') === 0 && syntheticCell_(sheet, 'gmail-demo-a', 3) === '済' && syntheticCell_(sheet, 'gmail-demo-a', 6) === '内訳入力済み');
  check('card-other', syntheticAmount_(sheet, 'gmail-demo-b') === 500);
  check('card-sum', syntheticPhotoSum_(sheet, 'cd') === 1080);
  check('card-date', String(syntheticCell_(sheet, 'photo-' + syntheticSha_('cd') + '-00', 2)).indexOf('2026/04/01') === 0);
  var cardAgain = photoReceiptCardBreakdown_(card);
  check('card-resend', cardAgain.status === 'success' && cardAgain.duplicate === true && cardAgain.added === 0);

  var asImport = syntheticPost_('photoReceiptImport', 'cd', 'カード');
  var rejected = photoReceiptImport_(asImport);
  check('no-second-card', rejected.status === 'error' && syntheticPhotoSum_(sheet, 'cd') === 1080);

  var other = syntheticPost_('photoReceiptImport', 'ef', '現金');
  var otherResult = photoReceiptImport_(other);
  check('other-hash', otherResult.status === 'success' && otherResult.duplicate !== true && otherResult.added === 4);
  return '合成セルフテスト ' + checks.length + ' 件すべて成功。本番のシートには書いていません。';
}

function doGet() {
  try {
    syntheticGuard_();
    var sheet = photoReceiptSheet_();
    var cardPending = [];
    var last = sheet.getLastRow();
    if (last >= 2) {
      var values = sheet.getRange(2, 1, last - 1, 12).getValues();
      for (var i = 0; i < values.length; i++) {
        var payment = String(values[i][11] || '');
        var facility = String(values[i][2] || '');
        var category = String(values[i][5] || '');
        var amount = values[i][8];
        var name = String(values[i][3] || '');
        if (payment === 'カード' && facility === '' && name && category !== '内訳入力済み' && category !== '重複のため無視' && amount !== 0 && amount !== '0') {
          cardPending.push({
            rowIndex: i + 2,
            id: String(values[i][0] || ''),
            datetime: String(values[i][1] || ''),
            name: name,
            amount: amount,
            note: String(values[i][6] || '')
          });
        }
      }
    }
    return syntheticJson_({
      pending: [],
      cardPending: cardPending,
      capabilities: photoReceiptCapabilities_(),
      synthetic: true
    });
  } catch (err) {
    return syntheticJson_({ status: 'error', message: String(err && err.message || err), synthetic: true });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    syntheticGuard_();
    var data = JSON.parse(e.postData.contents);
    var result;
    if (data.action === 'photoReceiptImport') result = photoReceiptImport_(data);
    else if (data.action === 'photoReceiptCardBreakdown') result = photoReceiptCardBreakdown_(data);
    else result = { status: 'error', message: 'この合成用プロジェクトにその操作はありません。' };
    return syntheticJson_(result);
  } catch (err) {
    return syntheticJson_({ status: 'error', message: String(err && err.message || err), synthetic: true });
  } finally {
    lock.releaseLock();
  }
}

function syntheticGuard_() {
  var props = PropertiesService.getDocumentProperties();
  if (props.getProperty('SYNTHETIC_ONLY') !== '1') {
    throw new Error('setupSyntheticSheet を、新しい空のスプレッドシートで先に実行してください。');
  }
  assertNoForeignIds_(SpreadsheetApp.getActiveSpreadsheet());
}

function assertNoForeignIds_(ss) {
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var last = sh.getLastRow();
    if (last < 1) continue;
    var values = sh.getRange(1, 1, last, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      var id = String(values[i][0] || '');
      if (!id || id === 'id') continue;
      if (!syntheticIdOk_(id)) throw new Error('合成以外のIDがあるため中止しました: ' + id);
    }
  }
}

function syntheticIdOk_(id) {
  if (id.indexOf('gmail-') === 0) return id.indexOf('gmail-demo-') === 0;
  return id.indexOf('photo-') === 0 || id.indexOf('synthetic-') === 0;
}

function resetSyntheticSheet_(sheet) {
  if (sheet.getMaxRows() > 1 && sheet.getLastRow() > 0) sheet.clear();
  sheet.getRange(1, 1, 1, 12).setValues([['id', '日時', '拠点', '品目', '数量', '分類', 'メモ', '依頼者', '金額', '税', '合計', '支払方法']]);
  var fixtures = [
    ['gmail-demo-a', '2026/04/01', '', 'サンプル商店', '', '未確認', '模擬のカード自動取込', 'フジタ(カード自動)', 1080, '', '', 'カード'],
    ['gmail-demo-b', '2026/03/02', '', '別のサンプル店', '', '未確認', '模擬のカード自動取込', 'フジタ(カード自動)', 500, '', '', 'カード'],
    ['synthetic-manual', '2026/04/01', '', '日付と金額だけ同じ行', '', '未確認', '模擬', 'フジタ', 1080, '', '', 'カード']
  ];
  sheet.getRange(2, 1, fixtures.length, 12).setValues(fixtures);
}

function syntheticSha_(seed) {
  var sha = '';
  while (sha.length < 64) sha += seed;
  return sha.slice(0, 64);
}

function syntheticPost_(action, seed, payment) {
  var sha = syntheticSha_(seed);
  var lines = [
    { role: 'item', name: 'サンプル卵', amount: 400, facility: '山手', category: '食費', qty: 1, note: 'サンプル商店 / 外税' },
    { role: 'item', name: 'サンプル洗剤', amount: 600, facility: '新神野', category: '日用品費', qty: 1, note: 'サンプル商店 / 外税' },
    { role: 'tax', name: '消費税（按分）', amount: 32, facility: '山手', category: '消費税', qty: '', note: '自動按分' },
    { role: 'tax', name: '消費税（按分）', amount: 48, facility: '新神野', category: '消費税', qty: '', note: '自動按分' }
  ];
  for (var i = 0; i < lines.length; i++) lines[i].id = photoReceiptLineId_(sha, i);
  return {
    action: action,
    receiptId: 'photo-' + sha,
    purchaseDate: '2026-04-01',
    purchaseTime: '12:34',
    paymentMethod: payment,
    taxMode: 'exclusive',
    taxYen: 80,
    discountYen: 0,
    totalYen: 1080,
    storeName: 'サンプル商店',
    lines: lines
  };
}

function syntheticRow_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var values = sheet.getRange(2, 1, last - 1, 12).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === id) return values[i];
  }
  return null;
}

function syntheticCell_(sheet, id, column) {
  var row = syntheticRow_(sheet, id);
  return row ? row[column - 1] : '';
}

function syntheticAmount_(sheet, id) {
  var row = syntheticRow_(sheet, id);
  return row ? row[8] : null;
}

function syntheticPhotoSum_(sheet, seed) {
  var prefix = 'photo-' + syntheticSha_(seed) + '-';
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, 1, last - 1, 12).getValues();
  var sum = 0;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).indexOf(prefix) === 0) sum += Number(values[i][8]) || 0;
  }
  return sum;
}

function syntheticJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
