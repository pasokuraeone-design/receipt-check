/**
 * In-memory ledger for the photo-review demo.
 * Save/read-back follows the same photo actions as gas/photoReceiptImport.gs.
 * Nothing here calls the network or a spreadsheet.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MockLedger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function receiptLib() {
    if (typeof globalThis !== 'undefined' && globalThis.ReceiptImport) return globalThis.ReceiptImport;
    if (typeof require === 'function') return require('./receiptImport.js');
    throw new Error('ReceiptImport');
  }

  function syntheticFixtures() {
    return [
      cardRow('gmail-demo-a', '2026/04/01', 'サンプル商店', 1080),
      cardRow('gmail-demo-b', '2026/03/02', '別のサンプル店', 500),
      {
        id: 'synthetic-manual',
        purchaseDate: '2026/04/01',
        facility: '',
        name: '日付と金額だけ同じ行',
        qty: '',
        category: '未確認',
        note: '模擬。gmail- で始まらないので自動取込としては選べません。',
        requester: 'フジタ',
        amount: 1080,
        payment: 'カード'
      }
    ];
  }

  function cardRow(id, purchaseDate, name, amount) {
    return {
      id: id,
      purchaseDate: purchaseDate,
      facility: '',
      name: name,
      qty: '',
      category: '未確認',
      note: '模擬のカード自動取込',
      requester: 'フジタ(カード自動)',
      amount: amount,
      payment: 'カード'
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function dateCell(post) {
    var cell = String(post.purchaseDate || '').replace(/-/g, '/');
    if (post.purchaseTime) cell += ' ' + post.purchaseTime;
    return cell;
  }

  function lineSum(lines) {
    return lines.reduce(function (sum, line) { return sum + line.amount; }, 0);
  }

  function createMockLedger() {
    var R = receiptLib();
    var fixtures = syntheticFixtures();
    var rows = clone(fixtures);

    function snapshot() {
      return rows.map(function (row, index) {
        var copy = clone(row);
        copy.rowIndex = index + 2;
        copy.tax = '';
        copy.total = '';
        return copy;
      });
    }

    function read() {
      var cardPending = [];
      rows.forEach(function (row, index) {
        var open = row.payment === 'カード' && row.facility === '' && row.amount !== 0 &&
          row.category !== '内訳入力済み' && row.category !== '重複のため無視';
        if (!open) return;
        cardPending.push({
          rowIndex: index + 2,
          id: row.id,
          name: row.name,
          amount: row.amount,
          datetime: row.purchaseDate,
          note: row.note
        });
      });
      return {
        pending: [],
        cardPending: cardPending,
        capabilities: clone(R.REQUIRED_CAPABILITIES),
        demo: true,
        ledger: 'mock'
      };
    }

    function error(message) {
      return { status: 'error', message: message };
    }

    function success(action, post, added, skipped, duplicate) {
      return {
        status: 'success',
        photoReceipt: true,
        action: action,
        receiptId: post.receiptId,
        purchaseDate: post.purchaseDate,
        added: added,
        skipped: skipped,
        duplicate: duplicate === true,
        demo: true
      };
    }

    function shaOf(post) {
      var match = /^photo-([a-f0-9]{64})$/.exec(post.receiptId || '');
      return match ? match[1] : '';
    }

    function appendPlanned(post, planned) {
      planned.forEach(function (line) {
        rows.push({
          id: line.id,
          purchaseDate: dateCell(post),
          facility: line.facility,
          name: line.name,
          qty: line.qty || '',
          category: line.category,
          note: line.note || '',
          requester: 'フジタ',
          amount: line.amount,
          payment: post.paymentMethod,
          tax: '',
          total: ''
        });
      });
    }

    function decide(post) {
      var sha = shaOf(post);
      if (!sha) return { error: 'receiptId' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(post.purchaseDate || '')) return { error: '購入日が不正です。' };
      if (!post.lines || !post.lines.length) return { error: '品目がありません。' };
      if (lineSum(post.lines) !== post.totalYen) return { error: '行の合計がレシート合計と一致しません。' };
      if (post.image || post.base64 || post.bytes || post.dataUrl) return { error: '写真そのものは受け付けません。' };
      var decision = R.planIdempotentWrite(sha, post.lines, rows.map(function (row) { return row.id; }));
      decision.sha = sha;
      return decision;
    }

    function apply(post) {
      if (!post || (post.action !== 'photoReceiptImport' && post.action !== 'photoReceiptCardBreakdown')) {
        return error('この模擬台帳にその操作はありません。');
      }
      if (post.action === 'photoReceiptImport' && post.paymentMethod === 'カード') {
        return error('カード払いは自動取込行の内訳として保存します。別のカード支出は追加しません。');
      }
      if (post.action === 'photoReceiptCardBreakdown') {
        if (post.ignoreSource !== false || post.createSeparateCardExpense !== false || post.zeroSourceAfterWrite !== true) {
          return error('カード行の無視や、別のカード支出の追加は受け付けません。');
        }
        if (post.paymentMethod !== 'カード' || typeof post.expectedId !== 'string' || post.expectedId.indexOf('gmail-') !== 0) {
          return error('自動取込IDを確認できないため、行は変更しません。');
        }
        var index = post.sourceRowIndex - 2;
        var current = rows[index];
        if (!current || current.id !== post.expectedId) {
          return error('カード行のIDが一致しません。行の挿入でずれている可能性があるため、何も変更しません。');
        }
        var settled = current.facility === '済' && current.amount === 0 && current.category === '内訳入力済み';
        if (!settled) {
          if (current.payment !== 'カード' || current.facility !== '' || current.amount !== post.expectedAmount || current.amount !== post.totalYen) {
            return error('自動取込の金額とレシート合計が一致しません。0円にはしません。');
          }
        }
        var cardDecision = decide(post);
        if (cardDecision.error) return error(cardDecision.error);
        if (cardDecision.kind === 'conflict') return error('同じ写真IDの別内容が既にあります。カード行は変更しません。');
        var toWrite = cardDecision.kind === 'duplicate' ? [] : (cardDecision.lines || []);
        appendPlanned(post, toWrite);
        if (!settled) {
          var again = rows[index];
          if (!again || again.id !== post.expectedId || again.amount !== post.expectedAmount) {
            return error('書き込み後にカード行のIDを確認できませんでした。別の行は0円にしていません。');
          }
          again.facility = '済';
          again.category = '内訳入力済み';
          again.amount = 0;
        }
        return success(post.action, post, toWrite.length, (cardDecision.skippedIds || []).length, cardDecision.kind === 'duplicate');
      }
      var decision = decide(post);
      if (decision.error) return error(decision.error);
      if (decision.kind === 'conflict') return error('同じ写真IDの別内容が既にあります。追記しません。');
      var planned = decision.kind === 'duplicate' ? [] : decision.lines;
      appendPlanned(post, planned);
      return success(post.action, post, planned.length, (decision.skippedIds || []).length, decision.kind === 'duplicate');
    }

    function reset() {
      rows = clone(fixtures);
    }

    function shift() {
      rows.unshift({
        id: 'synthetic-shift',
        purchaseDate: '2026/01/01',
        facility: '山手',
        name: '行ずれ確認用',
        qty: '',
        category: 'その他',
        note: '模擬。行番号をずらすためだけに入れています。',
        requester: 'フジタ',
        amount: 1,
        payment: '現金',
        tax: '',
        total: ''
      });
    }

    function dropLastPhotoLine(receiptId) {
      var prefix = receiptId + '-';
      for (var i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i].id).indexOf(prefix) === 0) {
          rows.splice(i, 1);
          return true;
        }
      }
      return false;
    }

    return {
      read: read,
      apply: apply,
      reset: reset,
      shift: shift,
      dropLastPhotoLine: dropLastPhotoLine,
      snapshot: snapshot
    };
  }

  return {
    createMockLedger: createMockLedger,
    syntheticFixtures: syntheticFixtures
  };
});
