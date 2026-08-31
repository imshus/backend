const Invoice = require('../models/invoice.model');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const Employee = require('../models/employee.model');
const { generateInvoiceNumber, peekNextInvoiceNumber } = require('../models/invoiceCounter.model');
const { generateInvoicePdf } = require('../services/pdfmonkey.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

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
      customer_pan = '',
 *   place_of_supply, transport,
 *   line_items: [{ description, note, qty, price, amount }],
 *   subtotal, gst_rate, gst_amount, grand_total,
 *   amount_in_words, terms_and_conditions
 * }
 *
 * Company fields (company_name, company_address, gstin_number) are
 * sourced from the authenticated business profile — not trusted from client.
 */
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

    // 3. Format the invoice date (server time)
    const now = new Date();
    const invoiceDate = now.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    });

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
        .map((item) => ({
          description: item.description ?? '',
          note: item.note ?? '',
          qty: Number(item.qty) || 0,
          price: Number(item.price) || 0,
          amount: Number(item.amount) || 0,
        })),
      subtotal: Number(subtotal) || 0,
      gst_rate: Number(gst_rate) || 0,
      gst_amount: Number(gst_amount) || 0,
      grand_total: Number(grand_total) || 0,
      amount_in_words,
      signature_image: '',
      terms_and_conditions,
    };

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

    return sendSuccess(res, {
      invoiceNumber,
      invoiceDate,
      pdfUrl: pdfResult.downloadUrl,
      invoiceId: invoice._id,
    }, 201);
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

    return sendSuccess(res, { invoices, total, page, limit });
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
    return sendSuccess(res, { invoice });
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

module.exports = { generateInvoice, getInvoices, getInvoice, getNextInvoiceNumber };
