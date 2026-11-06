/**
 * Receipt-photo import: schema checks, yen identity, and save planning.
 *
 * The photo is read in chat. This module never OCRs, never calls a network,
 * and never treats a matching date and amount as the same receipt.
 *
 * Accounting follows the existing sheet: exclusive tax is its own allocated
 * lines; item amounts are not rewritten with the receipt total or the tax.
 * Inclusive tax is checked and then kept out of the sum.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReceiptImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SCHEMA_VERSION = 1;
  var MAX_JSON_BYTES = 200 * 1024;
  var MAX_ITEMS = 80;
  var MAX_NAME = 80;
  var MAX_NOTE = 500;
  var SOURCE = 'grok-bot-photo';
  var FACILITIES = ['山手', '新神野'];
  var PAYMENTS = ['現金', 'カード'];
  var ITEM_CATEGORIES = ['食費', '日用品費', '備品', '郵送費', 'その他'];
  var LINE_CATEGORIES = ITEM_CATEGORIES.concat(['消費税', '値引']);
  var TAX_RATES = [8, 10];
  var EMBEDDED_KEYS = {
    image: 1, dataUrl: 1, dataURL: 1, base64: 1, bytes: 1, content: 1, blob: 1, src: 1
  };
  var REQUIRED_CAPABILITIES = {
    photoReceiptImport: 1,
    purchaseDate: true,
    idempotency: true,
    cardBreakdown: true,
    taxAsAllocatedLines: true,
    rejectsCardOnPlainImport: true,
    cardRowId: true
  };

  function issue(code, message, path) {
    return { code: code, message: message, path: path || '' };
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function forbiddenKey(value) {
    if (!value || typeof value !== 'object') return '';
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === '__proto__' || keys[i] === 'prototype' || keys[i] === 'constructor') {
        return keys[i];
      }
    }
    if (Array.isArray(value)) {
      for (var a = 0; a < value.length; a++) {
        var hit = forbiddenKey(value[a]);
        if (hit) return hit;
      }
      return '';
    }
    for (var k = 0; k < keys.length; k++) {
      var nested = forbiddenKey(value[keys[k]]);
      if (nested) return nested;
    }
    return '';
  }

  function unknownKey(object, allowed) {
    var keys = Object.keys(object);
    for (var i = 0; i < keys.length; i++) {
      if (allowed.indexOf(keys[i]) === -1) return keys[i];
    }
    return '';
  }

  function embeddedKey(object) {
    var keys = Object.keys(object);
    for (var i = 0; i < keys.length; i++) {
      if (EMBEDDED_KEYS[keys[i]]) return keys[i];
    }
    return '';
  }

  function isSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parts = value.split('-');
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var d = Number(parts[2]);
    if (y < 2000 || y > 2100) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function isTime(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function isYen(value, min) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text || text.length > max) return null;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 32 || code === 127) return null;
    }
    return text;
  }

  function neutralizeSheetText(value) {
    var text = value == null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) return "'" + text;
    return text;
  }

  function pushError(errors, code, message, path) {
    errors.push(issue(code, message, path));
  }

  function nullablePathOk(path) {
    if (/^receipt\.items\.\d+\.(name|amountYen|qty|category|facility|taxRate)$/.test(path)) return true;
    return [
      'receipt.purchaseDate',
      'receipt.purchaseTime',
      'receipt.storeName',
      'receipt.paymentMethod',
      'receipt.taxMode',
      'receipt.subtotalYen',
      'receipt.discountYen',
      'receipt.taxYen',
      'receipt.totalYen'
    ].indexOf(path) !== -1;
  }

  function valueAt(document, path) {
    var parts = path.split('.');
    var cur = document;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function parseImportJson(text) {
    var errors = [];
    if (typeof text !== 'string') {
      return { ok: false, errors: [issue('not-string', 'JSONファイルとして読めません。')], document: null };
    }
    var bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
    if (bytes > MAX_JSON_BYTES) {
      return { ok: false, errors: [issue('too-large', 'JSONが大きすぎます。写真そのものは入れないでください。')], document: null };
    }
    var data;
    try {
      data = JSON.parse(text, function (key, value) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          throw new Error('forbidden');
        }
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
          throw new Error('forbidden');
        }
        return value;
      });
    } catch (err) {
      var code = err && err.message === 'forbidden' ? 'forbidden-key' : 'invalid-json';
      var message = code === 'forbidden-key' ? '使えないキーが含まれています。' : 'JSONとして解釈できません。';
      return { ok: false, errors: [issue(code, message)], document: null };
    }
    if (!isPlainObject(data)) {
      return { ok: false, errors: [issue('not-object', '読み取り結果はオブジェクトである必要があります。')], document: null };
    }
    var badKey = forbiddenKey(data);
    if (badKey) {
      return { ok: false, errors: [issue('forbidden-key', '使えないキーが含まれています。', badKey)], document: null };
    }
    var extra = unknownKey(data, ['schemaVersion', 'source', 'photo', 'receipt', 'unreadable', 'notes', 'example', 'exampleNotice']);
    if (extra) pushError(errors, 'unknown-key', '未対応の項目があります: ' + extra, extra);
    var embedded = embeddedKey(data);
    if (embedded) pushError(errors, 'photo-embedded', '写真データそのものはJSONに入れません。', embedded);
    if (data.schemaVersion !== SCHEMA_VERSION) {
      pushError(errors, 'bad-schema-version', 'schemaVersion は 1 だけ受け付けます。', 'schemaVersion');
    }
    if (data.source !== SOURCE) pushError(errors, 'bad-source', 'source が不正です。', 'source');
    if (data.example !== undefined && typeof data.example !== 'boolean') {
      pushError(errors, 'bad-example', 'example は true または false です。', 'example');
    }
    if (data.exampleNotice !== undefined && cleanText(data.exampleNotice, 200) === null) {
      pushError(errors, 'bad-example-notice', 'exampleNotice が不正です。', 'exampleNotice');
    }
    if (data.notes !== undefined && data.notes !== null && cleanText(data.notes, MAX_NOTE) === null) {
      pushError(errors, 'bad-notes', 'notes が長すぎるか、使えない文字があります。', 'notes');
    }

    var photo = data.photo;
    if (!isPlainObject(photo)) {
      pushError(errors, 'bad-photo', 'photo.sha256 と photo.byteLength が必要です。', 'photo');
    } else {
      var photoExtra = unknownKey(photo, ['sha256', 'byteLength']);
      var photoEmbedded = embeddedKey(photo);
      if (photoEmbedded) pushError(errors, 'photo-embedded', '写真データそのものはJSONに入れません。', 'photo.' + photoEmbedded);
      if (photoExtra) pushError(errors, 'unknown-key', 'photo に未対応の項目があります: ' + photoExtra, 'photo.' + photoExtra);
      if (!isSha256(photo.sha256)) pushError(errors, 'bad-sha256', 'photo.sha256 は小文字16進64文字です。', 'photo.sha256');
      if (!isYen(photo.byteLength, 1) || photo.byteLength > 20000000) {
        pushError(errors, 'bad-byte-length', 'photo.byteLength が不正です。', 'photo.byteLength');
      }
    }

    var receipt = data.receipt;
    var items = [];
    if (!isPlainObject(receipt)) {
      pushError(errors, 'bad-receipt', 'receipt が必要です。', 'receipt');
    } else {
      var receiptExtra = unknownKey(receipt, [
        'purchaseDate', 'purchaseTime', 'storeName', 'paymentMethod', 'taxMode',
        'subtotalYen', 'discountYen', 'taxYen', 'totalYen', 'items'
      ]);
      if (receiptExtra) pushError(errors, 'unknown-key', 'receipt に未対応の項目があります: ' + receiptExtra, 'receipt.' + receiptExtra);
      validateNullableDate(receipt.purchaseDate, 'receipt.purchaseDate', errors);
      validateNullableTime(receipt.purchaseTime, 'receipt.purchaseTime', errors);
      validateNullableStore(receipt.storeName, errors);
      validateNullableEnum(receipt.paymentMethod, PAYMENTS, 'bad-payment', '支払方法は「現金」か「カード」か、未確認の null です。推測では埋めません。', 'receipt.paymentMethod', errors);
      validateNullableEnum(receipt.taxMode, ['inclusive', 'exclusive'], 'bad-tax-mode', '税区分は inclusive（内税）か exclusive（外税）か、未確認の null です。', 'receipt.taxMode', errors);
      validateNullableYen(receipt.subtotalYen, 'receipt.subtotalYen', errors);
      validateNullableYen(receipt.discountYen, 'receipt.discountYen', errors);
      validateNullableYen(receipt.taxYen, 'receipt.taxYen', errors);
      validateNullableYen(receipt.totalYen, 'receipt.totalYen', errors);
      if (!Array.isArray(receipt.items)) {
        pushError(errors, 'bad-items', '品目の配列が必要です。', 'receipt.items');
      } else if (receipt.items.length < 1 || receipt.items.length > MAX_ITEMS) {
        pushError(errors, 'bad-items', '品目は1件以上、' + MAX_ITEMS + '件以下です。', 'receipt.items');
      } else {
        items = receipt.items.map(function (item, index) {
          return validateItem(item, index, errors);
        });
      }
    }

    var unreadable = data.unreadable === undefined ? [] : data.unreadable;
    if (!Array.isArray(unreadable) || unreadable.some(function (entry) { return typeof entry !== 'string'; })) {
      pushError(errors, 'bad-unreadable', 'unreadable は文字列の配列です。', 'unreadable');
      unreadable = [];
    } else {
      unreadable.forEach(function (path) {
        if (!nullablePathOk(path)) {
          pushError(errors, 'bad-unreadable', '未確認パスが不正です: ' + path, path);
          return;
        }
        if (valueAt(data, path) !== null) {
          pushError(errors, 'unreadable-contradiction', '未確認とされた項目に値が入っています。読めない数字は入れないでください。', path);
        }
      });
    }

    if (errors.length) return { ok: false, errors: errors, document: null };

    return {
      ok: true,
      errors: [],
      document: {
        schemaVersion: SCHEMA_VERSION,
        source: SOURCE,
        example: data.example === true,
        exampleNotice: data.exampleNotice || '',
        photo: { sha256: data.photo.sha256, byteLength: data.photo.byteLength },
        receipt: {
          purchaseDate: receipt.purchaseDate === undefined ? null : receipt.purchaseDate,
          purchaseTime: receipt.purchaseTime === undefined ? null : receipt.purchaseTime,
          storeName: receipt.storeName === undefined ? null : receipt.storeName,
          paymentMethod: receipt.paymentMethod === undefined ? null : receipt.paymentMethod,
          taxMode: receipt.taxMode === undefined ? null : receipt.taxMode,
          subtotalYen: receipt.subtotalYen === undefined ? null : receipt.subtotalYen,
          discountYen: receipt.discountYen === undefined ? null : receipt.discountYen,
          taxYen: receipt.taxYen === undefined ? null : receipt.taxYen,
          totalYen: receipt.totalYen === undefined ? null : receipt.totalYen,
          items: items
        },
        unreadable: unreadable.slice(),
        notes: data.notes || null
      }
    };
  }

  function validateNullableDate(value, path, errors) {
    if (value === undefined) return;
    if (value !== null && !isIsoDate(value)) pushError(errors, 'bad-date', '購入日は YYYY-MM-DD か、未確認の null です。', path);
  }
  function validateNullableTime(value, path, errors) {
    if (value === undefined) return;
    if (value !== null && !isTime(value)) pushError(errors, 'bad-time', '時刻は HH:MM か null です。', path);
  }
  function validateNullableStore(value, errors) {
    if (value === undefined || value === null) return;
    if (cleanText(value, MAX_NAME) === null) pushError(errors, 'bad-store', '店名が不正です。', 'receipt.storeName');
  }
  function validateNullableEnum(value, allowed, code, message, path, errors) {
    if (value === undefined || value === null) return;
    if (allowed.indexOf(value) === -1) pushError(errors, code, message, path);
  }
  function validateNullableYen(value, path, errors) {
    if (value === undefined || value === null) return;
    if (!isYen(value, 0)) pushError(errors, 'bad-money', '金額は0以上の整数円か、未確認の null です。小数や概算は入れません。', path);
  }
  function validateItem(item, index, errors) {
    var path = 'receipt.items.' + index;
    var blank = { name: null, amountYen: null, qty: null, category: null, facility: null, taxRate: null };
    if (!isPlainObject(item)) {
      pushError(errors, 'bad-item', '品目の形式が不正です。', path);
      return blank;
    }
    var extra = unknownKey(item, ['name', 'amountYen', 'qty', 'category', 'facility', 'taxRate']);
    if (extra) pushError(errors, 'unknown-key', '品目に未対応の項目があります: ' + extra, path + '.' + extra);
    var name = item.name === undefined ? null : item.name;
    var amount = item.amountYen === undefined ? null : item.amountYen;
    var qty = item.qty === undefined ? null : item.qty;
    var category = item.category === undefined ? null : item.category;
    var facility = item.facility === undefined ? null : item.facility;
    var taxRate = item.taxRate === undefined ? null : item.taxRate;
    if (name !== null && cleanText(name, MAX_NAME) === null) pushError(errors, 'bad-item-name', '品目名が不正です。', path + '.name');
    if (amount !== null && !isYen(amount, 0)) pushError(errors, 'bad-money', '品目金額は0以上の整数円か null です。', path + '.amountYen');
    if (qty !== null && (!isYen(qty, 1) || qty > 999)) pushError(errors, 'bad-qty', '数量は1以上の整数か null です。金額の代わりには使いません。', path + '.qty');
    if (category !== null && ITEM_CATEGORIES.indexOf(category) === -1) {
      pushError(errors, 'bad-category', '分類は台帳の区分か、未確認の null です。推測では確定しません。', path + '.category');
    }
    if (facility !== null && FACILITIES.indexOf(facility) === -1) {
      pushError(errors, 'bad-facility', '拠点は「山手」か「新神野」か、未確認の null です。', path + '.facility');
    }
    if (taxRate !== null && TAX_RATES.indexOf(taxRate) === -1) {
      pushError(errors, 'bad-tax-rate', '税率は 8 か 10 か null です。', path + '.taxRate');
    }
    return { name: name, amountYen: amount, qty: qty, category: category, facility: facility, taxRate: taxRate };
  }

  function initialReview(document) {
    var receipt = document.receipt;
    return {
      purchaseDate: receipt.purchaseDate,
      purchaseTime: receipt.purchaseTime,
      storeName: receipt.storeName,
      paymentMethod: receipt.paymentMethod,
      taxMode: receipt.taxMode,
      subtotalYen: receipt.subtotalYen,
      discountYen: receipt.discountYen,
      discountFacility: null,
      taxYen: receipt.taxYen,
      totalYen: receipt.totalYen,
      items: receipt.items.map(function (item) {
        return {
          name: item.name,
          amountYen: item.amountYen,
          qty: item.qty,
          category: item.category,
          facility: item.facility,
          taxRate: item.taxRate
        };
      }),
      cardSelection: null
    };
  }

  function confirmCapabilities(body) {
    var caps = body && body.capabilities;
    if (!isPlainObject(caps)) return { ok: false, reason: 'capabilities-missing' };
    var keys = Object.keys(REQUIRED_CAPABILITIES);
    for (var i = 0; i < keys.length; i++) {
      if (caps[keys[i]] !== REQUIRED_CAPABILITIES[keys[i]]) {
        return { ok: false, reason: 'missing-' + keys[i] };
      }
    }
    return { ok: true, reason: '' };
  }

  function asCardYen(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
    return null;
  }

  function datePrefix(value) {
    if (typeof value !== 'string') return '';
    var match = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    return match ? match[1] + '-' + match[2] + '-' + match[3] : '';
  }

  function cardCandidates(review, cardPending) {
    var pending = Array.isArray(cardPending) ? cardPending : [];
    return pending.map(function (row) {
      var id = typeof row.id === 'string' ? row.id : '';
      var amount = asCardYen(row.amount);
      var rowDate = datePrefix(row.datetime);
      return {
        rowIndex: row.rowIndex,
        id: id,
        name: row.name == null ? '' : String(row.name),
        amount: amount,
        datetime: row.datetime == null ? '' : String(row.datetime),
        similarAmount: amount !== null && amount === review.totalYen,
        similarDate: !!(review.purchaseDate && rowDate && rowDate === review.purchaseDate),
        autoSelected: false,
        proofOfDuplicate: false,
        selectable: id.indexOf('gmail-') === 0 && amount !== null && Number.isInteger(row.rowIndex) && row.rowIndex >= 2
      };
    });
  }

  function sameRate(items) {
    if (!items.length || items.some(function (item) { return item.taxRate == null; })) return null;
    var rate = items[0].taxRate;
    if (items.some(function (item) { return item.taxRate !== rate; })) return null;
    return rate;
  }

  function exclusiveTaxCandidates(net, rate) {
    var raw = net * rate / 100;
    return [Math.floor(raw), Math.round(raw), Math.ceil(raw)];
  }

  function inclusiveTaxCandidates(gross, rate) {
    var rawNet = gross * 100 / (100 + rate);
    return [Math.floor(rawNet), Math.round(rawNet), Math.ceil(rawNet)].map(function (net) {
      return gross - net;
    });
  }

  function allocateExclusiveTax(items, taxYen) {
    var yamate = 0;
    var shinkano = 0;
    items.forEach(function (item) {
      if (item.facility === '山手') yamate += item.amountYen;
      if (item.facility === '新神野') shinkano += item.amountYen;
    });
    var itemSum = yamate + shinkano;
    if (!isYen(taxYen, 0) || itemSum <= 0) return [];
    var lines = [];
    if (yamate > 0 && shinkano > 0) {
      var yamateTax = Math.round(taxYen * (yamate / itemSum));
      var shinkanoTax = taxYen - yamateTax;
      if (yamateTax !== 0) lines.push(taxLine('山手', yamateTax));
      if (shinkanoTax !== 0) lines.push(taxLine('新神野', shinkanoTax));
    } else if (yamate > 0 && taxYen !== 0) {
      lines.push(taxLine('山手', taxYen));
    } else if (shinkano > 0 && taxYen !== 0) {
      lines.push(taxLine('新神野', taxYen));
    }
    return lines;
  }

  function taxLine(facility, amount) {
    return {
      role: 'tax',
      name: '消費税（按分）',
      amount: amount,
      facility: facility,
      category: '消費税',
      qty: null,
      note: '自動按分'
    };
  }

  function lineNote(role, storeName, taxMode, taxYen, notes, isFirstItem) {
    if (role === 'tax') return '自動按分';
    if (role === 'discount') return 'レシート値引';
    var parts = [];
    if (storeName) parts.push(storeName);
    if (taxMode === 'inclusive') parts.push('内税');
    if (taxMode === 'exclusive') parts.push('外税');
    if (isFirstItem && taxMode === 'inclusive' && taxYen != null) {
      parts.push('内消費税' + taxYen + '円（商品金額には加算していない）');
    }
    if (isFirstItem && notes) parts.push(notes);
    return neutralizeSheetText(parts.join(' / ')).slice(0, 200);
  }

  function buildLines(review) {
    var lines = review.items.map(function (item, index) {
      return {
        role: 'item',
        name: neutralizeSheetText(item.name),
        amount: item.amountYen,
        facility: item.facility,
        category: item.category,
        qty: item.qty,
        note: lineNote('item', review.storeName, review.taxMode, review.taxYen, review.notes, index === 0)
      };
    });
    if (review.discountYen > 0) {
      lines.push({
        role: 'discount',
        name: '値引',
        amount: -review.discountYen,
        facility: review.discountFacility,
        category: '値引',
        qty: null,
        note: 'レシート値引'
      });
    }
    if (review.taxMode === 'exclusive' && review.taxYen > 0) {
      allocateExclusiveTax(review.items, review.taxYen).forEach(function (line) { lines.push(line); });
    }
    return lines;
  }

  function receiptKey(sha256) {
    return 'photo-' + sha256;
  }

  function lineId(sha256, index) {
    var n = String(index);
    while (n.length < 2) n = '0' + n;
    return 'photo-' + sha256 + '-' + n;
  }

  function assignLineIds(sha256, lines) {
    return lines.map(function (line, index) {
      var copy = {};
      Object.keys(line).forEach(function (key) { copy[key] = line[key]; });
      copy.id = lineId(sha256, index);
      return copy;
    });
  }

  /**
   * Exact photo resend uses the sha256 line ids. A different hash is written
   * even when the date and the total are the same. A conflicting shape for
   * the same hash is refused rather than appended.
   */
  function planIdempotentWrite(sha256, lines, existingIds) {
    var prefix = 'photo-' + sha256 + '-';
    var planned = assignLineIds(sha256, lines);
    var ours = (existingIds || []).filter(function (id) {
      return typeof id === 'string' && id.indexOf(prefix) === 0;
    });
    if (!ours.length) return { kind: 'write', lines: planned, skippedIds: [] };
    var plannedIds = {};
    planned.forEach(function (line) { plannedIds[line.id] = 1; });
    var unknown = ours.filter(function (id) { return !plannedIds[id]; });
    if (unknown.length) {
      return { kind: 'conflict', lines: [], skippedIds: ours, existingIds: ours };
    }
    var existing = {};
    ours.forEach(function (id) { existing[id] = 1; });
    var missing = planned.filter(function (line) { return !existing[line.id]; });
    var skipped = planned.filter(function (line) { return existing[line.id]; }).map(function (line) { return line.id; });
    if (!missing.length) return { kind: 'duplicate', lines: planned, skippedIds: skipped };
    return { kind: 'retry-partial', lines: missing, skippedIds: skipped };
  }

  function duplicateClass(left, right) {
    if (left && right && left.photoSha256 && left.photoSha256 === right.photoSha256) return 'exact-photo';
    return 'not-duplicate';
  }

  function readReviewYen(value, path, errors, label) {
    if (value === null || value === undefined || value === '') {
      pushError(errors, 'unresolved', label + 'が未確認です。読めない金額は空のままなので、確認できるまで保存できません。', path);
      return null;
    }
    if (!isYen(value, 0)) {
      pushError(errors, 'bad-money', label + 'は整数の円で入力してください。', path);
      return null;
    }
    return value;
  }

  function evaluateReviewed(document, review, context) {
    context = context || {};
    review = review || {};
    var errors = [];
    var warnings = [];
    var infos = [];
    if (!document || !document.photo || !isSha256(document.photo.sha256)) {
      return done([issue('bad-document', '読み取り結果がありません。')]);
    }
    if (document.example === true) {
      pushError(errors, 'example-data', 'これは合成の記入例です。本番のシートには保存できません。', 'example');
    }
    if (context.verifiedPhotoSha256 == null || context.verifiedPhotoSha256 === '') {
      pushError(errors, 'photo-hash-unverified', 'ボットへ送ったのと同じ写真ファイルを選んでください。このブラウザの中だけでハッシュを照合し、一致するまで保存しません。写真はサーバへ送りません。', 'photo.sha256');
    } else if (!isSha256(context.verifiedPhotoSha256) || context.verifiedPhotoSha256 !== document.photo.sha256) {
      pushError(errors, 'photo-hash-mismatch', '選んだ写真のハッシュが読み取り結果と一致しません。再圧縮された別ファイルの可能性があります。保存しません。', 'photo.sha256');
    } else if (context.verifiedPhotoByteLength !== document.photo.byteLength) {
      pushError(errors, 'photo-size-mismatch', '選んだ写真のバイト数が読み取り結果と一致しません。', 'photo.byteLength');
    }
    var caps = confirmCapabilities(context.capabilitiesBody);
    if (!caps.ok) {
      pushError(errors, 'backend-unconfirmed', 'サーバが購入日の保存と写真IDの再送防止に対応していることを確認できません。日付を落とす従来の保存には切り替えません。', 'capabilities');
    }

    var purchaseDate = review.purchaseDate || null;
    if (!isIsoDate(purchaseDate)) {
      pushError(errors, 'unresolved', '購入日が未確認です。レシートに印字された日付を入れてください。取り込んだ日時は使いません。', 'receipt.purchaseDate');
    }
    var purchaseTime = review.purchaseTime || null;
    if (purchaseTime !== null && !isTime(purchaseTime)) {
      pushError(errors, 'bad-time', '時刻は HH:MM か空欄です。', 'receipt.purchaseTime');
      purchaseTime = null;
    }
    var storeName = review.storeName || null;
    if (storeName !== null) {
      storeName = cleanText(storeName, MAX_NAME);
      if (storeName === null) pushError(errors, 'bad-store', '店名が不正です。', 'receipt.storeName');
    }
    var paymentMethod = review.paymentMethod || null;
    if (PAYMENTS.indexOf(paymentMethod) === -1) {
      pushError(errors, 'unresolved', '支払方法が未確認です。現金かカードかを、レシートを見て選んでください。', 'receipt.paymentMethod');
    }
    var taxMode = review.taxMode || null;
    if (taxMode !== 'inclusive' && taxMode !== 'exclusive') {
      pushError(errors, 'unresolved', '内税か外税かが未確認です。税額を足すかどうかは、ここが分かるまで決めません。', 'receipt.taxMode');
    }
    var totalYen = readReviewYen(review.totalYen, 'receipt.totalYen', errors, '合計');
    if (totalYen === 0) pushError(errors, 'total-not-positive', '合計が0円の読み取りは保存できません。', 'receipt.totalYen');
    var discountYen = readReviewYen(review.discountYen, 'receipt.discountYen', errors, '値引');
    var taxYen = readReviewYen(review.taxYen, 'receipt.taxYen', errors, '消費税');
    var subtotalYen = review.subtotalYen === undefined ? null : review.subtotalYen;
    if (subtotalYen !== null && subtotalYen !== undefined && subtotalYen !== '') {
      if (!isYen(subtotalYen, 0)) pushError(errors, 'bad-money', '小計は整数の円か空欄です。', 'receipt.subtotalYen');
    } else {
      subtotalYen = null;
    }

    var items = Array.isArray(review.items) ? review.items : [];
    if (!items.length) pushError(errors, 'no-items', '品目がありません。', 'receipt.items');
    var normalizedItems = items.map(function (item, index) {
      var path = 'receipt.items.' + index;
      var name = item && cleanText(item.name, MAX_NAME);
      var amount = item ? item.amountYen : null;
      var facility = item ? item.facility : null;
      var category = item ? item.category : null;
      var qty = item && item.qty != null && item.qty !== '' ? item.qty : null;
      var taxRate = item && item.taxRate != null && item.taxRate !== '' ? item.taxRate : null;
      if (!name) pushError(errors, 'unresolved', '品目名が未確認です。', path + '.name');
      if (amount === null || amount === undefined || amount === '') {
        pushError(errors, 'unresolved', '品目金額が未確認です。合計を各品目へコピーしません。', path + '.amountYen');
        amount = null;
      } else if (!isYen(amount, 0)) {
        pushError(errors, 'bad-money', '品目金額は0以上の整数円です。', path + '.amountYen');
        amount = null;
      }
      if (FACILITIES.indexOf(facility) === -1) {
        pushError(errors, 'unresolved', '拠点が未確認です。山手か新神野かを選んでください。', path + '.facility');
        facility = null;
      }
      if (ITEM_CATEGORIES.indexOf(category) === -1) {
        pushError(errors, 'unresolved', '分類が未確認です。レシートから推測して確定はしません。', path + '.category');
        category = null;
      }
      if (qty !== null && (!isYen(qty, 1) || qty > 999)) {
        pushError(errors, 'bad-qty', '数量が不正です。金額の計算には使いません。', path + '.qty');
        qty = null;
      }
      if (taxRate !== null && TAX_RATES.indexOf(taxRate) === -1) {
        pushError(errors, 'bad-tax-rate', '税率が不正です。', path + '.taxRate');
        taxRate = null;
      }
      return { name: name, amountYen: amount, qty: qty, category: category, facility: facility, taxRate: taxRate };
    });

    var discountFacility = review.discountFacility || null;
    if (discountYen > 0 && FACILITIES.indexOf(discountFacility) === -1) {
      pushError(errors, 'discount-facility', '値引の拠点が未確認です。値引を品目へ割り戻すことはしません。', 'receipt.discountFacility');
    }

    var itemSum = null;
    if (normalizedItems.every(function (item) { return item.amountYen != null; })) {
      itemSum = normalizedItems.reduce(function (sum, item) { return sum + item.amountYen; }, 0);
    }
    if (itemSum != null && subtotalYen != null && itemSum !== subtotalYen) {
      pushError(errors, 'subtotal-mismatch', '品目の合計と小計が一致しません。どちらかを直してください。自動では揃えません。', 'receipt.subtotalYen');
    }
    if (itemSum != null && discountYen != null && taxYen != null && totalYen != null && (taxMode === 'inclusive' || taxMode === 'exclusive')) {
      var expected = taxMode === 'exclusive' ? itemSum - discountYen + taxYen : itemSum - discountYen;
      if (expected !== totalYen) {
        pushError(errors, 'total-mismatch', taxMode === 'exclusive'
          ? '外税の合計が一致しません。品目 − 値引 + 消費税 = 合計、になるよう確認してください。税を二重に足さないでください。'
          : '内税の合計が一致しません。品目 − 値引 = 合計です。内消費税は合計に足しません。', 'receipt.totalYen');
      }
    }
    if (taxMode === 'inclusive' && taxYen != null && totalYen != null && taxYen > totalYen) {
      pushError(errors, 'inclusive-tax-added', '内消費税が合計を超えています。税を別枠で足していないか確認してください。', 'receipt.taxYen');
    }
    if (Object.prototype.hasOwnProperty.call(review, 'addedTaxYen')) {
      if (taxMode === 'inclusive' && review.addedTaxYen !== 0) {
        pushError(errors, 'inclusive-tax-added', '内税のレシートでは、加算する消費税は0です。内消費税は合計に足しません。', 'addedTaxYen');
      }
      if (taxMode === 'exclusive' && taxYen != null && review.addedTaxYen !== taxYen) {
        pushError(errors, 'exclusive-tax-added', '加算する消費税がレシートの税額と一致しません。品目金額へ税を上乗せせず、消費税欄は税額そのものにしてください。', 'addedTaxYen');
      }
    }
    var rate = sameRate(normalizedItems);
    if (rate && discountYen === 0 && taxYen != null && itemSum != null) {
      if (taxMode === 'exclusive') {
        var exclusiveOk = exclusiveTaxCandidates(itemSum, rate).indexOf(taxYen) !== -1;
        if (!exclusiveOk) {
          pushError(errors, 'exclusive-tax-mismatch', '外税の税額が、品目合計と税率から切り捨て・四捨五入・切り上げのいずれにも一致しません。数字は補正しません。', 'receipt.taxYen');
        }
      }
      if (taxMode === 'inclusive') {
        var inclusiveOk = inclusiveTaxCandidates(itemSum, rate).indexOf(taxYen) !== -1;
        if (!inclusiveOk) {
          pushError(errors, 'inclusive-tax-mismatch', '内税の税額が、税込金額と税率から計算した範囲に一致しません。数字は補正しません。', 'receipt.taxYen');
        }
      }
    }

    var candidates = cardCandidates(review, context.cardPending);
    var cardPlan = { action: 'photoReceiptImport', blocked: false, candidates: candidates };
    if (paymentMethod === 'カード') {
      var selection = review.cardSelection;
      if (!selection || selection.explicit !== true) {
        cardPlan = { action: 'blocked', blocked: true, code: 'card-row-required', candidates: candidates };
        pushError(errors, 'card-row-required', 'カード払いは、自動取込の行を自分で選んで内訳にします。日付や金額が同じだけでは選びません。新しいカード支出は追加しません。', 'cardSelection');
      } else {
        var chosen = candidates.filter(function (row) {
          return row.id === selection.id && row.rowIndex === selection.rowIndex;
        })[0];
        if (!chosen || !chosen.selectable) {
          cardPlan = { action: 'blocked', blocked: true, code: 'card-id-unverified', candidates: candidates };
          pushError(errors, 'card-id-unverified', '選んだカード行のIDを確認できません。行番号だけでは更新しないので、保存しません。', 'cardSelection');
        } else if (!isYen(totalYen, 1) || chosen.amount !== totalYen) {
          cardPlan = { action: 'blocked', blocked: true, code: 'card-amount-mismatch', candidates: candidates };
          pushError(errors, 'card-amount-mismatch', '自動取込の金額とレシート合計が一致しません。行を0円にしたり、別のカード支出を足したりはしません。', 'cardSelection');
        } else {
          cardPlan = {
            action: 'photoReceiptCardBreakdown',
            blocked: false,
            candidates: candidates,
            sourceRowIndex: chosen.rowIndex,
            expectedId: chosen.id,
            expectedAmount: chosen.amount
          };
        }
      }
      if (candidates.some(function (row) { return row.similarAmount || row.similarDate; })) {
        infos.push(issue('similar-card-not-duplicate', '日付や金額が近い自動取込があります。それだけでは同じレシートと見なしません。', 'cardPending'));
      }
    }

    var ready = errors.length === 0 && itemSum != null && discountYen != null && taxYen != null && totalYen != null;
    var lines = null;
    var post = null;
    if (ready) {
      var draft = {
        items: normalizedItems,
        discountYen: discountYen,
        discountFacility: discountFacility,
        taxMode: taxMode,
        taxYen: taxYen,
        storeName: storeName,
        purchaseDate: purchaseDate,
        notes: document.notes
      };
      lines = assignLineIds(document.photo.sha256, buildLines(draft));
      var lineSum = lines.reduce(function (sum, line) { return sum + line.amount; }, 0);
      if (lineSum !== totalYen) {
        pushError(errors, 'line-sum', '保存行の合計がレシート合計と一致しません。保存しません。', 'lines');
        lines = null;
      } else if (taxMode === 'inclusive' && lines.some(function (line) { return line.role === 'tax'; })) {
        pushError(errors, 'inclusive-tax-line', '内税なのに消費税の行ができています。保存しません。', 'lines');
        lines = null;
      } else if (taxMode === 'exclusive') {
        var taxSum = lines.filter(function (line) { return line.role === 'tax'; }).reduce(function (sum, line) { return sum + line.amount; }, 0);
        if (taxSum !== taxYen) {
          pushError(errors, 'tax-line-sum', '消費税の按分行が税額と一致しません。', 'lines');
          lines = null;
        }
      }
      if (lines) {
        var itemLines = lines.filter(function (line) { return line.role === 'item'; });
        var amountsUntouched = itemLines.every(function (line, index) { return line.amount === normalizedItems[index].amountYen; });
        if (!amountsUntouched) {
          pushError(errors, 'item-amount-changed', '品目金額が書き換わっています。保存しません。', 'lines');
          lines = null;
        }
      }
    }
    if (lines && caps.ok && document.example !== true) {
      post = {
        action: cardPlan.action,
        receiptId: receiptKey(document.photo.sha256),
        purchaseDate: purchaseDate,
        purchaseTime: purchaseTime,
        paymentMethod: paymentMethod,
        taxMode: taxMode,
        taxYen: taxYen,
        discountYen: discountYen,
        totalYen: totalYen,
        storeName: storeName ? neutralizeSheetText(storeName) : '',
        lines: lines.map(function (line) {
          return {
            id: line.id,
            role: line.role,
            name: line.name,
            amount: line.amount,
            facility: line.facility,
            category: line.category,
            qty: line.qty || '',
            note: line.note
          };
        })
      };
      if (post.action === 'photoReceiptCardBreakdown') {
        post.sourceRowIndex = cardPlan.sourceRowIndex;
        post.expectedId = cardPlan.expectedId;
        post.expectedAmount = cardPlan.expectedAmount;
        post.ignoreSource = false;
        post.createSeparateCardExpense = false;
        post.zeroSourceAfterWrite = true;
      }
      if (post.action !== 'photoReceiptImport' && post.action !== 'photoReceiptCardBreakdown') post = null;
    } else {
      post = null;
    }

    return {
      ok: errors.length === 0 && !!post,
      errors: errors,
      warnings: warnings,
      infos: infos,
      lines: post ? lines : null,
      post: post,
      card: cardPlan
    };

    function done(list) {
      return { ok: false, errors: list, warnings: [], infos: [], lines: null, post: null, card: { action: 'blocked', blocked: true, candidates: [] } };
    }
  }

  function interpretSaveResponse(data, expected) {
    var fail = { ok: false, clearForm: false, message: '保存の応答を確認できませんでした。画面の内容は残します。同じ内容の再送は、対応済みのサーバでは写真IDで二重追加になりません。' };
    if (!isPlainObject(data) || data.status !== 'success' || data.photoReceipt !== true) return fail;
    if (!expected || data.action !== expected.action || data.receiptId !== expected.receiptId || data.purchaseDate !== expected.purchaseDate) {
      return fail;
    }
    if (data.duplicate === true) {
      return { ok: true, clearForm: true, duplicate: true, message: 'この写真IDはすでに保存されています。同じ内容の再送として処理しました。新しい行は増えていません。' };
    }
    if (!Number.isSafeInteger(data.added) || data.added < 0 || !Number.isSafeInteger(data.skipped) || data.skipped < 0) {
      return fail;
    }
    return { ok: true, clearForm: true, duplicate: false, message: 'サーバが保存成功と応答しました。購入日はレシートの日付です。' };
  }

  function sha256Hex(bytes) {
    var buffer = toArrayBuffer(bytes);
    return crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
      var view = new Uint8Array(digest);
      var hex = '';
      for (var i = 0; i < view.length; i++) {
        var part = view[i].toString(16);
        hex += part.length === 1 ? '0' + part : part;
      }
      return hex;
    });
  }

  function toArrayBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes;
    if (ArrayBuffer.isView(bytes)) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    throw new Error('bytes');
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_JSON_BYTES: MAX_JSON_BYTES,
    FACILITIES: FACILITIES,
    PAYMENTS: PAYMENTS,
    ITEM_CATEGORIES: ITEM_CATEGORIES,
    LINE_CATEGORIES: LINE_CATEGORIES,
    REQUIRED_CAPABILITIES: REQUIRED_CAPABILITIES,
    parseImportJson: parseImportJson,
    initialReview: initialReview,
    confirmCapabilities: confirmCapabilities,
    evaluateReviewed: evaluateReviewed,
    planIdempotentWrite: planIdempotentWrite,
    duplicateClass: duplicateClass,
    allocateExclusiveTax: allocateExclusiveTax,
    interpretSaveResponse: interpretSaveResponse,
    neutralizeSheetText: neutralizeSheetText,
    sha256Hex: sha256Hex,
    isSha256: isSha256,
    receiptKey: receiptKey,
    lineId: lineId
  };
});
