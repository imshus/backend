const { InvoiceInputError } = require('./invoiceMath');
const { roundHalfUp } = require('../utils/money');

/**
 * Which pieces an invoice bills (POST /invoices/generate and preview-html):
 * the card's one piece, or a cart's several (Wishlist -> Add to cart). Plain
 * JSON in, plain JSON out, so the app's tests run these very rules on the
 * request its cart builds (mrpscan-app utils/__tests__/cartInvoice.test.mjs).
 */

/**
 * How many pieces an invoice bills. Every invoice the app issues today bills
 * the one scanned piece on the card, so that is the default; a request that
 * bills several says so in `piece_count`, a whole number from 1 to the
 * number of its lines (each piece has a line of its own at least).
 */
const pieceCountOf = (body, lineCount) => {
  const raw = body?.piece_count;
  if (raw === undefined || raw === null || raw === '') return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > lineCount) {
    throw new InvoiceInputError('piece_count must be a whole number from 1 to the number of line items');
  }
  return count;
};

// A cart invoice bills 1 to 50 pieces (Wishlist -> Add to cart).
const MAX_CART_PIECES = 50;
const MAX_PIECE_TEXT = 200;
const MAX_PIECE_MRP = 1e10;

/** A piece's text field: trimmed text up to 200 characters, '' when absent. */
const pieceText = (value, field, { required = false } = {}) => {
  const given = value === undefined || value === null ? '' : value;
  if (typeof given !== 'string' && typeof given !== 'number') {
    throw new InvoiceInputError(`${field} must be text`);
  }
  const text = String(given).trim();
  if (required && !text) throw new InvoiceInputError(`${field} is required`);
  if (text.length > MAX_PIECE_TEXT) throw new InvoiceInputError(`${field} must be at most ${MAX_PIECE_TEXT} characters`);
  return text;
};

/**
 * The pieces a cart invoice bills, as the cart lists them: `pieces`, 1 to 50
 * of { wishlist_item_id?, scan_id?, item_name, tag_code, mrp }, no more than
 * the invoice has lines (each piece has a line of its own at least). Null
 * when the request has none: an invoice billed straight from the card.
 *
 * They name the pieces and nothing more: the invoice's figures are worked
 * out from its lines (computeInvoiceFigures) and checked against the client's
 * totals, as for every invoice, and the MRPs here are not added up.
 */
const cartPiecesOf = (body, lineCount) => {
  const raw = body?.pieces;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CART_PIECES) {
    throw new InvoiceInputError(`pieces must be a list of 1 to ${MAX_CART_PIECES} pieces`);
  }
  if (raw.length > lineCount) {
    throw new InvoiceInputError('pieces cannot be more than the line items: every piece has a line of its own');
  }
  return raw.map((piece, index) => {
    const at = `pieces[${index}]`;
    if (!piece || typeof piece !== 'object' || Array.isArray(piece)) {
      throw new InvoiceInputError(`${at} must be an object`);
    }
    const mrpText = typeof piece.mrp === 'string' ? piece.mrp.replace(/[₹,\s]/g, '') : piece.mrp;
    const mrp = typeof mrpText === 'number' || (typeof mrpText === 'string' && mrpText !== '') ? Number(mrpText) : NaN;
    if (!Number.isFinite(mrp) || mrp < 0 || mrp > MAX_PIECE_MRP) {
      throw new InvoiceInputError(`${at}.mrp must be an amount of 0 or more`);
    }
    return {
      itemName: pieceText(piece.item_name, `${at}.item_name`, { required: true }),
      tagCode: pieceText(piece.tag_code, `${at}.tag_code`),
      mrp: roundHalfUp(mrp, 2),
      wishlistItemId: pieceText(piece.wishlist_item_id, `${at}.wishlist_item_id`),
      scanId: pieceText(piece.scan_id, `${at}.scan_id`),
    };
  });
};

/**
 * How many pieces an invoice bills, and which: { pieceCount, pieces }. With
 * a cart's `pieces` the count is theirs, and a `piece_count` sent beside them
 * must say the same; without, piece_count as pieceCountOf reads it and
 * pieces null. Throws InvoiceInputError (400).
 */
const invoicePiecesOf = (body, lineCount) => {
  const pieces = cartPiecesOf(body, lineCount);
  if (!pieces) return { pieceCount: pieceCountOf(body, lineCount), pieces: null };
  const raw = body?.piece_count;
  if (raw !== undefined && raw !== null && raw !== '' && Number(raw) !== pieces.length) {
    throw new InvoiceInputError('piece_count must equal the number of pieces');
  }
  return { pieceCount: pieces.length, pieces };
};

module.exports = {
  MAX_CART_PIECES,
  MAX_PIECE_TEXT,
  pieceCountOf,
  cartPiecesOf,
  invoicePiecesOf,
};
