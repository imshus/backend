const mongoose = require('mongoose');
const Invoice = require('../models/invoice.model');
const config = require('../config/env');
const { ownWorkFilter } = require('./userScope.service');
const { pageQuery, readPage } = require('./historyPage');

/**
 * Settings -> History -> Checkout history: the invoices generated from the
 * Wishlist cart, newest first, each as the cart it billed ("Cart · 2 items",
 * the pieces and the grand total). Only those, at the owner's asking: an
 * invoice billed straight from a scan's card is not a checkout. A cart
 * invoice keeps its pieces (POST /invoices/generate `pieces`) and fromCart.
 */

/** Whose invoices a session sees: the shop's for an owner, its own for an employee (as GET /invoices). */
const visibleFilter = (user) => ({ businessId: user.businessId, ...ownWorkFilter(user) });

const pieceCountOf = (invoice) => invoice.pieceCount ?? null;

/** The query behind listCheckouts; its filter and order are the invoice model's checkout indexes'. */
function checkoutsQuery(user, { limit, before } = {}) {
  return pageQuery(Invoice, { ...visibleFilter(user), fromCart: true }, { limit, before })
    .select('invoiceNumber pieceCount pieces grandTotal createdAt');
}

/**
 * A page of a session's checkouts, newest first:
 * { items: [{ id, invoiceNumber, pieceCount, pieces: [{ itemName, tagCode,
 * mrp }], grandTotal, createdAt }], nextCursor }.
 */
async function listCheckouts(user, { limit, before } = {}) {
  const { lines, nextCursor } = await readPage(checkoutsQuery(user, { limit, before }), { limit });
  return {
    items: lines.map((invoice) => ({
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      pieceCount: pieceCountOf(invoice),
      pieces: (invoice.pieces || []).map(({ itemName, tagCode, mrp }) => ({ itemName, tagCode, mrp })),
      grandTotal: invoice.grandTotal,
      createdAt: invoice.createdAt,
    })),
    nextCursor,
  };
}

/**
 * One checkout, for the cart page it opens: the list's fields with each
 * piece's wishlist item and scan (null when the app did not say), the
 * customer's name, the invoice date, and the invoice's durable URL (null on
 * one issued before invoices had one). Null when the session may not see it.
 */
async function getCheckout(user, id) {
  if (!mongoose.isValidObjectId(String(id || ''))) return null;
  const invoice = await Invoice.findOne({ _id: id, ...visibleFilter(user) })
    .select('invoiceNumber invoiceDate pieceCount pieces grandTotal customerName publicToken createdAt')
    .lean();
  if (!invoice) return null;
  return {
    id: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    pieceCount: pieceCountOf(invoice),
    pieces: (invoice.pieces || []).map((piece) => ({
      itemName: piece.itemName,
      tagCode: piece.tagCode,
      mrp: piece.mrp,
      wishlistItemId: piece.wishlistItemId || null,
      scanId: piece.scanId || null,
    })),
    grandTotal: invoice.grandTotal,
    customerName: invoice.customerName || '',
    invoiceUrl: invoice.publicToken ? `${config.publicBaseUrl}/api/v1/invoices/p/${invoice.publicToken}` : null,
    createdAt: invoice.createdAt,
  };
}

module.exports = {
  checkoutsQuery,
  listCheckouts,
  getCheckout,
};
