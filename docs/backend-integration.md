# Backend integration

Try the operator demo in `demo/receipt-photo-demo.html` first. It never calls Google. The next real check is a new spreadsheet and `gas/synthetic-harness/`, not a paste into the live script. See `gas/synthetic-harness/README.md`. That isolated test is still something a person has to run. It is not done in this repository.

The page can review a photo reading offline. It will not save that reading until a live `doGet` returns the capability object below, and the save response echoes the new action. This repository does not contain the live Apps Script. Nothing here was deployed, and the production web app was not called.

Manual receipt save still posts `confirmReceipt`. Card facility, ignore, and the existing breakdown buttons are unchanged. Photo save never calls those actions.

## What is still pending

Paste `gas/photoReceiptImport.gs` into the bottom of `コード.gs`. Do not replace that file with this patch. On a copy of the spreadsheet, add the branches below, deploy a test web app, and confirm `doGet` plus one synthetic save. Only then point the page at that deployment. This pull request does not do that, so end-to-end saving against the real sheet is not done.

The public web app still has no auth in the reviewed source, and it trusts `rowIndex` for the old actions. The photo actions below refuse to update a card row unless column A is exactly the `gmail-` id the client sent and the amount still matches, immediately before the write and again before the row is marked. That reduces a shifted row, it does not make a public URL safe.

Realistic mitigations, without putting a secret in `index.html`:

- Deploy the web app as private to the operator account, or put a token in Script Properties and type it into a field that is not stored in the repo. A token compiled into this HTML is public.
- Keep the existing script lock around the new branches. Do not lock again inside them.
- Do not add a second card expense, and do not call `ignoreCardImport`, from the photo path.
- Treat a matching date and amount as a hint only. The duplicate key is `photo-` plus the sha256.

## doGet

Add this to the JSON object the existing `doGet` already returns. Leave `pending` and `cardPending` in place.

```javascript
capabilities: photoReceiptCapabilities_()
```

On each `cardPending` object, add the column A value as `id`. Old clients ignore the extra field. The photo screen will not select a card row that has no `gmail-` id.

```javascript
{
  photoReceiptImport: 1,
  purchaseDate: true,
  idempotency: true,
  cardBreakdown: true,
  taxAsAllocatedLines: true,
  rejectsCardOnPlainImport: true,
  cardRowId: true
}
```

Do not advertise these flags until the actions below are on the same deployment. A partial flag set stays fail-closed in the browser.

## doPost

Inside the existing `data.action` branch, before the legacy shopping-request fallback:

```javascript
} else if (data.action === 'photoReceiptImport') {
  result = photoReceiptImport_(data);
} else if (data.action === 'photoReceiptCardBreakdown') {
  result = photoReceiptCardBreakdown_(data);
}
```

Return `result` through the same JSON path as `confirmReceipt`. The photo client reads the body. A legacy body such as `{status:'success', updated, added}` is treated as failure and the form is kept. Success must be:

```javascript
{
  status: 'success',
  photoReceipt: true,
  action: 'photoReceiptImport', // or photoReceiptCardBreakdown
  receiptId: 'photo-<sha256>',
  purchaseDate: 'YYYY-MM-DD',
  added: 0,
  skipped: 0,
  duplicate: false
}
```

## What the new actions write

Column B is the receipt date as text `YYYY/MM/DD` or `YYYY/MM/DD HH:MM`, not `new Date()` and not the import time. Column I is the line amount only. Columns J and K stay blank, matching the current sheet. Exclusive tax is extra `消費税（按分）` lines. Inclusive tax is not given an amount line. A discount is one negative `値引` line. Item amounts are not replaced with the receipt total or the tax.

Ids are `photo-<sha256>-00` onward. The same ids are skipped. A different shape for the same hash writes nothing. `photoReceiptImport` rejects `支払方法 = カード`.

`photoReceiptCardBreakdown` checks the source row, appends the breakdown lines, checks the same `gmail-` id and amount again, then sets column C to `済`, column F to `内訳入力済み`, and column I to `0`. That zero is the existing breakdown marker so the card charge is not counted twice. It is not `ignoreCardImport`. If the id or the amount changed, it does not zero the row. Rows already appended keep their photo ids, so a retry does not add them again.

## Check on a copy

1. `doGet` includes `capabilities` and card `id`s. The page text changes from the fail-closed warning.
2. A cash photo save uses `photoReceiptImport`, and column B is the receipt date.
3. Posting the same body again returns `duplicate: true` and does not add rows.
4. The same date and amount with another sha256 adds a different receipt.
5. A card photo save uses only `photoReceiptCardBreakdown`. The source amount becomes 0 after the new lines sum to that amount. No second card total appears.
6. A card row whose amount differs is not modified.
7. `confirmReceipt` still works for a receipt typed by hand.
