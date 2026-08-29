Functional Endpoints — Deep reference

This file documents functional details: request payloads, response shapes, validation rules, success/error cases, and how each route is implemented across controller → service → model.

1. Authentication & Onboarding Endpoints

1.1 POST /api/v1/business/gst/verify
- Validation: `gstVerifySchema` (see `backend/src/validators/auth.validator.js`)
- Request body (example):
  {
    "gstNumber": "27AAECS1234P1ZV"
  }
- Success response: { success: true, data: { gstName, address, status } }
- Typical failures: validation error (400), external GST API error (502), rate-limited (429 via `gstRateLimiter`).

1.2 POST /api/v1/business/gst/confirm
- Request body: includes GST confirmation payload returned by `/verify`.
- On success: business onboarding partial state saved; OTPs may be sent.

1.3 POST /api/v1/business/contact-details
- Request body: owner contact, business details. Validated by `contactDetailsSchema`.
- Controller stores details and returns next-steps.

1.4 POST /api/v1/business/create-password
- Request body: password details. On success creates business user password (owner) and issues tokens in `authController`.

1.5 POST /api/v1/business/login
- Request body: `{ username, password }` validated by `loginSchema`.
- On success: controller uses `auth.service.generateTokens` and returns `{ accessToken, refreshToken }`.
- Error cases: invalid credentials (401)

1.6 POST /api/v1/refresh
- Request body or cookie contains refresh token.
- Controller uses `auth.service.refreshTokens` to return new pair.


2. Scanning Flow (Detailed)

2.1 POST /api/v1/scans
- Payload example:
  {
    "jewelleryType": "DIAMOND",
    "scanType": "SINGLE_SIDE"
  }
- Response: `{ scanId, status: 'WAITING_FOR_SCAN' }`.
- Implementation: `scanController.createScan` calls `scan.service.createScan` which stores session into Redis.

2.2 POST /api/v1/scans/:scanId/front-image
- Multipart form-data with `image` field.
- Controller `scanController.uploadFrontImage` stores file to disk (via `upload.middleware`) and calls `scan.service.saveImage`.
- Response: status with scan status e.g. `FRONT_IMAGE_RECEIVED`.

2.3 POST /api/v1/scans/:scanId/analyze
- No body. Controller triggers `scan.service.analyzeScan` which:
  - Reads scan state from Redis (front/back image paths)
  - Calls configured AI service (`openai.service.analyzeImages` or `gemini.service.analyzeImages`)
  - Stores `analysisResult` in Redis and updates status to `ANALYSIS_COMPLETED`.
- AI result shape (example simplified):
  {
    structuredData: {
      grossWeight: { value: '42.50', confidence: 98 },
      diamondWeight: { value: '1.25', confidence: 85 },
      diamonds: [{ weight: '1.25', rate: '120000', quality: 'VVS' }]
    },
    unknownFields: [{ abbreviation: 'GRT', detectedValue: '42.5', confidence: 60 }]
  }

2.4 GET /api/v1/scans/:scanId/clarification
- Returns `fieldsNeedingReview` created by `scan.service.getClarification`.
- Each clarification item:
  {
    abbreviation: 'GRT',
    detectedValue: '42',
    suggestedField: 'grossWeight',
    confidence: 45,
    availableFields: [ 'grossWeight', 'netWeight', ... ]
  }

2.5 POST /api/v1/scans/:scanId/clarification
- Body: `{ confirmedMappings: [{ abbreviation, mappedField, description? }] }`.
- Handler: `scan.service.submitClarification` applies mappings to `analysisResult` (overwrites structuredData with high confidence for mapped fields) and sets scan status `CLARIFICATION_COMPLETED`.

2.6 GET /api/v1/scans/:scanId/review
- Returns `structuredData` normalized for frontend (strings where appropriate) and a `status: READY_FOR_REVIEW`.
- Implementation: `scan.service.getReviewData` ensures `karat` resolution and defaulting (18K fallback) and populates `finalData` in Redis.

2.7 POST /api/v1/scans/:scanId/review
- Body: final structured JSON created client-side (scanner review payload).
- Handler: `scan.service.submitReview` stores `finalData` and sets status `APPROVED`.

2.8 POST /api/v1/scans/:scanId/calculate
- Auth required.
- Payload: `CalculateMrpPayload` (see `frontend/types/scanner.ts` for example structure) with diamonds/colorstones arrays.
- Implementation: `calculation.controller.calculateMRP` uses `rateCalculation.service.getLiveGoldRates` plus provided data to compute final MRP and breakdown.


3. Rates Endpoints (Detailed behavior)

3.1 GET /api/v1/rates/gold
- Returns computed gold rates using `rateCalculation.service.getLiveGoldRates`.
- Response keys: `mcxLiveRate`, `taxSettings`, `karatRates` (array), `supremeChanges`.

3.2 POST /api/v1/rates/gold
- Body: gold rate rows or update instructions.
- Authorization: permission `editRateGold` enforced by `rbac.middleware.requirePermission`.

3.3 Diamond / Colorstone / Labour endpoints
- Standard CRUD for rate rows. Permission checks in place.


4. Invoice endpoints (detailed)

4.1 POST /api/v1/invoices/generate
- Auth required.
- Body: invoice payload matching template fields expected by PDFMonkey template.
- Implementation: `invoiceController.generateInvoice` calls `pdfmonkey.service.generateInvoicePdf(payload, filename)` and returns `{ downloadUrl, docId }`.
- Error cases: PDFMonkey API errors are forwarded as 502/500.


5. Wishlist endpoints (detailed)

- `addToWishlist`: accepts item payload (includes `structuredData`, `scanData`, pricing) and persists in `Wishlist` model.
- `getWishlist`: query by `businessId` returns list.
- `deleteWishlistItem` / `clearWishlist`: deletion endpoints.


6. Error Handling & Middlewares

- `validation.middleware` sends 400 with details on Joi validation errors.
- `auth.middleware` enforces JWT and roles. `authenticateJWTOptional` will attach user context if token present.
- `rbac.middleware` enforces business-level permission checks.
- `errorHandler` centralizes error responses (see `backend/src/middleware/errorHandler.js`).


7. Models referenced frequently
- `GoldRate`, `DiamondRate`, `ColorstoneRate`, `LabourRate`, `Invoice` and `Wishlist` models store persistent data in MongoDB. See `backend/src/models/*.model.js`.


8. Examples

Create Scan + Upload + Analyze sequence (client flow):
- POST /api/v1/scans -> { scanId }
- POST /api/v1/scans/:scanId/front-image -> upload file
- POST /api/v1/scans/:scanId/back-image -> upload file (optional)
- POST /api/v1/scans/:scanId/analyze -> triggers AI; poll or call GET /api/v1/scans/:scanId/clarification until ready
- GET /api/v1/scans/:scanId/review -> fetch final structured data for UI
- POST /api/v1/scans/:scanId/review -> submit final review


Where to read code
- Routes: `backend/src/routes` (mapping to controllers)
- Controllers: `backend/src/controllers/*` (parse requests, call services)
- Services: `backend/src/services/*` (core business logic & external integrations)
- Models: `backend/src/models/*` (Mongoose models)
- Middlewares: `backend/src/middleware/*` (auth, validation, uploads, errors)


If you want, I can now:
- Add example request/response payload files (JSON) to `backend/docs/examples/` for each important endpoint.
- Generate OpenAPI (Swagger) spec skeleton from the routes/controllers.

