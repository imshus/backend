const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/env');
const {
  isEligible,
  buildInv01,
  extractPincode,
  encryptCredential,
  decryptCredential,
} = require('../src/services/einvoice.service');

const payload = {
  invoice_number: 'INV-20260909-00001',
  invoice_date: '09-09-2026',
  company_name: 'Pratham International',
  company_address: '12 Karol Bagh, New Delhi, 110005',
  gstin_number: '07AAACR5055K1Z7',
  customer_name: 'Referred Jewels',
  customer_address: 'MG Road, Lucknow 226001',
  customer_gstin: '09AKFPV8673D2ZK',
  place_of_supply: 'Uttar Pradesh',
  reverse_charge: 'N',
  subtotal: 100000,
  gst_rate: 3,
  cgst_amount: 1500,
  sgst_amount: 1500,
  igst_amount: 0,
  grand_total: 103000,
  line_items: [
    { description: 'Gold ring', hsn: '7113', qty: 1, unit: 'PCS', price: 60000, amount: 60000 },
    { description: 'Gold chain', qty: 1, price: 40000, amount: 40000 },
  ],
};

const business = { legalName: 'Pratham International Pvt Ltd', pincode: '110005', stateName: 'Delhi' };

test('pin codes come out of free-text addresses; the last run wins', () => {
  assert.equal(extractPincode('MG Road, Lucknow 226001'), '226001');
  assert.equal(extractPincode('H-12/110005 Karol Bagh, New Delhi, 110006'), '110006');
  assert.equal(extractPincode('no pin here'), '');
});

test('eligibility needs the business switch, its credentials, the server key, and a B2B buyer', () => {
  const saved = { ...config.einvoice };
  const ready = { eInvoiceEnabled: true, eInvoiceUsername: 'u', eInvoicePasswordEnc: 'iv:tag:data' };
  try {
    config.einvoice.credKey = 'test-key';
    assert.equal(isEligible(ready, payload), true);
    assert.equal(isEligible({ ...ready, eInvoiceEnabled: false }, payload), false);
    assert.equal(isEligible({ ...ready, eInvoicePasswordEnc: '' }, payload), false);
    assert.equal(isEligible(ready, { ...payload, customer_gstin: '' }), false);

    config.einvoice.credKey = '';
    assert.equal(isEligible(ready, payload), false);
  } finally {
    Object.assign(config.einvoice, saved);
  }
});

test('credentials survive an encrypt-decrypt round trip and need the key', () => {
  const saved = { ...config.einvoice };
  try {
    config.einvoice.credKey = 'test-key';
    const stored = encryptCredential('irp-secret-99');
    assert.ok(!stored.includes('irp-secret-99'));
    assert.equal(decryptCredential(stored), 'irp-secret-99');

    config.einvoice.credKey = '';
    assert.throws(() => encryptCredential('x'), /EINVOICE_CRED_KEY_MISSING/);
    assert.equal(decryptCredential(stored), '');
  } finally {
    Object.assign(config.einvoice, saved);
  }
});

test('the INV-01 document mirrors the printed invoice exactly', () => {
  const doc = buildInv01(payload, business);

  assert.equal(doc.Version, '1.1');
  assert.deepEqual(doc.DocDtls, { Typ: 'INV', No: 'INV-20260909-00001', Dt: '09/09/2026' });

  assert.equal(doc.SellerDtls.Gstin, '07AAACR5055K1Z7');
  assert.equal(doc.SellerDtls.Stcd, '07');
  assert.equal(doc.SellerDtls.Pin, 110005);

  assert.equal(doc.BuyerDtls.Gstin, '09AKFPV8673D2ZK');
  assert.equal(doc.BuyerDtls.Pos, '09');
  assert.equal(doc.BuyerDtls.Pin, 226001);

  assert.equal(doc.ItemList.length, 2);
  const [ring, chain] = doc.ItemList;
  assert.equal(ring.HsnCd, '7113');
  assert.equal(chain.HsnCd, '7113');
  assert.equal(ring.Unit, 'PCS');
  assert.equal(chain.Unit, 'NOS');
  // The tax splits proportionally over the two lines: 60/40.
  assert.equal(ring.CgstAmt, 900);
  assert.equal(ring.SgstAmt, 900);
  assert.equal(ring.IgstAmt, 0);
  assert.equal(ring.TotItemVal, 61800);
  assert.equal(chain.TotItemVal, 41200);

  assert.deepEqual(doc.ValDtls, {
    AssVal: 100000,
    CgstVal: 1500,
    SgstVal: 1500,
    IgstVal: 0,
    TotInvVal: 103000,
  });
});
