/**
 * Additive photo-receipt actions for コード.gs.
 *
 * Do not replace existing handlers. Paste these functions at the bottom of
 * コード.gs, then add the two branches and the doGet fields described in
 * docs/backend-integration.md. confirmReceipt, cardImport, confirmCardFacility,
 * ignoreCardImport, and confirmCardBreakdown stay as they are.
 *
 * The live spreadsheet script is not in this repository. This file was not
 * deployed and was not executed against production.
 *
 * doPost already holds LockService.getScriptLock. These functions must not
 * lock again: Apps Script locks are not reentrant and a second waitLock can
 * deadlock until the 30s timeout.
 */

var PHOTO_RECEIPT_CAPABILITIES = {
  photoReceiptImport: 1,
  purchaseDate: true,
  idempotency: true,
  cardBreakdown: true,
  taxAsAllocatedLines: true,
  rejectsCardOnPlainImport: true,
  cardRowId: true
};

function photoReceiptCapabilities_() {
  return PHOTO_RECEIPT_CAPABILITIES;
}

function photoReceiptSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = (typeof SHEET_NAME !== 'undefined') ? SHEET_NAME : '食料品_品目明細';
  return ss.getSheetByName(name) || ss.getSheets()[0];
}

function photoReceiptImport_(data) {
  var plan = photoReceiptValidate_(data, 'photoReceiptImport');
  if (plan.error) return photoReceiptError_(plan.error);
  if (plan.paymentMethod === 'カード') {
    return photoReceiptError_('カード払いは自動取込行の内訳として保存します。別のカード支出は追加しません。');
  }
  var sheet = photoReceiptSheet_();
  var decision = photoReceiptDecide_(sheet, plan);
  if (decision.error) return photoReceiptError_(decision.error);
  if (decision.kind === 'conflict') {
    return photoReceiptError_('同じ写真IDの別内容が既にあります。追記しません。');
  }
  var added = photoReceiptAppend_(sheet, plan, decision.lines || []);
  return photoReceiptSuccess_('photoReceiptImport', plan, added, decision.skipped || 0, decision.kind === 'duplicate');
}

function photoReceiptCardBreakdown_(data) {
  var plan = photoReceiptValidate_(data, 'photoReceiptCardBreakdown');
  if (plan.error) return photoReceiptError_(plan.error);
  if (data.ignoreSource !== false || data.createSeparateCardExpense !== false || data.zeroSourceAfterWrite !== true) {
    return photoReceiptError_('カード行の無視や、別のカード支出の追加は受け付けません。');
  }
  if (plan.paymentMethod !== 'カード') return photoReceiptError_('支払方法がカードではありません。');
  if (typeof data.expectedId !== 'string' || data.expectedId.indexOf('gmail-') !== 0) {
    return photoReceiptError_('自動取込IDを確認できないため、行は変更しません。');
  }
  var sheet = photoReceiptSheet_();
  var row = photoReceiptReadCardRow_(sheet, data.sourceRowIndex, data.expectedId, plan.totalYen);
  if (row.error) return photoReceiptError_(row.error);
  var decision = photoReceiptDecide_(sheet, plan);
  if (decision.error) return photoReceiptError_(decision.error);
  if (decision.kind === 'conflict') {
    return photoReceiptError_('同じ写真IDの別内容が既にあります。カード行は変更しません。');
  }
  var added = photoReceiptAppend_(sheet, plan, decision.lines || []);
  var current = photoReceiptReadCardRow_(sheet, data.sourceRowIndex, data.expectedId, plan.totalYen);
  if (current.error) {
    if (current.alreadySettled) {
      return photoReceiptSuccess_('photoReceiptCardBreakdown', plan, added, decision.skipped || 0, true);
    }
    return photoReceiptError_(current.error + ' 追加済みの行は写真IDで再送しても二重にはなりません。別の行は0円にしていません。');
  }
  sheet.getRange(data.sourceRowIndex, 3).setValue('済');
  sheet.getRange(data.sourceRowIndex, 6).setValue('内訳入力済み');
  sheet.getRange(data.sourceRowIndex, 9).setValue(0);
  return photoReceiptSuccess_('photoReceiptCardBreakdown', plan, added, decision.skipped || 0, decision.kind === 'duplicate' && added === 0);
}

function photoReceiptValidate_(data, action) {
  if (!data || typeof data !== 'object') return { error: 'payload' };
  if (data.action !== action) return { error: 'action' };
  if (data.image || data.base64 || data.bytes || data.dataUrl || data.photoReceipt) {
    return { error: '写真そのものや応答フラグは受け付けません。' };
  }
  var sha = photoReceiptSha_(data.receiptId);
  if (!sha) return { error: 'receiptId' };
  if (!photoReceiptIsoDate_(data.purchaseDate)) return { error: '購入日が不正です。' };
  if (data.purchaseTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.purchaseTime)) return { error: '時刻が不正です。' };
  if (data.paymentMethod !== '現金' && data.paymentMethod !== 'カード') return { error: '支払方法が不正です。' };
  if (data.taxMode !== 'inclusive' && data.taxMode !== 'exclusive') return { error: '税区分が不正です。' };
  var totalYen = photoReceiptYen_(data.totalYen, 1);
  var taxYen = photoReceiptYen_(data.taxYen, 0);
  var discountYen = photoReceiptYen_(data.discountYen, 0);
  if (totalYen === null || taxYen === null || discountYen === null) return { error: '金額は整数円だけ受け付けます。' };
  if (!data.lines || !data.lines.length || data.lines.length > 80) return { error: '品目数が不正です。' };
  var itemSum = 0;
  var taxSum = 0;
  var discountSum = 0;
  for (var i = 0; i < data.lines.length; i++) {
    var line = data.lines[i];
    var expectedId = photoReceiptLineId_(sha, i);
    if (!line || line.id !== expectedId) return { error: '写真IDの並びが不正です。' };
    if (line.facility !== '山手' && line.facility !== '新神野') return { error: '拠点が未確認です。' };
    if (['食費', '日用品費', '備品', '郵送費', 'その他', '消費税', '値引'].indexOf(line.category) === -1) {
      return { error: '分類が不正です。' };
    }
    var amount = photoReceiptSignedYen_(line.amount);
    if (amount === null) return { error: '行の金額が整数ではありません。' };
    if (line.category === '消費税') taxSum += amount;
    else if (line.category === '値引') discountSum += amount;
    else itemSum += amount;
    if (line.qty !== '' && line.qty != null && photoReceiptYen_(line.qty, 1) === null) return { error: '数量が不正です。' };
  }
  if (discountSum !== -discountYen) return { error: '値引の合計が一致しません。' };
  if (data.taxMode === 'inclusive' && taxSum !== 0) return { error: '内税の消費税を行の金額に加算しています。' };
  if (data.taxMode === 'exclusive' && taxSum !== taxYen) return { error: '外税の按分が税額と一致しません。' };
  if (itemSum + discountSum + taxSum !== totalYen) return { error: '行の合計がレシート合計と一致しません。' };
  var dateCell;
  try {
    dateCell = photoReceiptDateCell_(data.purchaseDate, data.purchaseTime || '');
  } catch (err) {
    return { error: '購入日をシート用の文字列にできません。' };
  }
  return {
    sha: sha,
    receiptId: 'photo-' + sha,
    purchaseDate: data.purchaseDate,
    dateCell: dateCell,
    paymentMethod: data.paymentMethod,
    totalYen: totalYen,
    lines: data.lines
  };
}

function photoReceiptDecide_(sheet, plan) {
  var existing = photoReceiptExistingIds_(sheet);
  var prefix = 'photo-' + plan.sha + '-';
  var ours = [];
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].indexOf(prefix) === 0) ours.push(existing[i]);
  }
  if (!ours.length) return { kind: 'write', lines: plan.lines, skipped: 0 };
  var known = {};
  for (var p = 0; p < plan.lines.length; p++) known[plan.lines[p].id] = 1;
  for (var u = 0; u < ours.length; u++) {
    if (!known[ours[u]]) return { kind: 'conflict' };
  }
  var have = {};
  for (var h = 0; h < ours.length; h++) have[ours[h]] = 1;
  var missing = [];
  var skipped = 0;
  for (var m = 0; m < plan.lines.length; m++) {
    if (have[plan.lines[m].id]) skipped++;
    else missing.push(plan.lines[m]);
  }
  if (!missing.length) return { kind: 'duplicate', lines: [], skipped: skipped };
  return { kind: 'retry-partial', lines: missing, skipped: skipped };
}

function photoReceiptAppend_(sheet, plan, lines) {
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    sheet.appendRow([
      line.id,
      plan.dateCell,
      line.facility,
      photoReceiptText_(line.name).slice(0, 80),
      line.qty || '',
      line.category,
      photoReceiptText_(line.note || '').slice(0, 200),
      'フジタ',
      line.amount,
      '',
      '',
      plan.paymentMethod
    ]);
  }
  return lines.length;
}

function photoReceiptReadCardRow_(sheet, rowIndex, expectedId, expectedAmount) {
  if (typeof rowIndex !== 'number' || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
    return { error: 'カード行の位置を確認できません。' };
  }
  var values = sheet.getRange(rowIndex, 1, 1, 12).getValues()[0];
  var id = String(values[0] || '');
  var facility = String(values[2] || '');
  var category = String(values[5] || '');
  var amount = values[8];
  var payment = String(values[11] || '');
  if (id !== expectedId) return { error: 'カード行のIDが一致しません。行の挿入でずれている可能性があるため、何も変更しません。' };
  if (facility === '済' && Number(amount) === 0 && category === '内訳入力済み') {
    return { error: 'この自動取込は内訳済みです。', alreadySettled: true };
  }
  if (payment !== 'カード' || facility !== '' || category === '重複のため無視' || category === '内訳入力済み') {
    return { error: '自動取込の未処理行ではないため、変更しません。' };
  }
  if (photoReceiptYen_(amount, 0) !== expectedAmount) {
    return { error: '自動取込の金額とレシート合計が一致しません。0円にはしません。' };
  }
  return { id: id };
}

function photoReceiptExistingIds_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, 1).getValues();
  var ids = [];
  for (var i = 0; i < values.length; i++) ids.push(String(values[i][0] || ''));
  return ids;
}

function photoReceiptSuccess_(action, plan, added, skipped, duplicate) {
  return {
    status: 'success',
    photoReceipt: true,
    action: action,
    receiptId: plan.receiptId,
    purchaseDate: plan.purchaseDate,
    added: added,
    skipped: skipped,
    duplicate: duplicate === true
  };
}

function photoReceiptError_(message) {
  return { status: 'error', message: String(message || 'error') };
}

function photoReceiptSha_(receiptId) {
  var match = /^photo-([a-f0-9]{64})$/.exec(receiptId || '');
  return match ? match[1] : '';
}

function photoReceiptLineId_(sha, index) {
  var n = String(index);
  while (n.length < 2) n = '0' + n;
  return 'photo-' + sha + '-' + n;
}

function photoReceiptIsoDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var y = Number(value.slice(0, 4));
  var m = Number(value.slice(5, 7));
  var d = Number(value.slice(8, 10));
  if (y < 2000 || y > 2100) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function photoReceiptDateCell_(purchaseDate, purchaseTime) {
  if (!photoReceiptIsoDate_(purchaseDate)) throw new Error('bad date');
  var cell = purchaseDate.replace(/-/g, '/');
  if (purchaseTime) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(purchaseTime)) throw new Error('bad time');
    cell += ' ' + purchaseTime;
  }
  return cell;
}

function photoReceiptYen_(value, min) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) return null;
  if (value < min || value > 100000000) return null;
  return value;
}

function photoReceiptSignedYen_(value) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) return null;
  if (value < -100000000 || value > 100000000) return null;
  return value;
}

function photoReceiptText_(value) {
  var text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}
