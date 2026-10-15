const {
  toPaise,
  paiseToRupees,
  divHalfUp,
  roundPaiseToRupee,
  toBasisPoints,
  roundHalfUp,
} = require('../utils/money');

/**
 * The figures a jewellery tax invoice prints and registers, worked out on the
 * server from its line items.
 *
 * The app used to send its own subtotal, GST and grand total, and the server
 * printed whatever arrived: a total that did not match the lines came out as
 * a Rounded Off of any size, and a wrong rate was printed and registered as
 * sent. Now every figure is derived here, in whole paise, half-up:
 *
 *   line tax      each line taxed on its own amount: CGST and SGST each at
 *                 half the rate, or IGST at the full rate
 *   heads         CGST, SGST and IGST are the sums of the line taxes, so the
 *                 printed heads, the e-invoice items and its header totals all
 *                 agree to the paisa, and CGST + SGST is always the GST
 *   grand total   subtotal + GST rounded to the rupee, half-up; Rounded Off is
 *                 the difference and so is always within ±50 paise
 *
 * The client's own subtotal, GST and grand total are only checked against
 * these (checkClientTotals) and never printed.
 */

/** Articles of jewellery, gold and diamond: the code every app line carries. */
const JEWELLERY_HSN = '71131913';

/**
 * The chapter-71 headings this invoice bills, and the GST rate each carries.
 * Jewellery, goldsmiths' wares, articles of pearls or stones and imitation
 * jewellery are all 3%.
 */
const GST_RATE_BY_HSN_HEADING = { 7113: 3, 7114: 3, 7116: 3, 7117: 3 };

/** GST state codes and the state names printed beside them. */
const STATE_NAMES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  10: 'Bihar',
  11: 'Sikkim',
  12: 'Arunachal Pradesh',
  13: 'Nagaland',
  14: 'Manipur',
  15: 'Mizoram',
  16: 'Tripura',
  17: 'Meghalaya',
  18: 'Assam',
  19: 'West Bengal',
  20: 'Jharkhand',
  21: 'Odisha',
  22: 'Chhattisgarh',
  23: 'Madhya Pradesh',
  24: 'Gujarat',
  26: 'Dadra and Nagar Haveli and Daman and Diu',
  27: 'Maharashtra',
  29: 'Karnataka',
  30: 'Goa',
  31: 'Lakshadweep',
  32: 'Kerala',
  33: 'Tamil Nadu',
  34: 'Puducherry',
  35: 'Andaman and Nicobar Islands',
  36: 'Telangana',
  37: 'Andhra Pradesh',
  38: 'Ladakh',
  97: 'Other Territory',
};

/** NIC unit quantity codes (UQC) this invoice can register. */
const KNOWN_UQC = new Set(['GMS', 'CTS', 'NOS', 'PCS', 'OTH', 'SET', 'PRS', 'KGS', 'MGS', 'UNT']);

/** The app's units, and the usual spellings of them, as NIC UQC codes. */
const UQC_BY_UNIT = {
  g: 'GMS', gm: 'GMS', gms: 'GMS', gr: 'GMS', grm: 'GMS', grms: 'GMS', gram: 'GMS', grams: 'GMS',
  ct: 'CTS', cts: 'CTS', crt: 'CTS', carat: 'CTS', carats: 'CTS',
  pc: 'PCS', pcs: 'PCS', piece: 'PCS', pieces: 'PCS',
  no: 'NOS', nos: 'NOS', number: 'NOS', numbers: 'NOS',
  set: 'SET', sets: 'SET', pr: 'PRS', prs: 'PRS', pair: 'PRS', pairs: 'PRS',
  kg: 'KGS', kgs: 'KGS', mg: 'MGS', mgs: 'MGS',
};

/** A request the invoice cannot be issued from; answered with a 400. */
class InvoiceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvoiceInputError';
    this.status = 400;
    this.statusCode = 400;
  }
}

/** The state code a GSTIN starts with, when it is a real state's; else ''. */
const gstinStateCode = (gstin) => {
  const code = String(gstin || '').trim().slice(0, 2);
  return /^\d{2}$/.test(code) && STATE_NAMES[code] ? code : '';
};

/** The shop's own state: from its GSTIN, else its saved state code. */
const businessStateCode = (business) => {
  const fromGstin = gstinStateCode(business?.gstNumber);
  if (fromGstin) return fromGstin;
  const saved = String(business?.stateCode ?? '').trim();
  const padded = /^\d{1,2}$/.test(saved) ? saved.padStart(2, '0') : '';
  return STATE_NAMES[padded] ? padded : '';
};

const stateName = (code) => STATE_NAMES[code] || '';

/**
 * Place of supply, by the owner's rule: the state the buyer's GSTIN is
 * registered in, or the shop's own state for a walk-in (B2C) sale. Printed
 * as the state name with its code, e.g. "Delhi (07)".
 */
function placeOfSupplyFor({ customerGstin, business }) {
  const code = gstinStateCode(customerGstin) || businessStateCode(business);
  if (!code) return { code: '', name: '', display: '' };
  return { code, name: stateName(code), display: `${stateName(code)} (${code})` };
}

/**
 * Whether the invoice charges CGST + SGST rather than IGST. Per the client's
 * rule (Sep 2026) this follows the supplier's own GSTIN alone: a Delhi shop
 * (07) charges CGST + SGST and any other charges IGST.
 *
 * NOTE: statute decides this by the supplier's state against the place of
 * supply, so a Delhi shop billing a buyer registered in another state should
 * raise IGST, and a shop outside Delhi selling over its own counter should
 * raise CGST + SGST. Switching to that is this one function.
 */
const isIntraStateSupply = (business) => String(business?.gstNumber || '').trim().slice(0, 2) === '07';

/** 'labour', 'wastage' or 'goods', from an explicit kind or the description. */
const lineKind = (item) => {
  const kind = String(item?.kind || '').trim().toLowerCase();
  if (kind === 'labour' || kind === 'wastage') return kind;
  const description = String(item?.description || '').trim();
  if (/^(labour|labor|making)\b/i.test(description)) return 'labour';
  if (/^wastage\b/i.test(description)) return 'wastage';
  return 'goods';
};

/**
 * The UQC a line registers under: grams as GMS and carats as CTS, a counted
 * line as NOS, and a line billed by its amount alone (labour, a charge) as
 * OTH.
 */
const uqcFor = (item, kind, qty) => {
  if (kind === 'labour') return 'OTH';
  for (const given of [item?.uqc, item?.unit]) {
    const code = String(given || '').trim().toUpperCase();
    if (KNOWN_UQC.has(code)) return code;
  }
  for (const given of [item?.qty_unit, item?.qtyUnit, item?.unit]) {
    const unit = String(given || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (UQC_BY_UNIT[unit]) return UQC_BY_UNIT[unit];
  }
  return qty > 0 && Number.isInteger(qty) ? 'NOS' : 'OTH';
};

const describeLine = (item, n) => {
  const description = String(item?.description || '').trim();
  return description ? `Line ${n} (${description})` : `Line ${n}`;
};

/** A non-negative finite number from a request field; 0 when absent. */
const readAmount = (value, what) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvoiceInputError(`${what} must be a number of zero or more.`);
  }
  return n;
};

/**
 * Every figure of the invoice, from its line items.
 *
 * @param {object} args
 * @param {Array}   args.lineItems   the request's line_items
 * @param {number}  args.gstRate     the request's gst_rate (3 when absent)
 * @param {boolean} args.intraState  CGST + SGST when true, IGST otherwise
 * @returns {{ lines, gstRate, halfRate, subtotalPaise, cgstPaise, sgstPaise,
 *   igstPaise, gstPaise, grandPaise, roundedOffPaise }}
 *   Each line carries its kind, HSN, quantity, UQC, the amount billed
 *   (amountPaise), the gross Qty × Unit Price and discount the e-invoice
 *   registers, and its own CGST, SGST and IGST.
 * @throws {InvoiceInputError} for a negative figure, an HSN that is not
 *   jewellery, a rate that is not the jewellery rate, or a line sold by
 *   weight (grams or carats) that bills an amount on no weight
 */
function computeInvoiceFigures({ lineItems, gstRate = 3, intraState }) {
  if (!Array.isArray(lineItems)) {
    throw new InvoiceInputError('line_items array is required and must not be empty');
  }
  const rateGiven = gstRate === undefined || gstRate === null || gstRate === '' ? 3 : Number(gstRate);
  if (!Number.isFinite(rateGiven) || rateGiven < 0) {
    throw new InvoiceInputError('gst_rate must be a number.');
  }
  const rate = roundHalfUp(rateGiven, 2);
  const rateBasisPoints = toBasisPoints(rate);

  const lines = [];
  lineItems.forEach((item, index) => {
    const label = describeLine(item, index + 1);
    const qtyGiven = readAmount(item?.qty, `${label}: qty`);
    const amountGiven = readAmount(item?.amount, `${label}: amount`);
    const price = readAmount(item?.price, `${label}: price`);
    // A line with neither a quantity nor an amount is a blank row, not a sale.
    if (!(qtyGiven > 0 || amountGiven > 0)) return;

    const kind = lineKind(item);
    const hsn = String(item?.hsn ?? '').replace(/\D/g, '') || JEWELLERY_HSN;
    const heading = hsn.slice(0, 4);
    const hsnRate = GST_RATE_BY_HSN_HEADING[heading];
    if (hsnRate === undefined) {
      throw new InvoiceInputError(
        `${label} carries HSN ${hsn}, which is not a jewellery code. This invoice bills jewellery under HSN 7113.`,
      );
    }
    if (hsnRate !== rate) {
      throw new InvoiceInputError(`GST on jewellery (HSN ${heading}) is ${hsnRate}%; the request asked for ${rate}%.`);
    }

    const qty = roundHalfUp(qtyGiven, 3);
    const amountPaise = toPaise(amountGiven);
    const uqc = uqcFor(item, kind, qty);
    // Gold or a stone is sold by its weight. With none given it would be
    // registered as one gram (or carat) at the whole amount, so the invoice
    // is refused until the weight is on it: a piece priced on a net weight
    // worked out from the gross has that weight to bill, not 0.
    if ((uqc === 'GMS' || uqc === 'CTS') && !(qty > 0) && amountPaise > 0) {
      throw new InvoiceInputError(
        `${label} bills Rs ${paiseToRupees(amountPaise)} with no ${uqc === 'GMS' ? 'weight in grams' : 'weight in carats'}. Enter its weight on the card and generate the invoice again.`,
      );
    }
    // The e-invoice needs a quantity: a line billed by its amount alone
    // (labour, a charge) is one unit of it.
    const billedQty = qty > 0 && kind !== 'labour' ? qty : 1;

    // A line billed below its own Qty × Price carries a discount (a diamond
    // at a discount on its rate): the e-invoice registers the gross at the
    // list price with the discount beside it. Within a rupee is the line's
    // own rounding, not a discount; there the unit price is the billed
    // amount over the quantity, to the three places the IRP takes.
    const listPrice = roundHalfUp(price, 3);
    const listGrossPaise = toPaise(billedQty * listPrice);
    const discounted = qty > 0 && listPrice > 0 && listGrossPaise - amountPaise > 100;
    const unitPrice = discounted ? listPrice : roundHalfUp(paiseToRupees(amountPaise) / billedQty, 3);
    const grossPaise = discounted ? listGrossPaise : amountPaise;
    const discountPaise = discounted ? listGrossPaise - amountPaise : 0;

    const halfTaxPaise = intraState ? divHalfUp(amountPaise * rateBasisPoints, 20000) : 0;
    const igstPaise = intraState ? 0 : divHalfUp(amountPaise * rateBasisPoints, 10000);

    lines.push({
      index: lines.length + 1,
      item,
      kind,
      hsn,
      qty,
      billedQty,
      uqc,
      price,
      unitPrice,
      amountPaise,
      grossPaise,
      discountPaise,
      cgstPaise: halfTaxPaise,
      sgstPaise: halfTaxPaise,
      igstPaise,
    });
  });

  if (!lines.length) {
    throw new InvoiceInputError('line_items array is required and must not be empty');
  }

  const sum = (key) => lines.reduce((total, line) => total + line[key], 0);
  const subtotalPaise = sum('amountPaise');
  const cgstPaise = sum('cgstPaise');
  const sgstPaise = sum('sgstPaise');
  const igstPaise = sum('igstPaise');
  const gstPaise = cgstPaise + sgstPaise + igstPaise;
  const grandPaise = roundPaiseToRupee(subtotalPaise + gstPaise);
  const roundedOffPaise = grandPaise - (subtotalPaise + gstPaise);
  // Rounding to the rupee moves a total by at most 50 paise.
  if (Math.abs(roundedOffPaise) > 50) {
    throw new Error(`INVOICE_ROUND_OFF_OUT_OF_BOUNDS:${roundedOffPaise}`);
  }

  return {
    lines,
    gstRate: rate,
    halfRate: roundHalfUp(rate / 2, 2),
    subtotalPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    gstPaise,
    grandPaise,
    roundedOffPaise,
  };
}

const formatRupees = (paise) => {
  const [whole, decimals] = (Math.abs(paise) / 100).toFixed(2).split('.');
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  let grouped = '';
  while (rest.length > 2) {
    grouped = `,${rest.slice(-2)}${grouped}`;
    rest = rest.slice(0, -2);
  }
  grouped = rest + grouped;
  return `${paise < 0 ? '-' : ''}${grouped ? `${grouped},${last3}` : last3}.${decimals}`;
};

/**
 * Refuses a request whose own subtotal, GST or grand total is more than a
 * rupee away from what its line items come to: the app's figures are only
 * ever float noise and rupee rounding away from the server's, so a bigger
 * gap is a stale or inconsistent client, and the invoice must not be issued
 * from it. A figure the request leaves out is not checked.
 */
function checkClientTotals(body, figures) {
  const checks = [
    ['subtotal', 'subtotal', figures.subtotalPaise],
    ['gst_amount', 'GST', figures.gstPaise],
    ['grand_total', 'grand total', figures.grandPaise],
  ];
  for (const [key, label, serverPaise] of checks) {
    const raw = body?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const client = Number(raw);
    if (!Number.isFinite(client)) {
      throw new InvoiceInputError(`${key} must be a number.`);
    }
    const clientPaise = toPaise(client);
    if (Math.abs(clientPaise - serverPaise) > 100) {
      throw new InvoiceInputError(
        `The invoice ${label} does not match its line items: the lines come to ₹${formatRupees(serverPaise)}, `
          + `but the request says ₹${formatRupees(clientPaise)}. Refresh the invoice and try again.`,
      );
    }
  }
}

module.exports = {
  JEWELLERY_HSN,
  STATE_NAMES,
  InvoiceInputError,
  computeInvoiceFigures,
  checkClientTotals,
  placeOfSupplyFor,
  isIntraStateSupply,
  gstinStateCode,
  businessStateCode,
  stateName,
  lineKind,
  formatRupees,
};
