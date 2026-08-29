Backend Services Inventory

This document summarizes all major backend services, their responsibilities, key functions, integrations and file locations.

1. `redis.service` — Cache & Scan state store
- File: `backend/src/services/redis.service.js`
- Responsibilities:
  - Persist scan sessions and their transient state (`setScan`, `getScan`, `updateScanStatus`).
  - Cache gold rates, MCX data, supreme rates and prompt customizations.
  - In-memory fallback when Redis unavailable (development friendly).
- Key functions: `setScan`, `getScan`, `updateScanStatus`, `getGoldRatesCache`, `setGoldRatesCache`, `getPromptCustomizations`, `addPromptCustomization`.
- Notes: Uses TTL of 24 hours for most caches.

2. `scan.service` — Scan lifecycle & analysis orchestration
- File: `backend/src/services/scan.service.js`
- Responsibilities:
  - Create scan sessions and keep state in Redis.
  - Save uploaded images and update statuses.
  - Invoke AI services (`openai.service` / `gemini.service`) for image analysis.
  - Prepare clarification payloads and apply user mappings.
  - Provide review-ready structured data and submit final review.
- Key functions: `createScan`, `saveImage`, `analyzeScan`, `getClarification`, `submitClarification`, `getReviewData`, `submitReview`.

3. `openai.service` — OpenAI Chat/Image analysis wrapper
- File: `backend/src/services/openai.service.js`
- Responsibilities:
  - Prepare system/user prompts from `prompts/openai.prompt.js`.
  - Resize/compress images using `sharp`, send as base64.
  - Call OpenAI Chat Completions and parse structured JSON.
  - Merge prompt customizations and diamond/colorstone catalogs from DB.
- Notes: Logs token usage and performs some backward-compat transformations for frontend.

4. `gemini.service` — Google Gemini vision wrapper
- File: `backend/src/services/gemini.service.js`
- Responsibilities:
  - Similar to `openai.service` but uses Google's GenAI client and retry/backoff for transient errors.
  - Converts images into the required inline/base64 parts and calls model `gemini-2.5-flash-lite`.
- Notes: Implements retry with exponential backoff for 429 / 503.

5. `auth.service` — JWT token utilities
- File: `backend/src/services/auth.service.js`
- Responsibilities: Generate access & refresh tokens, verify tokens, refresh token workflow.
- Key functions: `generateTokens`, `verifyAccessToken`, `verifyRefreshToken`, `refreshTokens`.

6. `rateCalculation.service` — Live gold/karat rate computations
- File: `backend/src/services/rateCalculation.service.js`
- Responsibilities:
  - Compose final gold rates using MCX live rate, Supreme global adjustments and business tax settings.
  - Ensure karat rows exist and compute final amounts for different calculation modes (rtgs/cash).
  - Cache the composed result in Redis for 24h.
- Key dependencies: `mcx.service`, `redis.service`, `GoldRate` model.

7. `mcx.service` + `mcxScheduler.service`
- Files: `backend/src/services/mcx.service.js`, `backend/src/services/mcxScheduler.service.js`
- Responsibilities:
  - `mcxScheduler` fetches market rates periodically and stores them in Redis via `redis.service.setMcxCache`.
  - `mcx.service` reads cached MCX rate; returns fallback when cache missing.

8. `pdfmonkey.service` — Invoice PDF generation
- File: `backend/src/services/pdfmonkey.service.js`
- Responsibilities:
  - Wraps PDFMonkey sync API to generate invoice PDFs using a template ID.
  - Returns a download URL after synchronous generation.

9. `otp.service` / `registration.service`
- Files: `backend/src/services/otp.service.js`, `backend/src/services/registration.service.js`
- Responsibilities:
  - OTP generation/verification flow used during onboarding.
  - Registration flow that may create business and owner accounts.

10. `gst.service` — GST validation helper
- File: `backend/src/services/gst.service.js`
- Responsibilities: Interact with GST verification APIs and format results for onboarding endpoints.

11. `promptCustomization.service` (via redis)
- File: `backend/src/services/promptCustomization.service.js` (if exists) or handled inside `redis.service` helper functions
- Responsibilities: Manage prompt customization lists (color, clarity, shapes) per business to improve AI mapping accuracy.

12. `auth.service` & `rbac` integration
- `auth.service` is used by middlewares in `backend/src/middleware/auth.middleware.js` and `rbac.middleware.js` to enforce role/permission checks.


How to find code
- Service implementations are in `backend/src/services/*.js`.
- Controllers call services (see `backend/src/controllers/*.js`).
- Database models are under `backend/src/models/*.model.js`.

This file is a compact map — for usage examples and endpoint-level request/response shapes see `FUNCTIONAL_ENDPOINTS.md` and `REST_APIS.md`.
