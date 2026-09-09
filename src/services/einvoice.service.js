const axios = require('axios');
const config = require('../config/env');
const gstService = require('./gst.service');

/**
 * Government e-invoicing (IRN + signed QR) through Sandbox (sandbox.co.in),
 * the same provider that does GST verification. Flow: the shared Sandbox API
 * session authenticates the taxpayer's own IRP credentials (the username and
 * password of the business's account on einvoice1.gst.gov.in, from env), the
 * invoice is registered in the NIC INV-01 shape, and the IRP answers with the
 * IRN, acknowledgement and the government-signed QR payload the printed
 * invoice must carry.
 *
 * E-invoicing applies to B2B documents only: an invoice with no buyer GSTIN
 * is not eligible and is skipped silently.
 *
 * The endpoint paths below follow Sandbox's e-invoice API convention. The
 * account's subscription was expired when this was written, so the first
 * live run should be watched: a 404 here means the path needs aligning with
 * the current Sandbox dashboard docs, not that the integration is wrong.
 */
const SANDBOX_BASE_URL = 'https://api.sandbox.co.in';
const EINVOICE_AUTH_PATH = '/gst/compliance/e-invoice/authenticate';
const EINVOICE_GENERATE_PATH = '/gst/compliance/e-invoice/generate';

/** NIC tokens last an hour; refresh a little early. */
let taxpayerToken = null;
let taxpayerTokenExpiry = 0;

const toTwo = (value) => Number(Number(value || 0).toFixed(2));

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

/**
 * Whether this document can be registered at all: the switch is on, the
 * taxpayer credentials exist, and the buyer has a GSTIN (B2B).
 */
function isEligible(payload) {
  return Boolean(
    config.einvoice.enabled &&
      config.einvoice.username &&
      config.einvoice.password &&
      String(payload?.gstin_number || '').trim() &&
      String(payload?.customer_gstin || '').trim(),
  );
}

/**
 * The NIC INV-01 document, built from the exact payload the PDF template
 * renders so the registered figures and the printed figures cannot drift.
 */
function buildInv01(payload, business) {
  const sellerGstin = String(payload.gstin_number || '').trim().toUpperCase();
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

async function getTaxpayerToken(deps) {
  if (taxpayerToken && Date.now() < taxpayerTokenExpiry) return taxpayerToken;

  const apiToken = await deps.getAccessToken();
  const response = await deps.axios.post(
    `${SANDBOX_BASE_URL}${EINVOICE_AUTH_PATH}`,
    { username: config.einvoice.username, password: config.einvoice.password, gstin: config.einvoice.gstin },
    {
      headers: {
        authorization: apiToken,
        'x-api-key': config.sandbox.apiKey,
        'x-api-version': config.sandbox.apiVersion,
        'Content-Type': 'application/json',
      },
    },
  );

  const data = response.data?.data || response.data || {};
  const token = data.AuthToken || data.auth_token || data.access_token;
  if (!token) throw new Error('EINVOICE_AUTH_NO_TOKEN');

  taxpayerToken = token;
  taxpayerTokenExpiry = Date.now() + 50 * 60 * 1000;
  return taxpayerToken;
}

/**
 * Registers the invoice at the IRP and returns { irn, ackNo, ackDt, signedQr }.
 * Throws on any failure; the caller decides that a failed registration must
 * never cost the customer their invoice.
 */
async function generateEInvoice({ payload, business }, deps = { axios, getAccessToken: gstService.getAccessToken }) {
  const inv01 = buildInv01(payload, business);
  const [apiToken, authToken] = [await deps.getAccessToken(), await getTaxpayerToken(deps)];

  const response = await deps.axios.post(`${SANDBOX_BASE_URL}${EINVOICE_GENERATE_PATH}`, inv01, {
    headers: {
      authorization: apiToken,
      'x-api-key': config.sandbox.apiKey,
      'x-api-version': config.sandbox.apiVersion,
      'auth-token': authToken,
      gstin: config.einvoice.gstin || inv01.SellerDtls.Gstin,
      'Content-Type': 'application/json',
    },
  });

  const data = response.data?.data || response.data || {};
  const irn = data.Irn || data.irn;
  const signedQr = data.SignedQRCode || data.signed_qr_code || '';
  if (!irn || !signedQr) {
    throw new Error(`EINVOICE_UNEXPECTED_RESPONSE:${JSON.stringify(data).slice(0, 200)}`);
  }

  console.info('[EINVOICE_GENERATED]', {
    invoiceNumber: inv01.DocDtls.No,
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
  buildInv01,
  extractPincode,
  generateEInvoice,
};
