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
- Description: Texts a 6-digit code (flow `ACCOUNT_DELETE`, under the caller's shop) to the caller's own phone: an owner's (or SUPER's) `business_users` phone, an employee's EMP record phone (else their Employee phone). Never answers with the code. MSG91 failing → `502 OTP_SEND_FAILED`; a login gone or switched off since → `401 UNAUTHORIZED`.

1.17 DELETE /api/v1/auth/account
- Auth: JWT required, any role (`authenticateJWT`, `requireCurrentOwner`); 15 an hour per account (`accountDeleteLimiter`)
- Body: `{ otp:'123456', confirm:'DELETE' }` → `200 { success:true, message:'Your account has been deleted.' }`
- Description: Deletes the caller's own account and nothing else (`services/accountRelease.service.js`). `confirm` must be exactly `DELETE` (`400 CONFIRMATION_REQUIRED`), and `otp` the latest unexpired, unused code 1.16 sent for this caller's phone and shop (`400 OTP_INVALID` / `OTP_EXPIRED` / `OTP_NOT_FOUND` / `OTP_ALREADY_USED`); nothing is written on a refusal. The caller's `business_users` record is archived whole in `released_logins` (reason `ACCOUNT_DELETED`, one `[ACCOUNT_DELETED]` log line, ids only) and taken out of `business_users`; an employee's Employee record is also switched off (`isActive:false`, recorded in the entry). Their sessions end: an owner's token at once on routes behind `requireCurrentOwner`, every refresh at once. The business, invoices, scans, wallet and credits, payments, licence, subscription, and the shop's other owners and employees are never touched. `node scripts/restore_released_login.js <releasedLoginId>` puts the login back (and the employee back on).


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
- Header `X-Pricing-Rules`: `3` from the app build whose Wastage tile chooses
  the weight: everything in rules 2, and wastage priced at the current gold
  rate on the net or the gross weight (`wastageWeightBasis`, below). `2` from
  the app from 1.0.367 (prefix item match, item wastage and labour, stone
  units, percent labour). A number above 3 is priced by rules 3. No header,
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
    text with no number ("NIL") is no amount. Without an amount: the matched
    Masters item's labour in its `labourUnit` (from rules 2), else the
    shop's labour charge (AMOUNT per its unit, or PERCENTAGE of the gold
    value). `labourWeightBasis` "net" | "gross", default the basis the
    shop's labour charge was saved with.
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


4. Invoice generation

All invoice routes require JWT.

4.1 POST /api/v1/invoices/generate
- Controller: `invoiceController.generateInvoice`
- Description: Generate invoice PDF via `pdfmonkey.service.generateInvoicePdf`.

4.2 GET /api/v1/invoices/preview/next-number
- Controller: `invoiceController.getNextInvoiceNumber`
- Description: Returns next invoice number preview.

4.3 GET /api/v1/invoices
- Controller: `invoiceController.getInvoices`
- Description: List invoices for a business.

4.4 GET /api/v1/invoices/:id
- Controller: `invoiceController.getInvoice`
- Description: Fetch single invoice record.


5. Wishlist

All wishlist routes require JWT.

5.1 POST /api/v1/wishlist
- Controller: `wishlistController.addToWishlist`

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


Notes & file references
- Routes live in `backend/src/routes/*.js` (see each file for mounting path). Controllers in `backend/src/controllers/*` and services in `backend/src/services/*`.
- Authentication: `backend/src/middleware/auth.middleware.js` provides `authenticateJWT`, `authenticateJWTOptional`, `requireRole`.
- Validation: `backend/src/middleware/validation.middleware.js` and route-level schemas in `backend/src/routes/*`.


"REST_APIS.md" generated automatically — for deeper request/response bodies and examples, see `FUNCTIONAL_ENDPOINTS.md`.
