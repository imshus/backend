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
- Middleware: `validate(employeeLoginSchema)`
- Controller: `authController.loginEmployee`

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


3. Rates & Pricing

All rate endpoints are under `/api/v1/rates` (router mounted at `/api/v1/rates`). All routes require authentication.

3.1 Gold
- GET /api/v1/rates/gold — list computed gold rates (uses caching via `redis.service`)
- POST /api/v1/rates/gold — update business gold rate rows (permission `editRateGold` required)
- PATCH /api/v1/rates/gold/visibility — toggle visibility (permission `editRateGold`)
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


7. Employee management (OWNER only)

7.1 POST /api/v1/employees
- Controller: `employeeController.createEmployee` (OWNER)
7.2 GET /api/v1/employees
- Controller: `employeeController.getEmployees` (OWNER)
7.3 PUT /api/v1/employees/:id
- Controller: `employeeController.updateEmployee` (OWNER)
7.4 DELETE /api/v1/employees/:id
- Controller: `employeeController.deleteEmployee` (OWNER)


Notes & file references
- Routes live in `backend/src/routes/*.js` (see each file for mounting path). Controllers in `backend/src/controllers/*` and services in `backend/src/services/*`.
- Authentication: `backend/src/middleware/auth.middleware.js` provides `authenticateJWT`, `authenticateJWTOptional`, `requireRole`.
- Validation: `backend/src/middleware/validation.middleware.js` and route-level schemas in `backend/src/routes/*`.


"REST_APIS.md" generated automatically — for deeper request/response bodies and examples, see `FUNCTIONAL_ENDPOINTS.md`.
