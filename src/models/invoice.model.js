const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  note: { type: String, default: '' },
  qty: { type: Number, required: true },
  price: { type: Number, required: true },
  amount: { type: Number, required: true },
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
  },

  // Company (auto-populated from business profile)
  companyName: { type: String, default: '' },
  companyAddress: { type: String, default: '' },
  gstinNumber: { type: String, default: '' },

  // Customer (from form)
  customerName: { type: String, default: '' },
  customerAddress: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  customerEmail: { type: String, default: '' },
  customerGstin: { type: String, default: '' },

  // Invoice metadata
  invoiceDate: { type: String, required: true },
  placeOfSupply: { type: String, default: '' },
  transport: { type: String, default: '' },

  // Billing
  lineItems: { type: [lineItemSchema], default: [] },
  subtotal: { type: Number, required: true },
  gstRate: { type: Number, required: true },
  gstAmount: { type: Number, required: true },
  grandTotal: { type: Number, required: true },
  amountInWords: { type: String, default: '' },
  termsAndConditions: { type: String, default: '' },

  // PDF
  pdfUrl: { type: String, default: null },
  pdfMonkeyDocId: { type: String, default: null },
  pdfStatus: {
    type: String,
    enum: ['pending', 'generating', 'success', 'failure'],
    default: 'pending',
  },
}, {
  timestamps: true,
  collection: 'invoices',
});

module.exports = mongoose.model('Invoice', invoiceSchema);
