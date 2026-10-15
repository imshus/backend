const mongoose = require('mongoose');

/**
 * The last invoice sequence used by each business on each day.
 *
 * Format of the number it feeds: FY/MMDD/NNNNN, e.g. "26-27/1015/00001" for
 * the first invoice of 15 October 2026 (financial year 2026-27), counting
 * from 00001 every day for every shop, so a shop's own invoices run
 * consecutively within the day.
 *
 * Sixteen characters at most: CGST Rule 46(1)(b) caps an invoice's serial
 * number at sixteen, and the e-invoice schema's DocDtls.No is the same
 * sixteen (^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$). The old INV-YYYY-MMDD-NNNNN
 * was nineteen. A month-and-day appears once in a financial year and the
 * financial year is in the number, so a number never repeats for a shop
 * within the year, or across years. Invoices already issued keep the
 * number they were issued with.
 *
 * Dates are India dates, the same day the invoice prints as its date.
 */
const invoiceCounterSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  dateKey: { type: String, required: true }, // e.g. "2026-0906"
  seq: { type: Number, default: 0 },
});

invoiceCounterSchema.index({ businessId: 1, dateKey: 1 }, { unique: true });

const InvoiceCounter = mongoose.model('InvoiceCounter', invoiceCounterSchema, 'invoice_counters');

const MAX_INVOICE_NUMBER_LENGTH = 16;
const INVOICE_NUMBER_PATTERN = /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/;

/** The India (IST) calendar date of an instant. */
const indiaDate = (now = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.year);
  const mm = parts.month;
  const dd = parts.day;
  return { year, mm, dd, dateKey: `${year}-${mm}${dd}` };
};

/** "26-27" for any date from 1 April 2026 to 31 March 2027. */
const financialYearLabel = ({ year, mm }) => {
  const startYear = Number(mm) >= 4 ? year : year - 1;
  const two = (y) => String(y % 100).padStart(2, '0');
  return `${two(startYear)}-${two(startYear + 1)}`;
};

const formatNumber = (day, seq) => {
  const number = `${financialYearLabel(day)}/${day.mm}${day.dd}/${String(seq).padStart(5, '0')}`;
  if (number.length > MAX_INVOICE_NUMBER_LENGTH || !INVOICE_NUMBER_PATTERN.test(number)) {
    // Only a shop issuing more than 99,999 invoices in a day gets here.
    throw new Error(`Invoice number ${number} is longer than ${MAX_INVOICE_NUMBER_LENGTH} characters`);
  }
  return number;
};

const requireBusiness = (businessId) => {
  if (!businessId) throw new Error('An invoice number belongs to a business; none was given');
  return businessId;
};

/**
 * Atomically takes the next number for this business on the given India
 * date (today by default). e.g. "26-27/1015/00001"
 */
async function generateInvoiceNumber(businessId, now = new Date()) {
  const day = indiaDate(now);
  const counter = await InvoiceCounter.findOneAndUpdate(
    { businessId: requireBusiness(businessId), dateKey: day.dateKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return formatNumber(day, counter.seq);
}

/**
 * The number this business's next invoice will carry, without taking it.
 * Shown on the preview; the number is only consumed when the invoice is issued.
 */
async function peekNextInvoiceNumber(businessId, now = new Date()) {
  const day = indiaDate(now);
  const counter = await InvoiceCounter.findOne({ businessId: requireBusiness(businessId), dateKey: day.dateKey });
  return formatNumber(day, (counter ? counter.seq : 0) + 1);
}

module.exports = {
  InvoiceCounter,
  generateInvoiceNumber,
  peekNextInvoiceNumber,
  MAX_INVOICE_NUMBER_LENGTH,
  INVOICE_NUMBER_PATTERN,
};
