Backend REST API Catalog

This file lists all REST API routes provided by the backend (grouped and numbered). For each route we show: HTTP method, path, authentication requirement, validation (if present), controller handler and a short description.

1. Authentication & Business Onboarding

1.1 POST /api/v1/business/gst/verify
- Auth: none
- Middleware: `gstRateLimiter`, `validate(gstVerifySchema)`
- Controller: `authController.verifyGst` ([backend/src/controllers/auth.controller.js])
- Description: Verify GST number and fetch GST details.

1.2 POST /api/v1/business/gst/confirm
- Auth: none
- Middleware: `validate(gstConfirmSchema)`
- Controller: `authController.confirmGst`
- Description: Confirm GST details after verification.

1.3 POST /api/v1/business/contact-details
- Auth: none
- Middleware: `validate(contactDetailsSchema)`
- Controller: `authController.submitContactDetails`
- Description: Submit initial contact details for business onboarding.

1.4 GET /api/v1/dev/otps/:businessId
- Auth: none
- Controller: `authController.getDevOtps`
- Description: Development helper to retrieve OTPs for a business (dev only).

1.5 POST /api/v1/business/verify-phone-otp
- Auth: none
- Middleware: `validate(verifyOtpSchema)`
- Controller: `authController.verifyPhoneOtp`

1.6 POST /api/v1/business/verify-email-otp
- Auth: none
- Middleware: `validate(verifyOtpSchema)`
- Controller: `authController.verifyEmailOtp`

1.7 POST /api/v1/business/create-password
- Auth: none
- Middleware: `validate(createPasswordSchema)`
- Controller: `authController.createPassword`

1.8 POST /api/v1/business/login
- Auth: none
- Middleware: `validate(loginSchema)`
- Controller: `authController.login`
- Description: Business owner login, returns JWT tokens via `auth.service`.

1.9 POST /api/v1/employee/login
- Auth: none
- Middleware: `loginAttemptLimiter` (same per-number bucket as the owner login), `validate(employeeLoginSchema)`
- Controller: `authController.loginEmployee`
- Description: the older phone + password employee login; issues the same session as the phone + MPIN login.

1.10 GET /api/v1/employee/permissions
- Auth: JWT required (`authenticateJWT`)
- Controller: `authController.getEmployeePermissions`

1.11 POST /api/v1/change-password
- Auth: JWT required
- Middleware: `validate(changePasswordSchema)`
- Controller: `authController.changePassword`

1.11a POST /api/v1/auth/change-mpin (Settings -> MPIN Manager)
- Auth: JWT required; owner and employee alike. An owner's token changes their
  own record; an employee's changes the EMP sign-in record linked to their
  Employee id.
- Body: `{ currentMpin, newMpin, confirmMpin }`, four-digit strings →
  `200 { success:true, message:'MPIN updated.' }`. The new MPIN is hashed for
  login and sealed for Forgot MPIN / the owner's Show MPIN; an owner's
  password column that held the MPIN moves with it.
- Refusals (`{ success:false, error, message }`, in this order): `400
  MPIN_INVALID` "Enter a 4-digit MPIN"; `400 MPIN_MISMATCH` "MPINs don't
  match"; `429 MPIN_ATTEMPTS_EXCEEDED` after five wrong current MPINs in 15
  minutes for that account (a right one clears the count), "Too many wrong
  MPIN attempts. Please try again in N minutes." with the minutes left; `400
  MPIN_INCORRECT` "Incorrect MPIN."; `400 MPIN_SAME` "Choose an MPIN
  different from the current one". No MPIN yet: `409 MPIN_NOT_SET` (owner),
  `409 EMPLOYEE_MPIN_NOT_SET` (employee).

1.12 POST /api/v1/refresh
- Auth: none
- Controller: `authController.refreshToken`
- Description: Refresh access/refresh tokens via `auth.service.refreshTokens`.

1.13 POST /api/v1/auth/forgot-password/request
- Auth: none
- Middleware: `validate(requestPasswordResetSchema)`
- Description: Resolve a registered phone number or User ID and send a password-reset OTP.

1.14 POST /api/v1/auth/forgot-password/verify-otp
- Auth: none
- Middleware: `validate(verifyPasswordResetOtpSchema)`
- Description: Verify the password-reset OTP and return a single-use, 10-minute reset token.

1.15 POST /api/v1/auth/forgot-password/reset
- Auth: password-reset token in the request body
- Middleware: `validate(resetPasswordSchema)`
- Description: Set and confirm a new password without requesting the forgotten current password.

1.16 POST /api/v1/auth/account/delete-otp
- Auth: JWT required, any role (`authenticateJWT`, `requireCurrentOwner`); 5 an hour per account (`accountDeleteOtpLimiter`)
- Body: `{}` → `200 { success:true, data:{ phoneMasked:'+91 •••••43210', expiresInSeconds:600, resendAfterSeconds:30 } }`
- Description: Texts a 6-digit code (flow `ACCOUNT_DELETE`, under the caller's shop) to the caller's own phone: an owner's (or SUPER's) `business_users` phone, an employee's EMP record phone (else their Employee phone). The number is read as ten digits from any spelling the number checks take ('95000 00031', '09500000031'); none usable → `409 ACCOUNT_PHONE_MISSING` (worded for the role). Never answers with the code, and the code is never printed to the log nor kept for `GET /auth/dev/otps`. MSG91 failing → `502 OTP_SEND_FAILED`; a login gone or switched off since → `401 UNAUTHORIZED`.

1.17 DELETE /api/v1/auth/account
- Auth: JWT required, any role (`authenticateJWT`, `requireCurrentOwner`); 15 an hour per account (`accountDeleteLimiter`)
- Body: `{ otp:'123456', confirm:'DELETE' }` → `200 { success:true, message:'Your account has been deleted.' }`
- Description: Deletes the caller's own account and nothing else (`services/accountRelease.service.js`). `confirm` must be exactly `DELETE` (`400 CONFIRMATION_REQUIRED`), and `otp` the latest unexpired, unused code 1.16 sent for this caller's phone and shop (`400 OTP_INVALID` / `OTP_EXPIRED` / `OTP_NOT_FOUND` / `OTP_ALREADY_USED`); nothing is written on a refusal. The caller's `business_users` record is archived whole in `released_logins` (reason `ACCOUNT_DELETED`, one `[ACCOUNT_DELETED]` log line, ids only) and taken out of `business_users`; an employee's Employee record is also switched off (`isActive:false`, recorded in the entry) and its `sessionVersion` moves on. Their sessions end: an owner's or SUPER's token at once on routes behind `requireCurrentOwner`, a SUPER's also on every `requireRole` check, every refresh at once; an employee's sessions from before stay over even if their owner switches them back on. The business, invoices, scans, wallet and credits, payments, licence, subscription, and the shop's other owners and employees are never touched. `node scripts/restore_released_login.js <releasedLoginId>` puts the login back (and the employee back on).


2. Scanning (Image upload, AI analysis, clarification, review)

All scan routes are under `/api/v1/scans` and the router uses `authenticateJWTOptional` (JWT if present).

2.1 POST /api/v1/scans
- Auth: optional
- Middleware: `validate(createScanSchema)`
- Controller: `scanController.createScan` ([backend/src/controllers/scan.controller.js])
- Description: Initialize a scan session and returns a `scanId`.

2.2 POST /api/v1/scans/:scanId/front-image
- Auth: optional
- Middleware: `upload.single('image')` (multipart)
- Controller: `scanController.uploadFrontImage`
- Description: Upload front-side image of tag.

2.3 POST /api/v1/scans/:scanId/back-image
- Same as front-image, saves back image.

2.4 POST /api/v1/scans/:scanId/analyze
- Auth: optional
- Controller: `scanController.analyzeScan`
- Description: Trigger AI processing (OpenAI/Gemini) for the uploaded images; updates scan state.
- Also prices the reading (`pricing`, `pricingInput`, `pricingError`) from the
  inputs the asking build's card will send, by its `X-Pricing-Rules` (see 2.9).
  Under rules 3 the card opens with its Wastage tile on the net weight, so
  `pricingInput` carries `wastageWeightBasis: "net"` and the wastage is priced
  on the net weight at the current gold rate.
- `labourCode`: the Masters -> Labour Code (3.5) the tag carries, for the
  card's Labour Code box: the one the price matched (`pricing.breakdown
  .labourCode`); without a price (`pricingError`), the one any of
  `tagIdentifiers` names in the caller's list. '' when none, and always ''
  for rules 1. `pricingInput` never carries a `labourCode` (the card opens
  with none picked); its labour is the card's opening labour: the tag's
  printed labour, else (rules 4) the rate of the code the tag names (the one
  `labourCode` names, when it has a rate), else the item's, else the shop's.
  That figure beats the code's rate in the price, so under rules 2 and 3,
  whose cards open with the item's or the shop's labour, the code prices the
  reading only when that box opens empty.
- Every reading returned also starts the scan's line in Tag scan history
  (8.1): status `read`, `finalMRP` the `pricing.finalMRPRounded` above (null
  when it could not be priced), and `details`, everything read (8.2). Written
  after the answer; a failed write is logged, never the reading's failure.

2.5 GET /api/v1/scans/:scanId/clarification
- Auth: optional
- Controller: `scanController.getClarification`
- Description: Returns `fieldsNeedingReview` derived from AI analysis (uses `scan.service.getClarification`).

2.6 POST /api/v1/scans/:scanId/clarification
- Auth: optional
- Middleware: `validate(clarificationSchema)`
- Controller: `scanController.submitClarification`
- Description: Submit user-confirmed mappings for ambiguous abbreviations.

2.7 GET /api/v1/scans/:scanId/review
- Auth: optional
- Controller: `scanController.getReview`
- Description: Returns processed `structuredData` for final review.

2.8 POST /api/v1/scans/:scanId/review
- Auth: optional
- Controller: `scanController.submitReview`
- Description: Submit final review (approve) and mark scan `APPROVED`.

2.9 POST /api/v1/scans/:scanId/calculate
- Auth: JWT required (`authenticateJWT`)
- Controller: `calculationController.calculateMRP`
- Description: Calculate final MRP using scan + rates (protected route for pricing/calculation).
- Every price returned is also the scan's line in Tag scan history (8.1):
  status `priced`, `finalMRP` the `finalMRPRounded`, and `pricing` (8.2), the
  inputs and workings; the line keeps the time the tag was read and what was
  read. Written after the answer; a failed write is logged, never the price's
  failure. A line is started only for a scan on record (one the caller may
  see); a price without one updates the caller's existing line for that id,
  if any. Of two prices for one scan in flight, the later request's stays.
- Header `X-Pricing-Rules`: `4` from the app build whose card opens a tag's
  Masters -> Labour Code at the code's rate: everything in rules 3; this
  endpoint prices it exactly as rules 3, and only the analysis (2.4) opens
  the card's labour differently. `3` from the app build whose Wastage tile
  chooses the weight: everything in rules 2, and wastage priced at the
  current gold rate on the net or the gross weight (`wastageWeightBasis`,
  below). `2` from the app from 1.0.367 (prefix item match, item wastage and
  labour, stone units, percent labour). A number above 4 is priced by rules
  4. No header,
  or `1` (builds up to 1.0.366): the Masters item is the one whose code is
  exactly `itemCode` and its labour is not charged, as those builds invoice.
  Rules 1 and 2 price wastage as they always did: the net weight at the 24K
  rate, the rate their invoices print on the wastage line.
- Body (all optional; figures as numbers or numeric text):
  - `netWt`, `grossWt` (grams, 0-1,00,000). A net weight of 0 with a gross
    weight is worked out as gross less 0.2 g per stone carat (never below 0);
    the breakdown then says `netWeightEstimated: true` (low confidence).
  - `purityKarat`: "22K", "22KT", 22, or a fineness ("916", "958" = 23K);
    1K-24K. `customPurityPercent`: 0-100, 0 meaning not set.
  - `diamonds[]` `{ weight, rate, discountPercent (0-100), unit }`,
    `colorstones[]` `{ weight, rate, unit }`; `unit` "ct" (default) or "g"
    (grams, priced as 5 ct per gram).
  - `labourChargeAmount` with `labourChargeUnit` "Per Gram" | "Per 10 Gram" |
    "Percent" (a percent of the gold value; "12%" in the amount means the
    same). Text around a figure ("MC 850") is read as its first number;
    text with no number ("NIL") is no amount. Without an amount: the scan's
    Masters -> Labour Code row's `rate` in its `unit` (from rules 2; see
    `labourCode`), else the matched Masters item's labour in its
    `labourUnit` (from rules 2), else the shop's labour charge (AMOUNT per
    its unit, or PERCENTAGE of the gold value). `labourWeightBasis` "net" |
    "gross", default the basis the shop's labour charge was saved with.
  - `labourCode` (text, trimmed, first 20 characters; a number is read as
    text; anything else is a 400 "labourCode must be text"): the Masters ->
    Labour Code (3.5) picked on the card. The row is found in the caller's
    list (their own, else the shop's) by letters and digits only ("lb 01" is
    LB-01): the picked code first, then the item number and every
    `tagIdentifiers` entry (the one that named the Masters item first), as
    the wastage codes are; a picked code no longer saved gives way to the
    tag's. A labour amount sent beats the row's rate (as `wastagePercent`
    beats a wastage code's percent); a row without a rate prices nothing.
    Rules 1 looks no code up. No row: the labour is exactly as before.
  - `wastagePercent` (0-100), `otherCharges` (>= 0), `calculationMode`,
    `itemCode`, `tagIdentifiers[]`. The Masters item is found from them as
    the app does: exact, then ignoring case/punctuation, then the longest
    saved code (2+ characters) the tag number starts with, followed by
    digits (GR10286 is item GR).
  - `wastageWeightBasis`: "net" | "gross" (any case; blank or absent is
    net), the Wastage tile's Weight Used: the weight `wastagePercent` (or
    the matched item's wastage) is a share of. "gross" falls back to the net
    weight when there is no gross weight. Rules 3 prices by it; rules 1 and
    2 always use the net weight. Any other value is a 400 on every rules
    version.
- Wastage under rules 3: `wastagePercent / 100 x weight x current gold rate
  per gram`, where the current gold rate is the one the Gold tile shows: the
  selected 24K rate (cash or RTGS) per 10 g / 10 x the effective purity (the
  custom purity, else the karat's). 8% of 10 g of 22K (91.6%) at 1,50,000 a
  10 g is 0.8 g x 13,740 = 10,992. The amount is part of the MRP.
- Response `data`: `{ breakdown, finalMRP, finalMRPRounded }`; `finalMRPRounded`
  is the MRP to the rupee, commercial half-up (2,59,020.50 is 2,59,021).
  The breakdown's labour fields: `labourAmount`; `labourChargeType`
  (`AMOUNT_MANUAL` / `PERCENTAGE_MANUAL` the request's figure,
  `AMOUNT_CODE` / `PERCENTAGE_CODE` the labour code's rate, `*_ITEM`,
  `*_GLOBAL`, `NONE`); `labourCode`, the Masters -> Labour Code row found
  (picked, else matched from the tag), recorded even when a sent amount
  beat its rate; '' when none.
  The breakdown's wastage fields:
  - `wastagePercent`;
  - `wastageWeightBasis`: "net" | "gross", the weight actually used ("gross"
    only under rules 3, asked for, and with a gross weight);
  - `wastageWeightGrams`: that weight x the percent / 100, not rounded
    (8% of 8.765 g is 0.7012 g);
  - `wastageRatePerGram`: the rate a gram of wastage was priced at (rules 3:
    the current gold rate per gram; rules 1-2: the 24K rate per gram);
  - `wastageAmount`: `wastageWeightGrams x wastageRatePerGram`.
- The invoice's wastage line (4.1) bills `wastageWeightGrams`, printed to the
  milligram, at `wastageRatePerGram`, and its amount is the MRP's wastage in
  whole rupees. The rate prints where the printed grams at it come to that
  amount (0.8 g at 13,740); otherwise the line prints the price that does
  (0.7012 g, 9,634.49, billed as 0.701 g at 13,744.65 for 9,635). Printing
  the rate on grams rounded up, or the 24K rate on a rules-3 price, makes
  Qty x Price more than the amount, and the e-invoice registers a gap over a
  rupee as a discount (1,058 on 0.84 g at 15,000 billed as 11,542).
- Errors: 400 `INVALID_PRICING_INPUT` naming the field (wrong type, negative,
  out of range); 503 `RATES_UNAVAILABLE` when there is no live gold rate (no
  board MCX and no stored MCX). The analyze response carries the same as
  `pricingError` when it could not price the reading.


3. Rates & Pricing

All rate endpoints are under `/api/v1/rates` (router mounted at `/api/v1/rates`). All routes require authentication.

3.1 Gold
- GET /api/v1/rates/gold — list computed gold rates (uses caching via `redis.service`)
- POST /api/v1/rates/gold — update business gold rate rows (permission `editRateGold` required)
- PATCH /api/v1/rates/gold/visibility — toggle visibility (permission `editRateGold`)
  - Both answer 200 with the saved row; while live rates are unavailable it
    comes back without computed rates and with `ratesUnavailable: true`.
- GET /api/v1/rates/gold/tax-settings — fetch tax settings
- POST /api/v1/rates/gold/tax-settings — update tax settings (permission `editRateGold`)

3.2 Diamond
- GET /api/v1/rates/diamond — list diamond rates
- POST /api/v1/rates/diamond — add/update diamond rate (permission `editRateDiamond`)
- DELETE /api/v1/rates/diamond/:id — delete diamond rate

3.3 Colourstone
- GET /api/v1/rates/colorstone
- POST /api/v1/rates/colorstone (permission `editRateColorstone`)
- DELETE /api/v1/rates/colorstone/:id

3.4 Labour
- GET /api/v1/rates/labour — get labour settings
- POST /api/v1/rates/labour — upsert labour rate (permission `editRateLabour`)

3.5 Labour codes (Masters -> Labour Code), mounted at `/api/v1/labour-codes`
- Auth: JWT required (`authenticateJWT`), owner and employee alike; no
  further permission (as `/api/v1/wastage-codes`). Controller:
  `labourCodeController` ([backend/src/controllers/labourCode.controller.js]).
- Kept as the wastage codes are: each user reads their own list, else the
  shop's (the owner's rows, `userId: null`); an employee's first save or
  delete copies the whole shop list to them first, and changes only their
  copy. Collection `labour_codes`.
- A row: `{ _id, businessId, userId (null for the shop's), code, rate,
  unit, createdAt, updatedAt, __v }`. `code` uppercase, trimmed, inner
  spaces collapsed, 1-20 characters with at least one letter or digit,
  unique in its list by letters and digits alone (LB-01 = "lb 01" = LB01).
  `rate` a number >= 0, required on every save (a row kept from before that
  may hold null: no figure, the code prices nothing and the card does not
  offer it). `unit` "Per Gram" (default) | "Per 10 Gram" | "Percent" (of the
  gold value; `rate` then 0-100).
- GET /api/v1/labour-codes → `200 { success: true, data: [row, …] }`, A to Z
  by code.
- POST /api/v1/labour-codes `{ id?, code, rate, unit? }` → `200 { success:
  true, data: row }`. Without `id` it adds a code; with `id` (a row of the
  caller's list, or the shop row an employee is still reading) it edits that
  row, code included. `rate` as a number or text ("415", "₹ 1,250"); `unit`
  any case, "percentage" / "%" read as Percent. Errors `{ success: false,
  message }`: 400 "Labour code is required", "Labour code must stay within
  20 characters", 'Unit must be "Per Gram", "Per 10 Gram" or "Percent"',
  "Labour rate is required" (`rate` absent or blank), "Labour rate must be
  a number of rupees, 0 or more", "Labour must be a
  percentage between 0 and 100"; 404 "Labour code not found" (an id not of
  this shop); 409 "This labour code already exists" (another row of the list
  with the same letters and digits); 500 "Failed to save labour code".
- DELETE /api/v1/labour-codes/:id → `200 { success: true, message: 'Deleted
  successfully' }`, also for an id that is no row of the caller's list
  (nothing is deleted then).
- Priced by 2.9 (`labourCode`, and the tag's identifiers) and named by 2.4
  (`labourCode`).


4. Invoice generation

All invoice routes require JWT.

4.1 POST /api/v1/invoices/generate
- Controller: `invoiceController.generateInvoice`
- Description: Generate invoice PDF via `pdfmonkey.service.generateInvoicePdf`.
- `piece_count` (optional): how many pieces the invoice bills, a whole number
  from 1 to the number of line items; 1 when absent (the one scanned piece).
  Kept as `pieceCount`. Anything else → 400 before a number is spent.
- `pieces` (optional): a cart's pieces (Wishlist -> Add to cart -> Generate
  Invoice), one invoice for all of them:
  `[{ wishlist_item_id?, scan_id?, item_name, tag_code, mrp }]`, 1-50 of
  them and no more than the line items. `item_name` is required (text up to
  200 characters, as are the others); `mrp` an amount >= 0 (number or
  numeric text). With `pieces`, `pieceCount` is their number and a
  `piece_count` sent beside them must equal it. Every piece's lines are in
  `line_items`: the figures are worked out from the lines and checked
  against the client's totals exactly as without a cart; the pieces' MRPs
  are not added up. Kept on the invoice as `pieces: [{ itemName, tagCode,
  mrp, wishlistItemId, scanId }]` ('' for an id not sent). Anything wrong →
  400 naming the field (`pieces[1].mrp ...`) before a number is spent.
- POST /api/v1/invoices/preview-html checks `pieces` and `piece_count` the
  same way and refuses with the same 400.

4.2 GET /api/v1/invoices/preview/next-number
- Controller: `invoiceController.getNextInvoiceNumber`
- Description: Returns next invoice number preview.

4.3 GET /api/v1/invoices
- Controller: `invoiceController.getInvoices`
- Description: List invoices for a business (an employee's own), newest first,
  without `lineItems`. Each carries `pieceCount` (null on invoices issued
  before it was kept), `grandTotal` and `createdAt`. Checkout history reads
  8.5, which adds the cart's pieces and pages by cursor.

4.4 GET /api/v1/invoices/:id
- Controller: `invoiceController.getInvoice`
- Description: Fetch single invoice record.


5. Wishlist

All wishlist routes require JWT.

5.1 POST /api/v1/wishlist
- Controller: `wishlistController.addToWishlist`
- Also copies the item it adds into Wishlist history (8.3), before
  answering: one line per `itemId`, never removed by 5.3 / 5.4. Optional
  `scanId` (the scan it was priced from) and `itemName` only name that line;
  without `itemName` it is `snapshot.scanData.itemName`, else "<karat>
  <type>" ("22K Gold"). The wishlist item has no scan field of its own: the
  app keeps the scan in `snapshot.scanId` (stored with the snapshot), which
  the line also falls back to. A failed history write is logged, never the
  add's failure.

5.2 GET /api/v1/wishlist
- Controller: `wishlistController.getWishlist`

5.3 DELETE /api/v1/wishlist/:itemId
- Controller: `wishlistController.deleteWishlistItem`

5.4 DELETE /api/v1/wishlist
- Controller: `wishlistController.clearWishlist`


6. Settings and admin-only

6.1 GET/POST /api/v1/settings/formula
- Controller: `settingsController.getFormulaConfig` / `updateFormulaConfig`
- Permission: `manageFormulae` on POST

6.2 GET/POST /api/v1/settings/matrices
- Dashboard matrices settings, permission: `homeDashboardMetricsControls` on POST

6.3 Supreme rates
- GET /api/v1/settings/supreme-rates (role SUPER)
- PUT /api/v1/settings/supreme-rates (role SUPER)
  - With no stored MCX: `mcx`, `supremeRtgs`, `supremeCash` are null and
    `ratesUnavailable: true` (never Rs 1,60,000); the changes are saved and
    cached either way.


7. Employee management (OWNER only)

Every employee also has a sign-in record in `business_users` (role `EMP`,
`employeeId` linking back) holding their phone, the MPIN the owner sets (bcrypt
hash + sealed copy, `utils/mpinVault`), the shop's `gstNumber` / `businessName`
/ `address` copied from the owner's record, and a mirror of `permissions`. The
Employee document stays the source of truth; the record follows it on create,
edit, on/off, MPIN change and delete (`services/employeeAccount.service.js`).
Who holds a number decides what happens to it below
(`employeeAccount.service` `classifyPhone`, asked again on every write):
- the owner's own sign-in →
  `409 { success:false, error:'OWN_NUMBER', message:"You can't add your own number as an employee." }`;
- a `SUPER` record, or one of this shop's own employees →
  `409 { success:false, error:'PHONE_ALREADY_REGISTERED', message:'This number is already registered' }`;
- an `OWNER` record of another shop, a second `OWNER` of this shop, and/or
  another shop's employee → transferable: once the number is proved (token
  below) and the request carries `confirmTransfer:true` (the app showed the
  owner whose login moves), the add (7.1, MPIN path) or number change (7.4)
  moves it here. Without `confirmTransfer:true` (every build before that
  screen) →
  `409 { success:false, error:'TRANSFER_CONFIRMATION_REQUIRED', message, transfer:{ kind, sameShop } }`
  and nothing moves. The `business_users` record is copied whole into
  `released_logins` and deleted (its sessions end at the next refresh; its
  owner token stops working at once on 7.x and `DELETE /auth/account`);
  another shop's Employee still on the number is switched off
  (`isActive:false`) and its EMP record on the number archived the same way.
  Their business, invoices, scans, wallet, licence and every other collection
  are untouched; if any step or the write then fails, everything moved is put
  back. A record another request took first (two shops claiming one number at
  once) → `409 PHONE_ALREADY_REGISTERED`, nothing of this request's left
  moved or archived. Each move logs one `[EMPLOYEE_TRANSFER]` line (ids
  only), and each put-back one `[EMPLOYEE_TRANSFER] restored` /
  `could not restore` line with the entry's id.
  `node scripts/restore_released_login.js <releasedLoginId>` puts one back;
  refused, writing nothing, while the number (`PHONE_ALREADY_REGISTERED`) or
  the owner's Login ID (`USER_ID_TAKEN`) is someone else's, or once the
  employee's shop has deleted them (`EMPLOYEE_NOT_FOUND`), moved them to
  another number (`EMPLOYEE_NUMBER_CHANGED`) or given them a new sign-in
  record (`EMPLOYEE_HAS_LOGIN`).
Refused numbers write nothing. The older draft/password path (7.1) never
moves anyone: any number held by anyone is `409 PHONE_ALREADY_REGISTERED`
there.

An OWNER token on 7.x and on 1.16/1.17 (deleting one's own account) counts only while its
`business_users` record is still that shop's (not EMP, not switched off);
otherwise `401 UNAUTHORIZED`, as the next refresh would answer.

An employee's number is proved by OTP before it is written: adding someone,
and moving an employee to a new number, carry the `phoneVerificationToken`
from 7.3b for that shop and that number. Missing, expired, or for another
number or shop → `403 { success:false, error:'EMPLOYEE_PHONE_NOT_VERIFIED', message }`
(the message tells builds without the OTP step to update) and nothing is written.

7.1 POST /api/v1/employees (OWNER)
- Body: `{ name, phone, email?, designation, mpin, confirmMpin, permissions?, phoneVerificationToken, confirmTransfer? }` → `201 { success:true, data:{ employee } }`.
- Older builds: no mpin/password stores the 1-hour Redis draft (no token needed); `{ password }` finishes it (body fields win over the draft) and needs the token like the MPIN path.
7.2 GET /api/v1/employees
- OWNER: the roster; EMP: only themselves. Each item adds `hasMpin`; never a hash.
7.3 GET /api/v1/employees/check-phone?phone= (OWNER) → `{ available:true }` free; `{ available:true, transfer:{ kind:'owner'|'employee', sameShop } }` transferable (`owner` when both); `{ available:false, reason:'OWN_NUMBER' }`; otherwise `{ available:false }`. Moves nothing.
7.3a POST /api/v1/employees/phone-otp (OWNER) `{ phone, employeeId? }` → `{ phone, expiresInSeconds:600, resendAfterSeconds:30, transfer? }`
- Texts a 6-digit code (MSG91, flow `EMPLOYEE_PHONE`, stored against the owner's business). The employee limit is checked first (`403 TRIAL_REQUIRED_FOR_MORE_EMPLOYEES`); a transferable number is texted and the answer carries `transfer` as 7.3 does; own number → `409 OWN_NUMBER`, a SUPER's or this shop's employee's → `409 PHONE_ALREADY_REGISTERED`, nothing sent; MSG91 failing → `502 OTP_SEND_FAILED`; 10 sends an hour per number for each shop → `429`.
7.3b POST /api/v1/employees/phone-otp/verify (OWNER) `{ phone, otp }` → `{ phoneVerificationToken, expiresInSeconds:1800 }`
- Only the latest code this shop sent to the number counts, once. `400` with `OTP_INVALID` | `OTP_EXPIRED` | `OTP_NOT_FOUND` | `OTP_ALREADY_USED`; 15 checks an hour per number for each shop → `429`.
7.4 PUT /api/v1/employees/:id (OWNER)
- `{ name?, phone?, email?, designation?, permissions?, isActive?, phoneVerificationToken?, confirmTransfer? }`; a new phone needs the token for the new number, and is re-checked excluding the employee, and so is the current one when `isActive:true` switches a switched-off employee back on (a switched-off employee holds no number). A new number is classified as above (transferable with `confirmTransfer:true` → moved here; without it → `409 TRANSFER_CONFIRMATION_REQUIRED`); taken → `409 PHONE_ALREADY_REGISTERED` (own number → `409 OWN_NUMBER`), nothing written. Switching back on never moves anyone. The same number, however written (an old record's `0XXXXXXXXXX` included), needs no token.
7.5 PUT /api/v1/employees/:id/mpin (OWNER) `{ mpin, confirmMpin }` → `{ success:true }`
7.6 GET /api/v1/employees/:id/mpin (OWNER) → `{ mpin: '1234' | null }` from the sealed copy
7.7 DELETE /api/v1/employees/:id (OWNER) — also deletes the sign-in record.

Employees sign in through POST /api/v1/auth/login `{ mobile, mpin }` like the
owner: role `EMP`, `userId` = the Employee id, `permissions` in the payload and
token. No MPIN yet → `409 EMPLOYEE_MPIN_NOT_SET`; switched off →
`403 EMPLOYEE_INACTIVE` (after a correct MPIN). OTP-only login and the owner's
forgot/set-MPIN flows refuse an employee's number (`EMPLOYEE_MPIN_REQUIRED`,
`EMPLOYEE_MPIN_MANAGED_BY_OWNER`). Sign-in attempts are counted 20 an hour per
account, keyed exactly as the login reads `mobile`: anything holding ten or
more digits is the number its last ten spell, however it is decorated.
The shop's GST details in either login's payload are the business record's
current ones; a user record whose copy fell behind is healed on that login.


8. History (Settings -> History)

All routes: JWT required, owner and employee alike. The owner sees the
shop's lines, an employee their own (as GET /invoices); a line the session
may not see answers 404, as one that does not exist.

Lists are newest first and paged by cursor: `?limit=` 1-100 (default 30)
and `?before=<nextCursor of the previous page>`. Each answers
`{ items, nextCursor }`; `nextCursor` is an opaque string, null on the last
page. A cursor this server did not hand out →
`400 { success:false, error:'INVALID_CURSOR', message }`. The order is
`createdAt` then `_id`, both descending, so lines added while the list is
open never repeat or skip one; every list runs on an index of its own scope
plus `{ createdAt: -1, _id: -1 }`.

8.1 GET /api/v1/history/scans?limit=30&before=
- Controller: `historyController.getScanHistory`
- `items: [{ id, scanId, itemName, tagCode, finalMRP, status, createdAt }]`.
- One line per scan in `scan_history`, started by 2.4 when the tag is read
  (`status: 'read'`, `finalMRP` the reading's price or null) and updated by
  every price 2.9 returns (`status: 'priced'`, the latest request's price).
  `createdAt` is when the tag was read. `itemName` is the Masters item's name
  when the tag matched one, else the karat and type ("22K Gold", "18K
  Diamond Jewellery"); `tagCode` the item number the card shows, or ''.
  Lines written before readings were kept have no status and answer
  `'priced'`. Lines expire 180 days after the scan.

8.2 GET /api/v1/history/scans/:scanId
- Controller: `historyController.getScanHistoryItem`
- `{ item: { id, scanId, itemName, tagCode, finalMRP, status, createdAt,
  updatedAt, details, pricing } }`; 404 `NOT_FOUND` when not visible.
- `details` (null on lines from before readings were kept): everything read,
  each field the reader's text without its confidence ('' when not printed):
  `{ jewelleryType, grossWeight, netWeight, karat, purity, serialNumber,
  itemCode (the Masters item matched, or ''), packetCode, tagIdentifiers[],
  diamonds: [{ weight, unit, pieces, shape, quality, color, clarity, rate,
  packetCode }], colorstones: [{ type, weight, unit, pieces, shape, quality,
  color, clarity, rate, packetCode }], labour, wastage, otherCharges,
  rawText }`.
- `pricing` (null until 2.9 prices it): `{ inputs, breakdown, rules }`.
  `inputs` is the card's request as read, named as 2.9's body: `{
  jewelleryType, grossWt, netWt, purityKarat, customPurityPercent,
  calculationMode (the mode priced in: cash | rtgs), diamonds[{ weight, rate,
  discountPercent, unit }], colorstones[{ weight, rate, unit }],
  labourChargeAmount, labourChargeUnit, labourWeightBasis, labourCode (the
  code picked on the card, '' when none), wastagePercent,
  wastageWeightBasis, otherCharges, itemCode, tagIdentifiers }` (null where
  not sent). `breakdown` is 2.9's breakdown (goldRateApplied, pureWeight,
  goldAmount, diamondAmount, colorstoneAmount, labourAmount,
  labourChargeType, labourCode, wastagePercent, wastageCode, wastageWeightBasis,
  wastageWeightGrams, wastageRatePerGram, wastageAmount, otherCharges,
  subtotal, netWeightUsed, netWeightEstimated) plus `goldRatePer10g`,
  `effectivePurityPercent`, `purityAdjustedGoldRatePerGram`,
  `diamondLineItems[{ index, weight, rate, discountPercent, amount }]`,
  `colorstoneLineItems[{ index, weight, rate, amount }]`, `labourRate`,
  `labourUnit`, `labourWeightBasis`, `finalMRP`, `finalMRPRounded`. `rules`
  is the X-Pricing-Rules it was priced by.

8.3 GET /api/v1/history/wishlist?limit=30&before=
- Controller: `historyController.getWishlistHistory`
- `items: [{ id, itemName, tagCode, mrp, createdAt }]`: every item ever
  added by 5.1 (`wishlist_history`), kept after it leaves the wishlist;
  expires 180 days after it was added.

8.4 GET /api/v1/history/wishlist/:id
- Controller: `historyController.getWishlistHistoryItem`
- `{ item: { id, wishlistItemId, scanId (or null), itemName, tagCode, mrp,
  title, priceBadge, calculationRate, scanTimestamp, createdAt, snapshot } }`;
  `snapshot` is the wishlist item's as it was added. 404 when not visible.

8.5 GET /api/v1/history/checkouts?limit=30&before=
- Controller: `historyController.getCheckoutHistory`
- `items: [{ id (the invoice id), invoiceNumber, pieceCount, pieces: [{
  itemName, tagCode, mrp }], grandTotal, createdAt }]`: only the invoices
  generated from the Wishlist cart (4.1 `pieces`; stored with
  `fromCart: true`). An invoice billed straight from a scan's card, or
  issued before carts, is not listed.

8.6 GET /api/v1/history/checkouts/:id
- Controller: `historyController.getCheckoutHistoryItem`
- `{ item: { id, invoiceNumber, invoiceDate, pieceCount, pieces: [{ itemName,
  tagCode, mrp, wishlistItemId, scanId }], grandTotal, customerName,
  invoiceUrl, createdAt } }`; the ids are null where the cart did not send
  them, `invoiceUrl` (as 4.4's) null on an invoice without one. A piece's
  `scanId` opens 8.2. 404 when not visible.


Notes & file references
- Routes live in `backend/src/routes/*.js` (see each file for mounting path). Controllers in `backend/src/controllers/*` and services in `backend/src/services/*`.
- Authentication: `backend/src/middleware/auth.middleware.js` provides `authenticateJWT`, `authenticateJWTOptional`, `requireRole`.
- Validation: `backend/src/middleware/validation.middleware.js` and route-level schemas in `backend/src/routes/*`.


"REST_APIS.md" generated automatically — for deeper request/response bodies and examples, see `FUNCTIONAL_ENDPOINTS.md`.
