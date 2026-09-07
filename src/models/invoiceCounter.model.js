const mongoose = require('mongoose');

/**
 * The last invoice sequence used by each business on each day.
 * Format of the number it feeds: INV-YYYY-MMDD-NNNNN, counting from 00001
 * every day for every shop, so a shop's own invoices run consecutively.
 */
const invoiceCounterSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  dateKey: { type: String, required: true }, // e.g. "2026-0906"
  seq: { type: Number, default: 0 },
});

invoiceCounterSchema.index({ businessId: 1, dateKey: 1 }, { unique: true });

const InvoiceCounter = mongoose.model('InvoiceCounter', invoiceCounterSchema, 'invoice_counters');

const todayKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return { year, mm, dd, dateKey: `${year}-${mm}${dd}` };
};

const formatNumber = ({ year, mm, dd }, seq) => `INV-${year}-${mm}${dd}-${String(seq).padStart(5, '0')}`;

const requireBusiness = (businessId) => {
  if (!businessId) throw new Error('An invoice number belongs to a business; none was given');
  return businessId;
};

/**
 * Atomically takes the next number for this business today.
 * e.g. "INV-2026-0906-00001"
 */
async function generateInvoiceNumber(businessId) {
  const today = todayKey();
  const counter = await InvoiceCounter.findOneAndUpdate(
    { businessId: requireBusiness(businessId), dateKey: today.dateKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return formatNumber(today, counter.seq);
}

/**
 * The number this business's next invoice will carry, without taking it.
 * Shown on the preview; the number is only consumed when the invoice is issued.
 */
async function peekNextInvoiceNumber(businessId) {
  const today = todayKey();
  const counter = await InvoiceCounter.findOne({ businessId: requireBusiness(businessId), dateKey: today.dateKey });
  return formatNumber(today, (counter ? counter.seq : 0) + 1);
}

module.exports = { InvoiceCounter, generateInvoiceNumber, peekNextInvoiceNumber };
