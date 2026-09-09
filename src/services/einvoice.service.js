const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/env');
const gstService = require('./gst.service');

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
  const b2b = Boolean(
    String(payload?.gstin_number || '').trim() && String(payload?.customer_gstin || '').trim(),
  );
  if (!b2b) return false;
  if (resolveMode(business) === 'test') return true;
  return Boolean(
    business?.eInvoiceEnabled && business?.eInvoiceUsername && business?.eInvoicePasswordEnc && credKey(),
  );
}

/**
 * The specimen band for test mode: a deterministic dummy IRN in the real
 * 64-hex shape, a dummy acknowledgement, and a QR whose payload says in
 * plain words that nothing was registered — so a scan of it can never be
 * mistaken for a government-signed one.
 */
function generateTestEInvoice(payload) {
  const invoiceNumber = String(payload.invoice_number || '');
  const gstin = String(payload.gstin_number || '').toUpperCase();
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
      `Buyer ${String(payload.customer_gstin || '').toUpperCase()}`,
      `Total ${payload.grand_total}`,
    ].join(' | '),
    test: true,
  };
}

/**
 * The NIC INV-01 document, built from the exact payload the PDF template
 * renders so the registered figures and the printed figures cannot drift.
 */
function buildInv01(payload, business) {
  // The registered GSTIN from the business record is the e-invoice identity;
  // the payload copy (also profile-sourced) only fills in if it is missing.
  const sellerGstin = String(business?.gstNumber || payload.gstin_number || '').trim().toUpperCase();
  const buyerGstin = String(payload.customer_gstin || '').trim().toUpperCase();
  const sellerPin = String(business?.pincode || '').trim() || extractPincode(payload.company_address);
  const buyerPin = extractPincode(payload.customer_address);

  const subtotal = toTwo(payload.subtotal);
  const cgst = toTwo(payload.cgst_amount);
  const sgst = toTwo(payload.sgst_amount);
  const igst = toTwo(payload.igst_amount);
  const total = toTwo(payload.grand_total);

  const items = (payload.line_items || []).map((item, index) => {
    const amount = toTwo(item.amount);
    const share = subtotal > 0 ? amount / subtotal : 0;
    const itemCgst = toTwo(cgst * share);
    const itemSgst = toTwo(sgst * share);
    const itemIgst = toTwo(igst * share);
    return {
      SlNo: String(index + 1),
      PrdDesc: String(item.description || 'Jewellery').slice(0, 300),
      IsServc: 'N',
      // 7113: articles of jewellery — the default when a line carries none.
      HsnCd: String(item.hsn || '7113').replace(/\D/g, '') || '7113',
      Qty: Number(item.qty) || 1,
      Unit: String(item.unit || 'NOS').toUpperCase().slice(0, 8) || 'NOS',
      UnitPrice: toTwo(item.price),
      TotAmt: amount,
      AssAmt: amount,
      GstRt: toTwo(payload.gst_rate),
      CgstAmt: itemCgst,
      SgstAmt: itemSgst,
      IgstAmt: itemIgst,
      TotItemVal: toTwo(amount + itemCgst + itemSgst + itemIgst),
    };
  });

  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: payload.reverse_charge === 'Y' ? 'Y' : 'N' },
    DocDtls: { Typ: 'INV', No: String(payload.invoice_number || ''), Dt: toNicDate(payload.invoice_date) },
    SellerDtls: {
      Gstin: sellerGstin,
      LglName: String(business?.legalName || payload.company_name || '').slice(0, 100),
      Addr1: String(payload.company_address || '').slice(0, 100) || 'NA',
      Loc: String(business?.stateName || 'NA').slice(0, 50) || 'NA',
      Pin: Number(sellerPin) || 0,
      Stcd: sellerGstin.slice(0, 2),
    },
    BuyerDtls: {
      Gstin: buyerGstin,
      LglName: String(payload.customer_name || '').slice(0, 100) || 'NA',
      Pos: buyerGstin.slice(0, 2),
      Addr1: String(payload.customer_address || '').slice(0, 100) || 'NA',
      Loc: String(payload.place_of_supply || 'NA').slice(0, 50) || 'NA',
      Pin: Number(buyerPin) || 0,
      Stcd: buyerGstin.slice(0, 2),
    },
    ItemList: items,
    ValDtls: {
      AssVal: subtotal,
      CgstVal: cgst,
      SgstVal: sgst,
      IgstVal: igst,
      TotInvVal: total,
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
