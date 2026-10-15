const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/env');
const gstService = require('./gst.service');
const { toPaise, paiseToRupees } = require('../utils/money');
const { computeInvoiceFigures, placeOfSupplyFor, stateName } = require('./invoiceMath');

/**
 * Government e-invoicing (IRN + signed QR) through Sandbox (sandbox.co.in),
 * the same provider that does GST verification.
 *
 * MRPscan is multi-tenant: every registered jeweller has their own GSTIN, so
 * IRP credentials are PER BUSINESS — the owner creates an API user for their
 * GSTIN on einvoice1.gst.gov.in (Registration → API Registration → Through
 * GSP, selecting Sandbox's GSP) and saves the username and password in the
 * app. The password is encrypted at rest with EINVOICE_CRED_KEY; without
 * that key on the server, credentials cannot be saved at all.
 *
 * Flow per invoice: the shared Sandbox API session authenticates the
 * business's IRP credentials, the invoice is registered in the NIC INV-01
 * shape, and the IRP answers with the IRN, acknowledgement and the
 * government-signed QR the printed invoice must carry.
 *
 * E-invoicing applies to B2B documents only: an invoice with no buyer GSTIN
 * is not eligible and is skipped silently.
 *
 * The endpoint paths were verified against the live Sandbox API on
 * 2026-09-09: tax-payer/authenticate (with the mandatory `force` query
 * parameter) reached the real IRP — it answered NIC error 1017 for dummy
 * credentials — and tax-payer/invoice exists and demands a taxpayer token.
 * Responses arrive in the NIC envelope { Status, Data, ErrorDetails } inside
 * Sandbox's own { code, data } wrapper, and both layers are handled below.
 */
const SANDBOX_BASE_URL = 'https://api.sandbox.co.in';
const EINVOICE_AUTH_PATH = '/gst/compliance/e-invoice/tax-payer/authenticate';
const EINVOICE_GENERATE_PATH = '/gst/compliance/e-invoice/tax-payer/invoice';

/** Unwraps Sandbox's envelope and throws the NIC ErrorDetails when Status is 0. */
function unwrapNicResponse(response, context) {
  const outer = response.data?.data ?? response.data ?? {};
  if (String(outer.Status) === '0' || (Array.isArray(outer.ErrorDetails) && outer.ErrorDetails.length)) {
    const details = (outer.ErrorDetails || [])
      .map((e) => `${e.ErrorCode || ''} ${e.ErrorMessage || ''}`.trim())
      .join('; ');
    throw new Error(`EINVOICE_${context}_REJECTED:${details || 'Status 0'}`);
  }
  return outer.Data ?? outer;
}

const toTwo = (value) => Number(Number(value || 0).toFixed(2));

// ── Credential encryption ─────────────────────────────────────────────
// AES-256-GCM under a key derived from EINVOICE_CRED_KEY. The stored shape
// is iv:tag:ciphertext, hex. The password never leaves the server and no
// API returns it.

const credKey = () => {
  const secret = String(config.einvoice.credKey || '');
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
};

function encryptCredential(plain) {
  const key = credKey();
  if (!key) throw new Error('EINVOICE_CRED_KEY_MISSING');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function decryptCredential(stored) {
  const key = credKey();
  if (!key || !stored) return '';
  const [ivHex, tagHex, dataHex] = String(stored).split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** The last 6-digit run in a free-text address; Indian PIN codes never start with 0. */
function extractPincode(address) {
  const matches = String(address || '').match(/\b[1-9]\d{5}\b/g);
  return matches ? matches[matches.length - 1] : '';
}

/** DD/MM/YYYY from the invoice's printed DD-MM-YYYY date. */
function toNicDate(invoiceDate) {
  const parts = String(invoiceDate || '').split('-');
  return parts.length === 3 ? `${parts[0]}/${parts[1]}/${parts[2]}` : String(invoiceDate || '');
}

/** 'live' registers with the IRP; anything else prints a specimen band. */
function resolveMode(business) {
  return business?.eInvoiceMode === 'live' ? 'live' : 'test';
}

/**
 * Whether this document gets an e-invoice band at all. Both modes need a
 * B2B buyer (a GSTIN) and the shop's own GSTIN. Live additionally needs the
 * switch on, the shop's IRP credentials, and the server's encryption key.
 */
function isEligible(business, payload) {
  const sellerGstin = String(business?.gstNumber || payload?.gstin_number || '').trim();
  if (!sellerGstin) return false;
  // Test mode needs only the account: the specimen stands in the account's
  // own registered details wherever the buyer's are missing.
  if (resolveMode(business) === 'test') return true;
  const b2b = Boolean(String(payload?.customer_gstin || '').trim());
  return Boolean(
    b2b && business?.eInvoiceEnabled && business?.eInvoiceUsername && business?.eInvoicePasswordEnc && credKey(),
  );
}

/**
 * The specimen band for test mode: a deterministic dummy IRN in the real
 * 64-hex shape, a dummy acknowledgement, and a QR whose payload says in
 * plain words that nothing was registered — so a scan of it can never be
 * mistaken for a government-signed one.
 */
function generateTestEInvoice(payload, business) {
  const invoiceNumber = String(payload.invoice_number || '');
  // The account's registered GSTIN is the seller; without a buyer GSTIN the
  // specimen carries the account's own again, so the band is never blank.
  const gstin = String(business?.gstNumber || payload.gstin_number || '').toUpperCase();
  const buyerGstin = String(payload.customer_gstin || '').trim().toUpperCase() || gstin;
  const digest = crypto.createHash('sha256').update(`TEST|${gstin}|${invoiceNumber}`).digest('hex');
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  return {
    irn: digest,
    ackNo: String(parseInt(digest.slice(0, 12), 16)).padStart(15, '0').slice(0, 15),
    ackDt: `${dd}-${mm}-${today.getFullYear()}`,
    signedQr: [
      'MRPSCAN TEST E-INVOICE',
      'NOT REGISTERED WITH THE GOVERNMENT IRP',
      `Invoice ${invoiceNumber}`,
      `Seller ${gstin}`,
      `Buyer ${buyerGstin}`,
      `Total ${payload.grand_total}`,
    ].join(' | '),
    test: true,
  };
}

/** The NIC pattern for DocDtls.No: at most sixteen characters. */
const DOC_NO_PATTERN = /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/;

/** A NIC name or place: trimmed, cut to `max`, and never under three characters. */
const nicText = (value, max, fallback) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  return text.length >= 3 ? text : fallback;
};

/** A six-digit Indian PIN as a number, or undefined (the field is then left out). */
const nicPin = (value) => {
  const pin = String(value || '').trim();
  return /^[1-9]\d{5}$/.test(pin) ? Number(pin) : undefined;
};

/** An address as Addr1 and, when longer than a hundred characters, Addr2. */
const nicAddress = (address, fallback) => {
  const text = String(address || '').replace(/\s+/g, ' ').trim();
  if (!text) return { Addr1: fallback };
  if (text.length <= 100) return { Addr1: text };
  // Break at the last comma or space that keeps Addr1 within 100.
  const cut = Math.max(text.lastIndexOf(',', 100), text.lastIndexOf(' ', 100));
  const at = cut > 0 ? cut : 100;
  return {
    Addr1: text.slice(0, at).replace(/[,\s]+$/, ''),
    Addr2: text.slice(at).replace(/^[,\s]+/, '').slice(0, 100),
  };
};

/** Drops undefined fields, so an unknown optional value is absent rather than 0. */
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/**
 * The NIC INV-01 document, built from the exact payload the PDF template
 * renders, through the same figures function (services/invoiceMath.js), so
 * the registered figures and the printed figures cannot drift:
 *
 *  - each item's CGST, SGST and IGST is its own line tax, and ValDtls'
 *    heads are the sums of the items', which are the heads printed
 *  - TotAmt is Qty × UnitPrice; a line billed below its list price carries
 *    the difference as Discount, and AssAmt = TotAmt − Discount is the amount
 *    printed
 *  - RndOffAmt is the printed Rounded Off, so AssVal + the heads + RndOffAmt
 *    is TotInvVal to the paisa
 *  - HSN is the code printed on the line, Unit its UQC (GMS for grams, CTS
 *    for carats, OTH for labour), and Pos the printed place of supply
 */
function buildInv01(payload, business) {
  // The registered GSTIN from the business record is the e-invoice identity;
  // the payload copy (also profile-sourced) only fills in if it is missing.
  const sellerGstin = String(business?.gstNumber || payload.gstin_number || '').trim().toUpperCase();
  const buyerGstin = String(payload.customer_gstin || '').trim().toUpperCase();
  const sellerStateCode = sellerGstin.slice(0, 2);
  const buyerStateCode = buyerGstin.slice(0, 2);

  const intraState = typeof payload.is_intra_state === 'boolean'
    ? payload.is_intra_state
    : toTwo(payload.cgst_amount) > 0 || toTwo(payload.sgst_amount) > 0;
  const figures = computeInvoiceFigures({
    lineItems: payload.line_items || [],
    gstRate: payload.gst_rate,
    intraState,
  });
  const rupees = paiseToRupees;

  const items = figures.lines.map((line) => compact({
    SlNo: String(line.index),
    PrdDesc: String(line.item.description || 'Jewellery').slice(0, 300),
    IsServc: 'N',
    HsnCd: line.hsn,
    Qty: line.billedQty,
    Unit: line.uqc,
    UnitPrice: line.unitPrice,
    TotAmt: rupees(line.grossPaise),
    Discount: line.discountPaise > 0 ? rupees(line.discountPaise) : undefined,
    AssAmt: rupees(line.amountPaise),
    GstRt: figures.gstRate,
    CgstAmt: rupees(line.cgstPaise),
    SgstAmt: rupees(line.sgstPaise),
    IgstAmt: rupees(line.igstPaise),
    TotItemVal: rupees(line.amountPaise + line.cgstPaise + line.sgstPaise + line.igstPaise),
  }));

  // The grand total printed. RndOffAmt is what takes the items to it: the
  // printed Rounded Off, within ±50 paise.
  const itemsTotalPaise = figures.subtotalPaise + figures.gstPaise;
  const totalPaise = payload.grand_total !== undefined && payload.grand_total !== null
    ? toPaise(payload.grand_total)
    : figures.grandPaise;

  // Place of supply: the state printed on the invoice (the buyer GSTIN's for
  // a B2B sale), with its name as the buyer's location.
  const posCode = String(payload.place_of_supply_code || '').trim()
    || placeOfSupplyFor({ customerGstin: buyerGstin, business }).code;
  const posName = stateName(posCode);
  const sellerStateName = stateName(sellerStateCode);

  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: payload.reverse_charge === 'Y' ? 'Y' : 'N' },
    DocDtls: { Typ: 'INV', No: String(payload.invoice_number || ''), Dt: toNicDate(payload.invoice_date) },
    SellerDtls: compact({
      Gstin: sellerGstin,
      LglNm: nicText(business?.legalName || payload.company_name, 100, sellerGstin),
      TrdNm: business?.tradeName ? String(business.tradeName).trim().slice(0, 100) || undefined : undefined,
      ...nicAddress(payload.company_address || business?.address, sellerStateName || sellerGstin),
      Loc: nicText(business?.stateName || sellerStateName, 50, sellerStateName || sellerGstin),
      Pin: nicPin(business?.pincode) ?? nicPin(extractPincode(payload.company_address)),
      Stcd: sellerStateCode,
    }),
    BuyerDtls: compact({
      Gstin: buyerGstin,
      // A name under three characters still identifies the party with its GSTIN.
      LglNm: nicText(payload.customer_name, 100, `${String(payload.customer_name || '').trim()} ${buyerGstin}`.trim()),
      Pos: posCode,
      ...nicAddress(payload.customer_address, posName || buyerGstin),
      Loc: posName || nicText(payload.customer_address, 50, buyerGstin),
      // Optional for a buyer: left out unless the address carries a real PIN.
      Pin: nicPin(extractPincode(payload.customer_address)),
      Stcd: buyerStateCode,
    }),
    ItemList: items,
    ValDtls: {
      AssVal: rupees(figures.subtotalPaise),
      CgstVal: rupees(figures.cgstPaise),
      SgstVal: rupees(figures.sgstPaise),
      IgstVal: rupees(figures.igstPaise),
      RndOffAmt: rupees(totalPaise - itemsTotalPaise),
      TotInvVal: rupees(totalPaise),
    },
  };
}

/** One taxpayer session per GSTIN; NIC tokens last an hour, refreshed early. */
const taxpayerTokens = new Map();

async function getTaxpayerToken(business, deps) {
  const gstin = String(business.gstNumber || '').trim().toUpperCase();
  const cached = taxpayerTokens.get(gstin);
  if (cached && Date.now() < cached.expiry) return cached.token;

  const apiToken = await deps.getAccessToken();
  const response = await deps.axios.post(
    `${SANDBOX_BASE_URL}${EINVOICE_AUTH_PATH}`,
    {
      username: business.eInvoiceUsername,
      password: decryptCredential(business.eInvoicePasswordEnc),
      gstin,
    },
    {
      // `force` is mandatory; false reuses NIC's active session when one exists.
      params: { force: false },
      headers: {
        authorization: apiToken,
        'x-api-key': config.sandbox.apiKey,
        'x-api-version': config.sandbox.apiVersion,
        'Content-Type': 'application/json',
      },
    },
  );

  const data = unwrapNicResponse(response, 'AUTH');
  const token = data.AuthToken || data.auth_token || data.access_token;
  if (!token) throw new Error('EINVOICE_AUTH_NO_TOKEN');

  taxpayerTokens.set(gstin, { token, expiry: Date.now() + 50 * 60 * 1000 });
  return token;
}

/**
 * Registers the invoice at the IRP with the business's own credentials and
 * returns { irn, ackNo, ackDt, signedQr }. Throws on any failure; the caller
 * decides that a failed registration must never cost the customer their
 * invoice.
 */
async function generateEInvoice({ payload, business }, deps = { axios, getAccessToken: gstService.getAccessToken }) {
  const inv01 = buildInv01(payload, business);
  // Refused here, with the reason, rather than by the IRP's schema check: an
  // invoice numbered before numbers were cut to sixteen characters cannot be
  // registered under that number.
  if (!DOC_NO_PATTERN.test(inv01.DocDtls.No)) {
    throw new Error(`EINVOICE_DOC_NO_INVALID:${inv01.DocDtls.No} is not a 1-16 character document number`);
  }
  const apiToken = await deps.getAccessToken();
  const authToken = await getTaxpayerToken(business, deps);

  const response = await deps.axios.post(`${SANDBOX_BASE_URL}${EINVOICE_GENERATE_PATH}`, inv01, {
    headers: {
      authorization: apiToken,
      'x-api-key': config.sandbox.apiKey,
      'x-api-version': config.sandbox.apiVersion,
      'auth-token': authToken,
      gstin: inv01.SellerDtls.Gstin,
      'Content-Type': 'application/json',
    },
  });

  const data = unwrapNicResponse(response, 'GENERATE');
  const irn = data.Irn || data.irn;
  const signedQr = data.SignedQRCode || data.signed_qr_code || '';
  if (!irn || !signedQr) {
    throw new Error(`EINVOICE_UNEXPECTED_RESPONSE:${JSON.stringify(data).slice(0, 200)}`);
  }

  console.info('[EINVOICE_GENERATED]', {
    invoiceNumber: inv01.DocDtls.No,
    gstin: inv01.SellerDtls.Gstin,
    irn: String(irn).slice(0, 16) + '…',
    ackNo: data.AckNo || data.ack_no || null,
  });

  return {
    irn: String(irn),
    ackNo: String(data.AckNo || data.ack_no || ''),
    ackDt: String(data.AckDt || data.ack_dt || ''),
    signedQr: String(signedQr),
  };
}

module.exports = {
  isEligible,
  resolveMode,
  buildInv01,
  extractPincode,
  encryptCredential,
  decryptCredential,
  generateEInvoice,
  generateTestEInvoice,
};
