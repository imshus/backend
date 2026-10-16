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

/**
 * Who a reserved QR token belongs to: the user, not just the shop, so one
 * colleague's reservation cannot be claimed onto another's invoice.
 */
function reservationOwner(businessId, user) {
  return `${businessId}:${user?.userId || ''}`;
}
const { ownWorkFilter } = require('../services/userScope.service');
const { generateInvoicePdf, getDownloadUrl } = require('../services/pdfmonkey.service');
const einvoiceService = require('../services/einvoice.service');
const mailService = require('../services/mail.service');
const redisService = require('../services/redis.service');
const config = require('../config/env');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { isEmail } = require('../utils/email');
const { roundHalfUp, paiseToRupees } = require('../utils/money');
const { amountInWords } = require('../utils/amountInWords');
const {
  InvoiceInputError,
  computeInvoiceFigures,
  checkClientTotals,
  placeOfSupplyFor,
  isIntraStateSupply,
} = require('../services/invoiceMath');

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
 * The rendered PDF of an invoice whose pdfStatus is success, downloaded from
 * a freshly signed PDFMonkey link (or the stored one, which may still be
 * valid for a recent invoice) and written to the Redis copy the QR code is
 * served from. Null when there is no link at all; throws when the download
 * fails.
 */
const downloadStoredPdf = async (invoice, publicToken) => {
  let downloadUrl = invoice.pdfUrl;
  if (invoice.pdfMonkeyDocId) {
    try {
      downloadUrl = await getDownloadUrl(invoice.pdfMonkeyDocId);
    } catch (urlErr) {
      console.warn('[Invoice] Could not refresh download URL:', urlErr.message);
    }
  }
  if (!downloadUrl) return null;

  const pdfBuffer = await fetchInvoicePdf(downloadUrl);
  if (publicToken) {
    try {
      await redisService.setInvoicePdfCache(publicToken, invoice.invoiceNumber, pdfBuffer);
    } catch (cacheErr) {
      console.warn('[Invoice] Redis PDF cache write failed:', cacheErr.message);
    }
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

/**
 * Formats a number the way an Indian tax invoice prints it: two decimals and
 * lakh/crore digit grouping, e.g. 350650 -> "3,50,650.00". Paise are rounded
 * half-up first (toFixed alone prints 1.005 as "1.00").
 */
const formatInr = (value) => {
  const amount = roundHalfUp(Number(value) || 0, 2);
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
 *   transport,
 *   line_items: [{ description, note, qty, qty_unit, hsn, price, amount, kind? }],
 *   subtotal, gst_rate, gst_amount, grand_total,
 *   terms_and_conditions
 * }
 *
 * Company fields (company_name, company_address, gstin_number) are
 * sourced from the authenticated business profile — not trusted from client.
 *
 * So are the figures: subtotal, GST (each head), Rounded Off, the grand
 * total and the amount in words are all worked out here from the line items
 * (services/invoiceMath.js). The client's subtotal, gst_amount and
 * grand_total are only checked: a request more than a rupee away from its
 * own lines, or at a rate that is not the jewellery rate, is refused with a
 * 400 before an invoice number is spent. Place of supply is the buyer
 * GSTIN's state, or the shop's own for a walk-in; a client place_of_supply
 * is not used.
 *
 * A wastage line ({ description: 'Wastage', qty: <wastage grams>,
 * qty_unit: 'Gms.', price: <rate per gram>, amount }) bills like the gold
 * line: HSN 7113 at 3%, registered in grams (GMS), so the subtotal comes to
 * the MRP the scanner quoted. The grams and the rate come from the price
 * (breakdown wastageWeightGrams and wastageRatePerGram): from pricing rules
 * 3 the current gold rate, the 24K rate after the piece's purity; before
 * them the 24K rate. The amount is the MRP's wastage in whole rupees and the
 * grams are registered to the milligram, so the rate itself prints only
 * where the printed grams at it come to that amount (0.8 g at 13,740 is
 * 10,992). Elsewhere the app prints the price that does: 8% of 8.765 g is
 * 0.7012 g and 9,634.49 at 13,740, billed as 0.701 g at 13,744.65 for
 * 9,635. The rate on grams rounded up (0.70152 g printed as 0.702 g) would
 * come to 6.48 more than the amount, and a gap over a rupee registers as a
 * discount.
 */
/**
 * Builds the payload the invoice template renders.
 *
 * Shared by generation and preview so the two cannot drift: the preview
 * shows the same document the PDF is made from, rather than a lookalike
 * maintained separately. The e-invoice (INV-01) is built from this payload
 * by the same figures function, so the registered figures cannot drift
 * from the printed ones either.
 *
 * Throws InvoiceInputError (400) for a request the invoice cannot be issued
 * from; see computeInvoiceFigures and checkClientTotals.
 */
const buildInvoicePayload = (body, context) => {
  const {
    customer_name = '',
    customer_address = '',
    customer_phone = '',
    customer_email = '',
    customer_gstin = '',
    transport = '',
    line_items = [],
    gst_rate = 3,
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

    // Per the client's rule, CGST + SGST or IGST is decided by the supplier's
    // own GSTIN alone (invoiceMath.isIntraStateSupply): a Delhi shop prints
    // CGST and SGST as two lines, everyone else prints IGST.
    const isIntraState = isIntraStateSupply(business);

    const figures = context.figures || computeInvoiceFigures({
      lineItems: line_items,
      gstRate: gst_rate,
      intraState: isIntraState,
    });
    checkClientTotals(body, figures);

    const placeOfSupply = placeOfSupplyFor({ customerGstin: customer_gstin, business });

    // Every printed figure is whole paise from the figures above, so the
    // totals column is arithmetic the customer can redo by hand and the
    // CGST and SGST lines add up to the GST.
    const rupees = paiseToRupees;
    const gstRateValue = figures.gstRate;
    const halfRate = figures.halfRate;
    const subtotalValue = rupees(figures.subtotalPaise);
    const gstAmountValue = rupees(figures.gstPaise);
    const cgstValue = rupees(figures.cgstPaise);
    const sgstValue = rupees(figures.sgstPaise);
    const igstValue = rupees(figures.igstPaise);
    const roundedOff = rupees(figures.roundedOffPaise);
    const roundedTotal = rupees(figures.grandPaise);

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
      // "Delhi (07)": the state name and its code, per Rule 46(1)(n).
      place_of_supply: placeOfSupply.display,
      place_of_supply_code: placeOfSupply.code,
      place_of_supply_state: placeOfSupply.name,
      transport,
      line_items: figures.lines.map((line) => {
        const { item } = line;
        const amount = rupees(line.amountPaise);
        const quantity = resolveQuantity(item);
        const discount = rupees(line.discountPaise);
        const grossAmount = rupees(line.grossPaise);
        return {
          sn: line.index,
          kind: line.kind,
          description: item.description ?? '',
          note: item.note ?? '',
          // Articles of jewellery — gold of every karat, diamond, wastage
          // and the labour that made them alike. The code printed is the
          // code registered with the IRP.
          hsn: line.hsn,
          qty: line.qty,
          qty_unit: item.qty_unit ?? item.qtyUnit ?? '',
          // NIC unit quantity code: GMS for grams, CTS for carats, OTH for
          // a line billed by its amount alone.
          uqc: line.uqc,
          net_weight: Number(item.net_weight) || 0,
          diamond_weight: Number(item.diamond_weight) || 0,
          price: Number(item.price) || 0,
          amount,
          // What the e-invoice registers: Qty × Unit Price, less any
          // discount, is the amount billed.
          unit_price: line.unitPrice,
          gross_amount: grossAmount,
          discount,
          discount_percent: line.discountPaise > 0 && line.grossPaise > 0
            ? roundHalfUp((line.discountPaise / line.grossPaise) * 100, 2)
            : 0,
          cgst_amount: rupees(line.cgstPaise),
          sgst_amount: rupees(line.sgstPaise),
          igst_amount: rupees(line.igstPaise),
          price_display: formatInr(item.price),
          amount_display: formatInr(amount),
          gross_amount_display: formatInr(grossAmount),
          discount_display: line.discountPaise > 0 ? formatInr(discount) : '',
          discount_percent_display: line.discountPaise > 0 && line.grossPaise > 0
            ? roundHalfUp((line.discountPaise / line.grossPaise) * 100, 2).toFixed(2)
            : '',
          qty_display: quantity.value
            ? roundHalfUp(quantity.value, 3).toFixed(3)
            : '',
          unit_display: quantity.unit,
        };
      }),
      subtotal: subtotalValue,
      gst_rate: gstRateValue,
      gst_amount: gstAmountValue,
      grand_total: roundedTotal,

      // Tax split for the invoice footer. A Delhi supplier prints CGST and
      // SGST as separate lines (Rule 46(1)(i)-(j)); everyone else prints
      // IGST. Each head is the sum of the line taxes, so CGST + SGST is
      // always the GST printed and registered.
      is_intra_state: isIntraState,
      igst_rate: isIntraState ? 0 : gstRateValue,
      igst_amount: igstValue,
      cgst_rate: isIntraState ? halfRate : 0,
      cgst_amount: cgstValue,
      sgst_rate: isIntraState ? halfRate : 0,
      sgst_amount: sgstValue,
      // Within ±50 paise by construction.
      rounded_off: roundedOff,

      // Tax rates print to two decimals, e.g. "@ 3.00 %".
      // The combined pair is never zeroed by state: the template decides which
      // head to print from the GSTIN and reads these for either one, so
      // blanking them here printed "IGST @ 0.00 %" on every outside-Delhi bill.
      gst_rate_display: gstRateValue.toFixed(2),
      igst_rate_display: (isIntraState ? 0 : gstRateValue).toFixed(2),
      cgst_rate_display: (isIntraState ? halfRate : 0).toFixed(2),
      sgst_rate_display: (isIntraState ? halfRate : 0).toFixed(2),

      // Pre-formatted for printing; the raw numbers above stay for any caller
      // that needs to compute with them.
      subtotal_display: formatInr(subtotalValue),
      gst_amount_display: formatInr(gstAmountValue),
      igst_amount_display: formatInr(igstValue),
      cgst_amount_display: formatInr(cgstValue),
      sgst_amount_display: formatInr(sgstValue),
      rounded_off_display: formatInr(Math.abs(roundedOff)),
      grand_total_display: formatInr(roundedTotal),

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
      // Government-signed QR, drawn as an image once the IRP answers.
      e_invoice_qr_image: '',
      // True when the band is a test-mode specimen rather than an IRP record.
      e_invoice_test: false,

      // Worded from the grand total printed above it, never the client's.
      amount_in_words: amountInWords(roundedTotal),
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
      || (await peekNextInvoiceNumber(businessId));
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
    // The same refusal generation would give, so the preview never shows a
    // document that cannot be issued.
    if (err instanceof InvoiceInputError) {
      return sendError(res, err.message, 400);
    }
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
      transport = '',
      line_items = [],
      gst_rate = 3,
      grand_total = 0,
      terms_and_conditions = '',
      customer_pan = '',
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

    // The figures, worked out here from the line items, and the client's own
    // totals checked against them — all before a number is spent, so a
    // refused request costs the shop no gap in its series.
    let figures;
    try {
      figures = computeInvoiceFigures({
        lineItems: line_items,
        gstRate: gst_rate,
        intraState: isIntraStateSupply(business),
      });
      checkClientTotals(req.body, figures);
    } catch (inputErr) {
      if (inputErr instanceof InvoiceInputError) {
        return sendError(res, inputErr.message, 400);
      }
      throw inputErr;
    }
    if (!(figures.grandPaise > 0)) {
      return sendError(res, 'grand_total must be greater than zero', 400);
    }

    // 2. Generate server-side invoice number (atomic, per business per day).
    // One instant for both, so the number's date is the date printed.
    const now = new Date();
    const invoiceNumber = await generateInvoiceNumber(businessId, now);

    // 3. Format the invoice date (server time). The printed tax invoice shows
    // the date alone as DD-MM-YYYY — no time component.
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
      ? await redisService.claimInvoiceToken(requestedToken, reservationOwner(businessId, req.user))
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

    // 4. Build the payload the template renders (shared with preview), from
    // the figures already checked above.
    const pdfPayload = buildInvoicePayload(req.body, {
      business,
      invoiceNumber,
      invoiceDate,
      qrCodeImage,
      invoiceUrl,
      invoiceDownloadUrl,
      figures,
    });

    // 5. Save invoice record (status: pending) before hitting PDFMonkey
    const invoice = await Invoice.create({
      businessId,
      invoiceNumber,
      userId: String(req.user?.userId || '').trim() || null,
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
      placeOfSupply: pdfPayload.place_of_supply,
      placeOfSupplyCode: pdfPayload.place_of_supply_code,
      transport,
      lineItems: pdfPayload.line_items,
      subtotal: pdfPayload.subtotal,
      gstRate: pdfPayload.gst_rate,
      gstAmount: pdfPayload.gst_amount,
      cgstAmount: pdfPayload.cgst_amount,
      sgstAmount: pdfPayload.sgst_amount,
      igstAmount: pdfPayload.igst_amount,
      roundedOff: pdfPayload.rounded_off,
      grandTotal: pdfPayload.grand_total,
      amountInWords: pdfPayload.amount_in_words,
      termsAndConditions: terms_and_conditions,
      pdfStatus: 'pending',
      publicToken,
    });

    // 6. Answer now; render the PDF in the background.
    //
    // The PDFMonkey render was the slow part of every Share, Download, Email
    // and Print, and nothing in the response depends on it: the durable
    // invoiceUrl answers 409 until the PDF exists and the app polls that,
    // and the app can print its own copy from the same template meanwhile.
    // The record already holds the number, so nothing can drift.
    // The number has slashes ("26-27/1015/00001"), which a file name cannot.
    const pdfFilename = `${String(invoiceNumber).replace(/[^\w.-]+/g, '-')}-${(customer_name || 'customer').replace(/\s+/g, '-')}.pdf`;
    setImmediate(async () => {
      // Government e-invoice first, so the PDF can carry the signed QR. B2B
      // only, behind EINVOICE_ENABLED; any failure is recorded on the invoice
      // and the PDF still renders — a registration problem must never cost
      // the customer their invoice.
      if (einvoiceService.isEligible(business, pdfPayload)) {
        try {
          // Live registers with the IRP; test prints a specimen band whose
          // QR payload states in words that nothing was registered.
          const testMode = einvoiceService.resolveMode(business) === 'test';
          const registered = testMode
            ? einvoiceService.generateTestEInvoice(pdfPayload, business)
            : await einvoiceService.generateEInvoice({ payload: pdfPayload, business });
          pdfPayload.irn = registered.irn;
          pdfPayload.ack_number = registered.ackNo;
          pdfPayload.ack_date = registered.ackDt;
          pdfPayload.e_invoice_qr_code_data = registered.signedQr;
          pdfPayload.e_invoice_test = testMode;
          try {
            // The signed payload is a long JWT; low error correction keeps it
            // within QR capacity while staying scannable at print size.
            pdfPayload.e_invoice_qr_image = await QRCode.toDataURL(registered.signedQr, {
              margin: 0,
              width: 260,
              errorCorrectionLevel: 'L',
            });
          } catch (qrErr) {
            console.error('[EINVOICE_QR_RENDER_FAILED]', qrErr.message);
          }
          await Invoice.findByIdAndUpdate(invoice._id, {
            eInvoiceStatus: testMode ? 'TEST' : 'GENERATED',
            irn: registered.irn,
            eInvoiceAckNo: registered.ackNo,
            eInvoiceAckDt: registered.ackDt,
            eInvoiceAt: new Date(),
          });
        } catch (eErr) {
          const detail = eErr.response?.data ? JSON.stringify(eErr.response.data) : eErr.message;
          console.error('[EINVOICE_FAILED]', { invoiceNumber, detail: String(detail).slice(0, 400) });
          try {
            await Invoice.findByIdAndUpdate(invoice._id, {
              eInvoiceStatus: 'FAILED',
              eInvoiceError: String(detail).slice(0, 300),
            });
          } catch (markErr) {
            console.error('[EINVOICE_MARK_FAILED]', markErr.message);
          }
        }
      }

      let pdfResult;
      try {
        pdfResult = await generateInvoicePdf(pdfPayload, pdfFilename);
      } catch (pdfErr) {
        console.error('[Invoice] PDFMonkey generation failed:', pdfErr.message);
        try {
          await Invoice.findByIdAndUpdate(invoice._id, { pdfStatus: 'failure' });
        } catch (updateErr) {
          console.error('[Invoice] Could not mark PDF failure:', updateErr.message);
        }
        return;
      }
      try {
        await Invoice.findByIdAndUpdate(invoice._id, {
          pdfUrl: pdfResult.downloadUrl,
          pdfMonkeyDocId: pdfResult.docId,
          pdfStatus: 'success',
        });
      } catch (updateErr) {
        console.error('[Invoice] Could not record the PDF URL:', updateErr.message);
        return;
      }
      // Warm Redis so the first phone that scans the printed QR gets the PDF
      // without a PDFMonkey round trip.
      void fetchInvoicePdf(pdfResult.downloadUrl)
        .then((pdfBuffer) => redisService.setInvoicePdfCache(publicToken, invoiceNumber, pdfBuffer))
        .catch((cacheErr) => {
          console.warn('[Invoice] Could not warm Redis PDF cache:', cacheErr.message);
        });
    });

    // The scan this invoice was made from is over. The request carries no
    // scan id, so it is the caller's latest scan, when one was read. Never
    // a reason for the invoice itself to fail.
    Promise.resolve()
      .then(() => redisService.finishLatestAnalyzedScan(req.user?.businessId, req.user?.userId, 'invoice'))
      .catch((finishErr) => console.warn('[Invoice] Could not finish the scan:', finishErr.message));

    return sendSuccess(res, {
      invoiceNumber,
      invoiceDate,
      // The signed PDFMonkey link does not exist yet; the app uses invoiceUrl.
      pdfUrl: '',
      invoiceId: invoice._id,
      invoiceUrl,
      // The same QR printed on the PDF, so the app can show it on screen
      // instead of rendering a second one that could drift from it.
      qrCodeImage,
      // The figures as issued: the server's, from the line items.
      subtotal: pdfPayload.subtotal,
      gstAmount: pdfPayload.gst_amount,
      grandTotal: pdfPayload.grand_total,
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

    await redisService.reserveInvoiceToken(publicToken, reservationOwner(businessId, req.user));

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
    if (invoice.pdfStatus === 'failure') {
      return sendError(res, 'This invoice could not be rendered', 502);
    }
    if (invoice.pdfStatus !== 'success') {
      return sendError(res, 'This invoice is still being prepared', 409);
    }

    let pdfBuffer;
    try {
      pdfBuffer = await downloadStoredPdf(invoice, token);
    } catch (pdfErr) {
      console.error('[Invoice] PDF fetch failed:', pdfErr.message);
      return sendError(res, 'Invoice PDF is unavailable', 502);
    }
    if (!pdfBuffer) {
      return sendError(res, 'Invoice PDF is unavailable', 404);
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

    // An employee's list is their own invoices; the owner's is the shop's.
    const filter = { businessId, ...ownWorkFilter(req.user) };
    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-lineItems')  // exclude heavy array for list view
        .lean(),
      Invoice.countDocuments(filter),
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
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId, ...ownWorkFilter(req.user) }).lean();
    if (!invoice) {
      return sendError(res, 'Invoice not found', 404);
    }
    return sendSuccess(res, { invoice: withInvoiceUrl(invoice) });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/invoices/:id/email
 *
 * Emails the invoice PDF over the SMTP account in .env, to the customer
 * email saved on the invoice and to no one else: the route cannot be pointed
 * at another address, so it cannot be used to mail strangers. 503 while SMTP
 * is not set up, which the app answers by opening the phone's mail app.
 */
const emailInvoice = async (req, res, next) => {
  try {
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId, ...ownWorkFilter(req.user) })
      .select('invoiceNumber invoiceDate companyName customerName customerEmail grandTotal pdfStatus pdfUrl pdfMonkeyDocId publicToken')
      .lean();
    if (!invoice) {
      return sendError(res, 'Invoice not found', 404);
    }

    const to = String(invoice.customerEmail || '').trim();
    if (!isEmail(to)) {
      return sendError(res, 'Add the customer\'s email address to send this invoice.', 400);
    }
    if (!mailService.isConfigured()) {
      return sendError(res, 'Invoice email is not set up on the server.', 503);
    }

    // The app hands over its own copy of the PDF at once while this one
    // renders in the background, so an Email tapped straight after generating
    // waits here for the render rather than being turned away.
    const waitMs = config.invoiceEmailPdfWaitMs ?? 25_000;
    const waitUntil = Date.now() + waitMs;
    while (!['success', 'failure'].includes(invoice.pdfStatus) && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(750, waitMs / 5))));
      const fresh = await Invoice.findById(invoice._id).select('pdfStatus pdfUrl pdfMonkeyDocId').lean();
      if (!fresh) break;
      Object.assign(invoice, fresh);
    }
    if (invoice.pdfStatus === 'failure') {
      return sendError(res, 'This invoice could not be rendered', 502);
    }
    if (invoice.pdfStatus !== 'success') {
      return sendError(res, 'This invoice is still being prepared', 409);
    }

    let pdfBuffer = null;
    if (invoice.publicToken) {
      try {
        pdfBuffer = (await redisService.getInvoicePdfCache(invoice.publicToken))?.pdfBuffer || null;
      } catch (cacheErr) {
        console.warn('[Invoice] Redis PDF cache read failed:', cacheErr.message);
      }
    }
    if (!pdfBuffer) {
      try {
        pdfBuffer = await downloadStoredPdf(invoice, invoice.publicToken);
      } catch (pdfErr) {
        console.error('[Invoice] PDF fetch failed:', pdfErr.message);
        return sendError(res, 'Invoice PDF is unavailable', 502);
      }
      if (!pdfBuffer) {
        return sendError(res, 'Invoice PDF is unavailable', 404);
      }
    }

    const shop = String(invoice.companyName || '').trim();
    try {
      await mailService.sendMail({
        to,
        subject: `Invoice ${invoice.invoiceNumber}${shop ? ` from ${shop}` : ''}`,
        text: [
          `Dear ${String(invoice.customerName || '').trim() || 'Customer'},`,
          '',
          `Please find attached invoice ${invoice.invoiceNumber} dated ${invoice.invoiceDate} `
            + `for ₹ ${formatInr(invoice.grandTotal)}.`,
          '',
          'Thank you for your business.',
          shop,
        ].join('\n').trim(),
        fromName: shop,
        attachments: [{
          filename: safeInvoiceFilename(invoice.invoiceNumber),
          content: pdfBuffer,
          contentType: 'application/pdf',
        }],
      });
    } catch (mailErr) {
      console.error('[INVOICE_EMAIL_FAILED]', {
        invoiceNumber: invoice.invoiceNumber,
        detail: String(mailErr?.message || mailErr).slice(0, 300),
      });
      return sendError(res, 'The email could not be sent. Please try again.', 502);
    }

    try {
      await Invoice.findByIdAndUpdate(invoice._id, { emailedTo: to, emailedAt: new Date() });
    } catch (markErr) {
      console.warn('[Invoice] Could not record the email:', markErr.message);
    }
    return sendSuccess(res, { sentTo: to });
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
    const businessId = await resolveBusinessIdFromUser(req.user);
    if (!businessId) {
      return sendError(res, 'Unauthorized', 401);
    }
    const nextNumber = await peekNextInvoiceNumber(businessId);
    return sendSuccess(res, { nextNumber });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  // Exported so the template can be rendered offline from the very payload
  // production sends, instead of a hand-written sample that drifts from it.
  buildInvoicePayload,
  previewInvoiceHtml,
  reserveInvoiceQr,
  generateInvoice,
  getInvoices,
  getInvoice,
  getNextInvoiceNumber,
  getPublicInvoice,
  emailInvoice,
};
