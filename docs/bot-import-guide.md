# Bot guide: receipt photo to JSON

Read the receipt photo in the chat. Do not call an OCR API, do not send the image to a third party, and do not put the image or the receipt in a URL. Hand the operator a `.json` file. The app imports that file locally, the operator reviews it, and only then can it be saved.

The sample file `examples/receipt-photo-import.example.json` is synthetic. Copy its shape, not its hash.

## Identity

Hash the exact bytes of the file the operator will select again in the app. Prefer the original file they sent. If the chat client recompresses the image before you see it, you cannot honestly hash the original: leave the import blocked rather than inventing a hash. A recompressed file is a different identity.

```bash
sha256sum receipt.jpg
```

```js
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const bytes = fs.readFileSync(process.argv[2]);
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + '\n');
```

Write lowercase hex only. `photo.byteLength` is the byte length of that same file. The browser hashes the file the operator picks and refuses to save on a mismatch. The photo is not uploaded.

`receiptId` is `photo-` plus that sha256. Line ids are `photo-<sha256>-00`, `-01`, … in the confirmed save order. The app assigns them. The same hash is an exact resend: the server skips those ids. A second photo with the same date and the same total is a different hash and is not a duplicate. Do not warn that two receipts are the same only because the date and amount match.

## What you may fill

`schemaVersion` is `1`. `source` is `grok-bot-photo`.

Money is integer yen or `null`. Never send a guess, a float, or a rounded-looking number you could not read. If a digit is unclear, set that field to `null` and list its path in `unreadable`. A path in `unreadable` must be null. Do not copy the receipt total or the tax into item amounts.

Leave these null unless they are actually known. The app will not default them, and save stays off until the operator chooses:

- `paymentMethod`: `現金` or `カード` only when the receipt shows it
- `facility` on each item: `山手` or `新神野` only when the operator already said so. A normal receipt does not print this
- `category`: `食費`, `日用品費`, `備品`, `郵送費`, or `その他` only when the operator already said so. Do not guess from the product name

`purchaseDate` is the printed date, `YYYY-MM-DD`. Do not use the time the message arrived. `purchaseTime` is `HH:MM` or null. `taxMode` is `exclusive` when the tax is added on top of the item lines (外税), or `inclusive` when the item lines already contain tax (内税). If you cannot tell, use null.

`qty` is optional and is not multiplied into `amountYen`. `amountYen` is the line amount as printed. `taxRate` is `8`, `10`, or null. Do not invent a rate.

`discountYen` is the receipt discount once, as a positive integer, or `0` when the receipt shows no discount. Null if you cannot tell. Do not spread the discount across items.

## Totals

- Exclusive: sum of item amounts − `discountYen` + `taxYen` = `totalYen`
- Inclusive: sum of item amounts − `discountYen` = `totalYen`, and `taxYen` is the tax inside that total

`subtotalYen`, when you can read it, is the sum of the item amounts before the discount. Do not make the numbers match by changing an unreadable digit.

## Card payments

If the payment is カード, say so and stop. The app will not add another card expense. The operator links the receipt to an existing Gmail auto-import row and saves it as a breakdown of that row. You do not choose the row, even when the date and amount look the same.

## Do not

- Do not set `example: true` on a real reading. Example files cannot be saved.
- Do not embed image bytes, data URLs, or base64.
- Do not put secrets, tokens, or the Apps Script URL in the JSON.
- Do not tell the operator that a browser warning is the duplicate lock. Only the server id check does that, and only after the script patch in `docs/backend-integration.md` is deployed and the page shows the capability confirmation.
