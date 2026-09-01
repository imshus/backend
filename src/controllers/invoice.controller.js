const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Liquid } = require('liquidjs');
const QRCode = require('qrcode');
const Invoice = require('../models/invoice.model');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const Employee = require('../models/employee.model');
const { generateInvoiceNumber, peekNextInvoiceNumber } = require('../models/invoiceCounter.model');
const { generateInvoicePdf, getDownloadUrl } = require('../services/pdfmonkey.service');
const redisService = require('../services/redis.service');
const config = require('../config/env');
const { sendSuccess, sendError } = require('../utils/apiResponse');

const MAX_INVOICE_PDF_BYTES = config.invoicePdfCache?.maxBytes || (15 * 1024 * 1024);

const isDownloadRequest = (query) => ['1', 'true', 'yes'].includes(
  String(query?.download || '').toLowerCase(),
);

const safeInvoiceFilename = (invoiceNumber) => {
  const safeName = String(invoiceNumber || 'invoice').replace(/[^\w.-]+/g, '-');
  return `${safeName || 'invoice'}.pdf`;
};

const sendInvoicePdf = (res, invoiceNumber, pdfBuffer, query) => {
  const asDownload = isDownloadRequest(query);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${asDownload ? 'attachment' : 'inline'}; filename="${safeInvoiceFilename(invoiceNumber)}"`,
  );
  res.setHeader('Content-Length', String(pdfBuffer.length));
  // The token is the credential, so shared proxies must never retain a copy.
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.end(pdfBuffer);
};

/** Downloads and validates a generated invoice before it enters Redis. */
const fetchInvoicePdf = async (downloadUrl) => {
  const upstream = await fetch(downloadUrl);
  if (!upstream.ok) {
    throw new Error(`PDF fetch failed with ${upstream.status}`);
  }

  const declaredLength = Number(upstream.headers?.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INVOICE_PDF_BYTES) {
    throw new Error('Invoice PDF is larger than the configured cache limit');
  }

  const pdfBuffer = Buffer.from(await upstream.arrayBuffer());
  if (!pdfBuffer.length || pdfBuffer.length > MAX_INVOICE_PDF_BYTES) {
    throw new Error('Invoice PDF is empty or larger than the configured cache limit');
  }
  if (pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Invoice provider returned a non-PDF response');
  }

  return pdfBuffer;
};

/**
 * Resolves the single quantity + unit pair a line prints.
 *
 * A jewellery line is quoted either by metal weight in grams or by stone
 * weight in carats. The app sends the number in `qty` with its unit in
 * `qty_unit`; the explicit `net_weight` / `diamond_weight` keys are also
 * honoured for callers that separate them.
 */
const resolveQuantity = (item) => {
  const diamond = Number(item.diamond_weight) || 0;
  const net = Number(item.net_weight) || 0;
  const qty = Number(item.qty) || 0;

  if (diamond > 0) return { value: diamond, unit: item.qty_unit || 'CT' };
  if (net > 0) return { value: net, unit: item.qty_unit || 'Gms.' };
  return { value: qty, unit: item.qty_unit || '' };
};

/** True when a unit label denotes grams, in any of the spellings we accept. */
const isGramUnit = (unit) => /^(g|gm|gms|gram|grams)\.?$/i.test(String(unit || '').trim());

/** GST state codes, used to classify a supply when the buyer has no GSTIN. */
const STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04',
  uttarakhand: '05', haryana: '06', delhi: '07', 'new delhi': '07', rajasthan: '08',
  'uttar pradesh': '09', bihar: '10', sikkim: '11', 'arunachal pradesh': '12',
  nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17',
  assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21', orissa: '21',
  chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24', 'dadra and nagar haveli and daman and diu': '26',
  maharashtra: '27', karnataka: '29', goa: '30', lakshadweep: '31', kerala: '32',
  'tamil nadu': '33', puducherry: '34', 'andaman and nicobar islands': '35',
  telangana: '36', 'andhra pradesh': '37', ladakh: '38', 'other territory': '97',
};

/**
 * Determines the customer's state code for the IGST-vs-CGST/SGST decision.
 *
 * A registered buyer's GSTIN carries it in the first two digits. An
 * unregistered walk-in has none, so it comes from the place of supply — which
 * is free text. Accepting only the bracketed "(07)" form meant a counter sale
 * typed as "Delhi" was billed IGST instead of CGST+SGST, sending the tax to the
 * wrong heads on both sides' returns.
 */
const resolveStateCode = (customerGstin, placeOfSupply) => {
  const fromGstin = String(customerGstin || '').trim().slice(0, 2);
  if (/^\d{2}$/.test(fromGstin)) return fromGstin;

  const place = String(placeOfSupply || '').trim();

  // "Uttar Pradesh (09)" — an explicit code always wins.
  const bracketed = place.match(/\((\d{2})\)/);
  if (bracketed) return bracketed[1];

  // Otherwise match the state name, ignoring any trailing pincode or punctuation.
  const name = place
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-zA-Z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (STATE_CODES[name]) return STATE_CODES[name];

  // Fall back to a contained state name, e.g. "Karol Bagh, New Delhi".
  const matches = Object.keys(STATE_CODES).filter((state) => name.includes(state));
  if (matches.length) {
    // Prefer the longest match so "new delhi" beats "delhi".
    const best = matches.sort((a, b) => b.length - a.length)[0];
    return STATE_CODES[best];
  }

  return '';
};

/**
 * Formats a number the way an Indian tax invoice prints it: two decimals and
 * lakh/crore digit grouping, e.g. 350650 -> "3,50,650.00".
 */
const formatInr = (value) => {
  const amount = Number(value) || 0;
  const [whole, decimals] = Math.abs(amount).toFixed(2).split('.');
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);

  // Everything above the last three digits is grouped in pairs, so
  // 12345678 prints as 1,23,45,678 rather than 12,345,678.
  let grouped = '';
  while (rest.length > 2) {
    grouped = ',' + rest.slice(-2) + grouped;
    rest = rest.slice(0, -2);
  }
  grouped = rest + grouped;

  const digits = grouped ? grouped + ',' + last3 : last3;
  return (amount < 0 ? '-' : '') + digits + '.' + decimals;
};

/**
 * Adds the durable invoice URL to a record on its way out.
 *
 * The stored pdfUrl is a signed PDFMonkey link that expires within hours, so
 * the app must not rely on it when reopening an older invoice. Invoices created
 * before public tokens existed have none, and simply get no invoiceUrl.
 *
 * publicToken is stripped: the URL already carries it, and the raw token is the
 * credential.
 */
const withInvoiceUrl = (invoice) => {
  const { publicToken, ...rest } = invoice;
  return {
    ...rest,
    invoiceUrl: publicToken
      ? `${config.publicBaseUrl}/api/v1/invoices/p/${publicToken}`
      : null,
  };
};

const resolveBusinessIdFromUser = async (user) => {
  if (!user) return null;
  if (user.businessId) return String(user.businessId);

  if (!user.userId) return null;

  if (String(user.role || '').toUpperCase() === 'EMP') {
    const employee = await Employee.findById(user.userId).select('businessId').lean();
    return employee?.businessId ? String(employee.businessId) : null;
  }

  const owner = await BusinessUser.findById(user.userId).select('businessId').lean();
  return owner?.businessId ? String(owner.businessId) : null;
};

/**
 * POST /api/v1/invoices/generate
 *
 * Body (from React Native):
 * {
 *   customer_name, customer_address, customer_phone,
 *   customer_email, customer_gstin,
 *   customer_pan, reverse_charge,
 *   gr_rr_number, vehicle_number, station,
 *   shipped_to_name, shipped_to_address, shipped_to_gstin,
 *   irn, ack_number, ack_date, qr_code_data,
 *   place_of_supply, transport,
 *   line_items: [{ description, note, qty, price, amount }],
 *   subtotal, gst_rate, gst_amount, grand_total,
 *   amount_in_words, terms_and_conditions
 * }
 *
 * Company fields (company_name, company_address, gstin_number) are
 * sourced from the authenticated business profile — not trusted from client.
 */
/**
 * Builds the payload the invoice template renders.
 *
 * Shared by generation and preview so the two cannot drift: the preview
 * shows the same document the PDF is made from, rather than a lookalike
 * maintained separately.
 */
const buildInvoicePayload = (body, context) => {
  const {
    customer_name = '',
    customer_address = '',
    customer_phone = '',
    customer_email = '',
    customer_gstin = '',
    place_of_supply = '',
    transport = '',
    line_items = [],
    subtotal = 0,
    gst_rate = 18,
    gst_amount = 0,
    grand_total = 0,
    amount_in_words = '',
    terms_and_conditions = '',
    customer_pan = '',
    reverse_charge = 'N',
    gr_rr_number = '',
    vehicle_number = '',
    station = '',
    shipped_to_name = '',
    shipped_to_address = '',
    shipped_to_gstin = '',
    irn = '',
    ack_number = '',
    ack_date = '',
    qr_code_data = '',
  } = body || {};
  const {
    business,
    invoiceNumber,
    invoiceDate,
    qrCodeImage = '',
    invoiceUrl = '',
    invoiceDownloadUrl = '',
  } = context;

    // GST is IGST across states, and CGST+SGST within the same state. The
    // supplier state comes from the GSTIN prefix; the customer's from theirs,
    // falling back to the place of supply code in brackets e.g. "... (09)".
    const supplierStateCode = String(business?.gstNumber || '').slice(0, 2);
    const customerStateCode = resolveStateCode(customer_gstin, place_of_supply);
    const isIntraState =
      Boolean(supplierStateCode) && supplierStateCode === customerStateCode;

    const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

    const gstRateValue = Number(gst_rate) || 0;
    const halfRate = round2(gstRateValue / 2);

    // Every figure the invoice prints is rounded to paise once, here, so the
    // totals column is arithmetic the customer can redo by hand. CGST and SGST
    // are both the same rounded half: an intra-state supply must show equal
    // heads, so the odd paisa a 50/50 split cannot carry falls to Rounded Off
    // rather than making one head disagree with its own printed rate.
    const subtotalValue = round2(subtotal);
    const gstAmountValue = round2(gst_amount);
    const halfAmount = round2(gstAmountValue / 2);
    const printedTax = isIntraState ? halfAmount * 2 : gstAmountValue;

    // The printed grand total is rounded to the rupee. Rounded Off is the
    // residual against the figures actually printed above it — not against the
    // client's unrounded total — so the column always closes.
    const roundedTotal = Math.round(round2(grand_total));
    const roundedOff = round2(roundedTotal - (subtotalValue + printedTax));

    // The printed "N Units" figure counts metal weight in grams only. Carats
    // are a different dimension and must not be added into the same total, so
    // each line is counted by the unit it actually prints.
    const totalUnits = (Array.isArray(line_items) ? line_items : []).reduce(
      (sum, item) => {
        const { value, unit } = resolveQuantity(item);
        return isGramUnit(unit) ? sum + value : sum;
      },
      0,
    );

    // 4. Build the PDFMonkey payload exactly matching the template schema
    const pdfPayload = {
      company_name: business?.tradeName || business?.legalName || '',
      company_address: business?.address || '',
      gstin_number: business?.gstNumber || '',
      customer_name,
      customer_address,
      customer_phone,
      customer_email,
      customer_gstin,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      place_of_supply,
      transport,
      line_items: line_items
        .filter((item) => Number(item.qty) > 0 || Number(item.amount) > 0)
        .map((item, index) => ({
          sn: index + 1,
          description: item.description ?? '',
          note: item.note ?? '',
          hsn: item.hsn ?? '',
          qty: Number(item.qty) || 0,
          qty_unit: item.qty_unit ?? item.qtyUnit ?? '',
          net_weight: Number(item.net_weight) || 0,
          diamond_weight: Number(item.diamond_weight) || 0,
          price: Number(item.price) || 0,
          amount: Number(item.amount) || 0,
          price_display: formatInr(item.price),
          amount_display: formatInr(item.amount),
          qty_display: resolveQuantity(item).value
            ? resolveQuantity(item).value.toFixed(3)
            : '',
          unit_display: resolveQuantity(item).unit,
        })),
      subtotal: subtotalValue,
      gst_rate: gstRateValue,
      gst_amount: gstAmountValue,
      grand_total: roundedTotal,

      // Tax split for the invoice footer. CGST and SGST are the same rounded
      // half, so the two heads always agree with their printed rate.
      is_intra_state: isIntraState,
      igst_rate: isIntraState ? 0 : gstRateValue,
      igst_amount: isIntraState ? 0 : gstAmountValue,
      cgst_rate: isIntraState ? halfRate : 0,
      cgst_amount: isIntraState ? halfAmount : 0,
      sgst_rate: isIntraState ? halfRate : 0,
      sgst_amount: isIntraState ? halfAmount : 0,
      rounded_off: roundedOff,

      // Tax rates print to two decimals, e.g. "@ 3.00 %".
      igst_rate_display: (isIntraState ? 0 : gstRateValue).toFixed(2),
      cgst_rate_display: (isIntraState ? halfRate : 0).toFixed(2),
      sgst_rate_display: (isIntraState ? halfRate : 0).toFixed(2),

      // Pre-formatted for printing; the raw numbers above stay for any caller
      // that needs to compute with them.
      subtotal_display: formatInr(subtotalValue),
      igst_amount_display: formatInr(isIntraState ? 0 : gstAmountValue),
      cgst_amount_display: formatInr(isIntraState ? halfAmount : 0),
      sgst_amount_display: formatInr(isIntraState ? halfAmount : 0),
      rounded_off_display: formatInr(Math.abs(roundedOff)),
      grand_total_display: formatInr(roundedTotal),
      total_units: totalUnits.toFixed(3),

      // Consignment block.
      reverse_charge: reverse_charge || 'N',
      gr_rr_number: gr_rr_number || '',
      vehicle_number: vehicle_number || '',
      station: station || '',
      shipped_to_name: shipped_to_name || customer_name,
      shipped_to_address: shipped_to_address || customer_address,
      shipped_to_gstin: shipped_to_gstin || customer_gstin,
      customer_pan,

      // Bank block, printed from the business profile.
      bank_name: business?.bankName || '',
      bank_branch: business?.bankBranch || '',
      bank_account_number: business?.bankAccountNumber || '',
      bank_ifsc: business?.bankIfsc || '',

      // Government e-invoice fields. Empty until an IRP integration supplies
      // them; the template hides the block when they are blank.
      irn: irn || '',
      ack_number: ack_number || '',
      ack_date: ack_date || '',

      // QR code. The printed QR requests this PDF as an attachment immediately;
      // invoice_url remains flag-free so the app can preview the same PDF.
      invoice_url: invoiceUrl,
      qr_code_data: invoiceDownloadUrl,
      qr_code_image: qrCodeImage,
      e_invoice_qr_code_data: String(qr_code_data || '').trim(),

      amount_in_words,
      signature_image: '',
      terms_and_conditions,
      terms_list:
        Array.isArray(business?.invoiceTerms) && business.invoiceTerms.length
          ? business.invoiceTerms
          : [
              'Goods once sold will not be taken back.',
              'Interest @ 18% p.a. will be charged if the payment is not made within the stipulated time.',
              'Subject to Delhi Jurisdiction only.',
            ],
    };

  return pdfPayload;
};

const INVOICE_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'invoice-pdfmonkey.html');
const liquid = new Liquid();

/**
 * POST /api/v1/invoices/preview-html
 *
 * Renders the invoice template for on-screen preview and returns the HTML.
 *
 * Uses the same template file and the same payload builder as generation, so
 * the preview is the document itself rather than a second layout that has to
 * be kept in step by hand. Nothing is persisted: no invoice number is spent,
 * no record written and no PDF service called.
 */
const previewInvoiceHtml = async (req, res, next) => {
  try {
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }

    const business = await Business.findById(businessId).lean();

    const invoiceNumber = String(req.body?.invoice_number || '').trim()
      || (await peekNextInvoiceNumber());
    const invoiceDate = new Date()
      .toLocaleDateString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata',
      })
      .split('/')
      .join('-');

    // The QR shown here is the one already reserved for this invoice, so the
    // preview and the eventual PDF print the same code.
    const publicToken = String(req.body?.public_token || '').trim();
    const invoiceUrl = /^[a-f0-9]{32}$/.test(publicToken)
      ? `${config.publicBaseUrl}/api/v1/invoices/p/${publicToken}`
      : '';
    const invoiceDownloadUrl = invoiceUrl ? `${invoiceUrl}?download=1` : '';

    let qrCodeImage = '';
    if (invoiceDownloadUrl) {
      try {
        qrCodeImage = await QRCode.toDataURL(invoiceDownloadUrl, {
          margin: 0, width: 240, errorCorrectionLevel: 'M',
        });
      } catch (qrErr) {
        console.error('[Invoice] Preview QR render failed:', qrErr.message);
      }
    }

    const payload = buildInvoicePayload(req.body, {
      business,
      invoiceNumber,
      invoiceDate,
      qrCodeImage,
      invoiceUrl,
      invoiceDownloadUrl,
    });

    const template = fs.readFileSync(INVOICE_TEMPLATE_PATH, 'utf8');
    const html = await liquid.parseAndRender(template, payload);

    return sendSuccess(res, { html });
  } catch (err) {
    next(err);
  }
};

const generateInvoice = async (req, res, next) => {
  try {
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }

    // 1. Load business profile for company fields. If not found, do NOT fail the
    // request — continue with blank company fields so invoice generation can
    // still proceed (useful in development or when a user record is dangling).
    const business = await Business.findById(businessId).lean();
    if (!business) {
      console.warn('[Invoice] Business profile not found for', businessId, '— proceeding with empty company fields');
    }

    const {
      customer_name = '',
      customer_address = '',
      customer_phone = '',
      customer_email = '',
      customer_gstin = '',
      place_of_supply = '',
      transport = '',
      line_items = [],
      subtotal = 0,
      gst_rate = 18,
      gst_amount = 0,
      grand_total = 0,
      amount_in_words = '',
      terms_and_conditions = '',
      customer_pan = '',
      reverse_charge = 'N',
      gr_rr_number = '',
      vehicle_number = '',
      station = '',
      shipped_to_name = '',
      shipped_to_address = '',
      shipped_to_gstin = '',
      irn = '',
      ack_number = '',
      ack_date = '',
      qr_code_data = '',
    } = req.body;

    // Validate required fields
    if (!customer_name?.trim()) {
      return sendError(res, 'customer_name is required', 400);
    }
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return sendError(res, 'line_items array is required and must not be empty', 400);
    }
    // Placed before generateInvoiceNumber so a stale or half-loaded client
    // cannot consume an invoice number for a zero-value document.
    if (!(Number(grand_total) > 0)) {
      return sendError(res, 'grand_total must be greater than zero', 400);
    }

    // 2. Generate server-side invoice number (atomic, central)
    const invoiceNumber = await generateInvoiceNumber();

    // 3. Format the invoice date (server time). The printed tax invoice shows
    // the date alone as DD-MM-YYYY — no time component.
    const now = new Date();
    const invoiceDate = now
      .toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
      .split('/')
      .join('-');

    // The QR code printed on the invoice resolves to this API, which then
    // serves the stored PDF. The token has to exist before the payload is
    // built, because the QR image is part of the document being generated.
    // Use the token already shown in the preview when the caller reserved one,
    // so the QR on screen and the QR on the PDF are the same code. Anything
    // unclaimable falls back to a fresh token rather than failing the invoice.
    const requestedToken = String(req.body?.public_token || '').trim();
    const claimed = requestedToken
      ? await redisService.claimInvoiceToken(requestedToken, businessId)
      : false;
    const publicToken = claimed ? requestedToken : crypto.randomBytes(16).toString('hex');
    const invoiceUrl = `${config.publicBaseUrl}/api/v1/invoices/p/${publicToken}`;
    const invoiceDownloadUrl = `${invoiceUrl}?download=1`;

    // Rendered here as a data URI so the PDF has no external image dependency:
    // PDFMonkey would otherwise print an empty box if the fetch failed.
    // This invoice's visible QR always resolves to the exact PDF generated
    // below. Keep any IRP/e-invoice payload separately so caller-provided data
    // can never replace the download link printed for the customer.
    const qrPayload = invoiceDownloadUrl;

    let qrCodeImage = '';
    try {
      qrCodeImage = await QRCode.toDataURL(qrPayload, {
        margin: 0,
        width: 240,
        errorCorrectionLevel: 'M',
      });
    } catch (qrErr) {
      // A missing QR must not cost the customer their invoice.
      console.error('[Invoice] QR generation failed:', qrErr.message);
    }

    // 4. Build the payload the template renders (shared with preview)
    const pdfPayload = buildInvoicePayload(req.body, {
      business,
      invoiceNumber,
      invoiceDate,
      qrCodeImage,
      invoiceUrl,
      invoiceDownloadUrl,
    });

    // 5. Save invoice record (status: pending) before hitting PDFMonkey
    const invoice = await Invoice.create({
      businessId,
      invoiceNumber,
      companyName: (business?.tradeName || business?.legalName || ''),
      companyAddress: pdfPayload.company_address,
      gstinNumber: pdfPayload.gstin_number,
      customerName: customer_name,
      customerAddress: customer_address,
      customerPhone: customer_phone,
      customerEmail: customer_email,
      customerGstin: customer_gstin,
      customerPan: customer_pan,
      invoiceDate,
      placeOfSupply: place_of_supply,
      transport,
      lineItems: pdfPayload.line_items,
      subtotal: pdfPayload.subtotal,
      gstRate: pdfPayload.gst_rate,
      gstAmount: pdfPayload.gst_amount,
      grandTotal: pdfPayload.grand_total,
      amountInWords: amount_in_words,
      termsAndConditions: terms_and_conditions,
      pdfStatus: 'pending',
      publicToken,
    });

    // 6. Call PDFMonkey synchronous endpoint
    const pdfFilename = `${invoiceNumber}-${(customer_name || 'customer').replace(/\s+/g, '-')}.pdf`;
    let pdfResult;
    try {
      pdfResult = await generateInvoicePdf(pdfPayload, pdfFilename);
    } catch (pdfErr) {
      // Mark as failed in DB but don't crash — return meaningful error
      await Invoice.findByIdAndUpdate(invoice._id, { pdfStatus: 'failure' });
      console.error('[Invoice] PDFMonkey generation failed:', pdfErr.message);
      return sendError(res, `PDF generation failed: ${pdfErr.message}`, 502);
    }

    // 7. Update invoice record with PDF URL
    await Invoice.findByIdAndUpdate(invoice._id, {
      pdfUrl: pdfResult.downloadUrl,
      pdfMonkeyDocId: pdfResult.docId,
      pdfStatus: 'success',
    });

    // Warm Redis before returning so the first phone that scans the printed QR
    // can receive the PDF without a MongoDB lookup or a PDFMonkey round trip.
    // Cache failures do not invalidate a correctly generated invoice; the
    // public endpoint can still rebuild the cache from the durable record.
    try {
      const pdfBuffer = await fetchInvoicePdf(pdfResult.downloadUrl);
      await redisService.setInvoicePdfCache(publicToken, invoiceNumber, pdfBuffer);
    } catch (cacheErr) {
      console.warn('[Invoice] Could not warm Redis PDF cache:', cacheErr.message);
    }

    return sendSuccess(res, {
      invoiceNumber,
      invoiceDate,
      pdfUrl: pdfResult.downloadUrl,
      invoiceId: invoice._id,
      invoiceUrl,
      // The same QR printed on the PDF, so the app can show it on screen
      // instead of rendering a second one that could drift from it.
      qrCodeImage,
    }, 201);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/invoices/reserve-qr
 *
 * Returns the token the next invoice will use, with the QR image drawn from
 * it, so the preview can show the very code the PDF will carry. The token is
 * held against this business for an hour; generateInvoice claims it.
 *
 * Reserving is deliberately server-side: letting a client choose its own token
 * would let it pick a guessable one for its own invoices.
 */
const reserveInvoiceQr = async (req, res, next) => {
  try {
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }

    const publicToken = crypto.randomBytes(16).toString('hex');
    const invoiceUrl = `${config.publicBaseUrl}/api/v1/invoices/p/${publicToken}`;
    const downloadUrl = `${invoiceUrl}?download=1`;

    let qrCodeImage = '';
    try {
      qrCodeImage = await QRCode.toDataURL(downloadUrl, {
        margin: 0,
        width: 240,
        errorCorrectionLevel: 'M',
      });
    } catch (qrErr) {
      console.error('[Invoice] QR reservation render failed:', qrErr.message);
    }

    await redisService.reserveInvoiceToken(publicToken, businessId);

    return sendSuccess(res, { publicToken, invoiceUrl, qrCodeImage });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/invoices/p/:token
 *
 * Public — this is the address encoded in the invoice QR code, so it is
 * reachable without a JWT by anyone holding the printed invoice. The token is
 * 128 bits of randomness and identifies exactly one invoice.
 *
 * Serves the Redis copy when available. On a cache miss it rebuilds the cache
 * from the MongoDB record and a fresh PDFMonkey URL. The client never sees the
 * provider's signed, short-lived URL.
 */
const getPublicInvoice = async (req, res, next) => {
  try {
    const token = String(req.params.token || '');

    // Reject anything that is not a token before touching the database.
    if (!/^[a-f0-9]{32}$/.test(token)) {
      return sendError(res, 'Invoice not found', 404);
    }

    // The hot path for QR scans: Redis contains both the immutable PDF bytes
    // and the safe filename, so no database or provider call is needed.
    try {
      const cached = await redisService.getInvoicePdfCache(token);
      if (cached?.pdfBuffer) {
        return sendInvoicePdf(res, cached.invoiceNumber, cached.pdfBuffer, req.query);
      }
    } catch (cacheErr) {
      console.warn('[Invoice] Redis PDF cache read failed:', cacheErr.message);
    }

    const invoice = await Invoice.findOne({ publicToken: token })
      .select('invoiceNumber pdfMonkeyDocId pdfUrl pdfStatus')
      .lean();

    if (!invoice) {
      return sendError(res, 'Invoice not found', 404);
    }
    if (invoice.pdfStatus !== 'success') {
      return sendError(res, 'This invoice is still being prepared', 409);
    }

    // Prefer a freshly signed URL; fall back to the stored one, which may
    // still be valid for a recently generated invoice.
    let downloadUrl = invoice.pdfUrl;
    if (invoice.pdfMonkeyDocId) {
      try {
        downloadUrl = await getDownloadUrl(invoice.pdfMonkeyDocId);
      } catch (urlErr) {
        console.warn('[Invoice] Could not refresh download URL:', urlErr.message);
      }
    }
    if (!downloadUrl) {
      return sendError(res, 'Invoice PDF is unavailable', 404);
    }

    let pdfBuffer;
    try {
      pdfBuffer = await fetchInvoicePdf(downloadUrl);
    } catch (pdfErr) {
      console.error('[Invoice] PDF fetch failed:', pdfErr.message);
      return sendError(res, 'Invoice PDF is unavailable', 502);
    }

    try {
      await redisService.setInvoicePdfCache(token, invoice.invoiceNumber, pdfBuffer);
    } catch (cacheErr) {
      console.warn('[Invoice] Redis PDF cache write failed:', cacheErr.message);
    }

    return sendInvoicePdf(res, invoice.invoiceNumber, pdfBuffer, req.query);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/invoices
 * Returns paginated invoices for the authenticated business (newest first).
 */
const getInvoices = async (req, res, next) => {
  try {
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const [invoices, total] = await Promise.all([
      Invoice.find({ businessId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-lineItems')  // exclude heavy array for list view
        .lean(),
      Invoice.countDocuments({ businessId }),
    ]);

    return sendSuccess(res, {
      invoices: invoices.map(withInvoiceUrl),
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/invoices/:id
 * Returns a single invoice with full line items.
 */
const getInvoice = async (req, res, next) => {
  try {
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId }).lean();
    if (!invoice) {
      return sendError(res, 'Invoice not found', 404);
    }
    return sendSuccess(res, { invoice: withInvoiceUrl(invoice) });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/invoices/preview/next-number
 * Returns the provisional next invoice number for the UI preview.
 */
const getNextInvoiceNumber = async (req, res, next) => {
  try {
    const nextNumber = await peekNextInvoiceNumber();
    return sendSuccess(res, { nextNumber });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  previewInvoiceHtml,
  reserveInvoiceQr,
  generateInvoice,
  getInvoices,
  getInvoice,
  getNextInvoiceNumber,
  getPublicInvoice,
};
