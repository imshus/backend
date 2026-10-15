/**
 * The tax invoice's figures, its GST heads, place of supply and the INV-01
 * e-invoice built from it.
 *
 * Each test pins one audit finding (Oct 2026):
 *  - the server works out subtotal, GST and grand total from the line items
 *    and refuses a request more than a rupee away from them, or at a rate
 *    that is not the jewellery rate, before an invoice number is spent
 *  - a Delhi invoice prints CGST and SGST as two lines, and they are the
 *    heads the IRP is sent; CGST + SGST is always the GST
 *  - place of supply is the buyer GSTIN's state, or the shop's for a
 *    walk-in, printed as "State (code)"
 *  - INV-01 uses LglNm, a UQC per line, TotAmt = Qty × UnitPrice with any
 *    discount in Discount, per-line taxes summing to the heads, RndOffAmt
 *  - a wastage line bills like gold, so the subtotal is the MRP
 *  - every figure is rounded half-up exactly, in whole paise
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Liquid } = require('liquidjs');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'invoice.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);

const state = {
  business: null,
  numbersTaken: 0,
  created: [],
  rendered: [],
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: CONTROLLER,
    filename: CONTROLLER,
    paths: Module._nodeModulePaths(CONTROLLER_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/invoice.model', {
  create: async (doc) => {
    state.created.push(doc);
    return { ...doc, _id: `inv-${state.created.length}` };
  },
  findByIdAndUpdate: async () => ({}),
});
stub('qrcode', { toDataURL: async () => 'data:image/png;base64,qr' });
stub('../models/business.model', { findById: () => ({ lean: async () => state.business }) });
stub('../models/businessUser.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/employee.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/invoiceCounter.model', {
  generateInvoiceNumber: async () => {
    state.numbersTaken += 1;
    return `26-27/1015/${String(state.numbersTaken).padStart(5, '0')}`;
  },
  peekNextInvoiceNumber: async () => `26-27/1015/${String(state.numbersTaken + 1).padStart(5, '0')}`,
});
stub('../services/pdfmonkey.service', {
  generateInvoicePdf: async (payload) => {
    state.rendered.push(payload);
    return { downloadUrl: '', docId: '' };
  },
  getDownloadUrl: async () => '',
});
stub('../services/redis.service', {
  claimInvoiceToken: async () => false,
  setInvoicePdfCache: async () => {},
  getInvoicePdfCache: async () => null,
});
stub('../config/env', {
  publicBaseUrl: 'https://amitaash.com',
  invoicePdfCache: { maxBytes: 15 * 1024 * 1024 },
  einvoice: { credKey: '' },
  sandbox: {},
});
stub('../utils/apiResponse', {
  sendSuccess: (res, data, status = 200) => res.finish(status, data),
  sendError: (res, message, status = 400) => res.finish(status, { message }),
});

const { buildInvoicePayload, generateInvoice, previewInvoiceHtml } = require(CONTROLLER);
const { buildInv01 } = require('../src/services/einvoice.service');
const { toPaise } = require('../src/utils/money');

const DELHI_SHOP = {
  gstNumber: '07AAACR5055K1Z7',
  legalName: 'Pratham International Pvt Ltd',
  tradeName: 'Pratham International',
  stateName: 'Delhi',
  pincode: '110005',
  address: '12 Karol Bagh, New Delhi 110005',
};
const UP_SHOP = {
  gstNumber: '09AAACR5055K1Z3',
  legalName: 'Lucknow Gems',
  stateName: '',
  address: 'Hazratganj, Lucknow',
};
const UP_BUYER = '09AKFPV8673D2ZK';

const gold = (amount, qty = 10) => ({
  description: 'Gold (in grams)', qty, qty_unit: 'Gms.', hsn: '71131913', price: amount / qty, amount,
});
const labour = (amount) => ({
  description: 'Labour Charge', qty: 0, qty_unit: '', hsn: '71131913', price: amount, amount,
});

/** A request the way the app sends it: its own unrounded GST and total. */
const request = (lineItems, extra = {}) => {
  const subtotal = lineItems.reduce((sum, line) => sum + line.amount, 0);
  const gst = (subtotal * 3) / 100;
  return {
    customer_name: 'Garg Jewellers',
    customer_address: 'MG Road, Lucknow 226001',
    line_items: lineItems,
    subtotal,
    gst_rate: 3,
    gst_amount: gst,
    grand_total: subtotal + gst,
    ...extra,
  };
};

const payloadFor = (body, business = DELHI_SHOP) => buildInvoicePayload(body, {
  business,
  invoiceNumber: '26-27/1015/00001',
  invoiceDate: '15-10-2026',
});

const TEMPLATES = ['invoice-pdfmonkey.html', 'invoice-einvoice-pdfmonkey.html'];
const liquid = new Liquid();
const render = (payload, template = TEMPLATES[0]) => liquid.parseAndRenderSync(
  fs.readFileSync(path.join(__dirname, '..', 'templates', template), 'utf8'),
  payload,
);
/** The visible text of rendered HTML, one space between words. */
const text = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

const makeRes = () => ({
  statusCode: null,
  payload: null,
  finish(status, data) {
    this.statusCode = status;
    this.payload = data;
    return this;
  },
});
const reset = () => {
  state.business = DELHI_SHOP;
  state.numbersTaken = 0;
  state.created = [];
  state.rendered = [];
};
const generate = async (body) => {
  const res = makeRes();
  await generateInvoice({ user: { businessId: '507f1f77bcf86cd799439011' }, body }, res, (err) => { throw err; });
  return res;
};

// ── Server-side totals ───────────────────────────────────────────────────

test('a grand total that does not match the lines is refused, and no invoice number is spent', async () => {
  reset();
  // Lines 1,00,000 + 3% is 1,03,000; the request says 1,03,050. The old
  // server printed "Rounded Off (+) 50.00" and the IRP would reject it.
  const res = await generate(request([gold(100000)], { gst_amount: 3000, grand_total: 103050 }));
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /grand total does not match its line items/);
  assert.match(res.payload.message, /1,03,000\.00/);
  assert.match(res.payload.message, /1,03,050\.00/);
  assert.equal(state.numbersTaken, 0, 'no number consumed');
  assert.equal(state.created.length, 0, 'nothing stored');
});

test('a total that includes wastage the lines do not carry is refused, not absorbed as a Rounded Off', async () => {
  reset();
  // Gold 93,750 + labour 5,000 = 98,750, but the total is the 1,08,150 of an
  // MRP with 6,250 of wastage: the old server printed Rounded Off 6,437.50.
  const body = request([gold(93750), labour(5000)], { grand_total: 108150 });
  const res = await generate(body);
  assert.equal(res.statusCode, 400);
  assert.equal(state.numbersTaken, 0);
});

test('a zero GST against a taxed subtotal is refused', async () => {
  reset();
  const res = await generate(request([gold(90000)], { gst_amount: 0, grand_total: 92700 }));
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /GST does not match/);
  assert.equal(state.numbersTaken, 0);
});

test('only the jewellery rate is accepted, and only jewellery HSN codes', async () => {
  reset();
  const at9 = request([gold(100000)]);
  at9.gst_rate = 9;
  at9.gst_amount = 9000;
  at9.grand_total = 109000;
  const res = await generate(at9);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /HSN 7113\) is 3%; the request asked for 9%/);

  const jobWork = request([{ ...labour(5000), hsn: '9988' }]);
  const refused = await generate(jobWork);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.payload.message, /HSN 9988, which is not a jewellery code/);
  assert.equal(state.numbersTaken, 0);
});

test('a negative line is refused', async () => {
  reset();
  const res = await generate(request([gold(100000), { ...labour(-500) }]));
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /amount must be a number of zero or more/);
});

test('the app\'s own unrounded figures pass, and the server\'s are what is printed and stored', async () => {
  reset();
  // Subtotal 1,00,150 (IGST shop): GST 3,004.50, total 1,03,154.50 -> 1,03,155.
  state.business = UP_SHOP;
  const res = await generate(request([gold(100150)]));
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.grandTotal, 103155);
  const [stored] = state.created;
  assert.equal(stored.subtotal, 100150);
  assert.equal(stored.gstAmount, 3004.5);
  assert.equal(stored.igstAmount, 3004.5);
  assert.equal(stored.grandTotal, 103155);
  assert.equal(stored.roundedOff, 0.5);
  assert.equal(stored.amountInWords, 'One Lakh Three Thousand One Hundred Fifty Five Rupees Only');
  assert.equal(stored.invoiceNumber, '26-27/1015/00001');
});

test('the preview refuses what generation would refuse', async () => {
  reset();
  const res = makeRes();
  await previewInvoiceHtml({
    user: { businessId: '507f1f77bcf86cd799439011' },
    body: request([gold(100000)], { grand_total: 103050 }),
  }, res, (err) => { throw err; });
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /grand total does not match/);
});

// ── CGST / SGST ──────────────────────────────────────────────────────────

test('a Delhi invoice prints CGST and SGST as two lines, the same figures the IRP is sent', () => {
  // Subtotal 1,23,457: 1.5% is 1,851.855 a head -> 1,851.86 each, GST
  // 3,703.72, Rounded Off +0.28. The old print was one "GST @ 3.00 %
  // 3,703.71" line against a registered 1,851.86 + 1,851.86.
  const payload = payloadFor(request([gold(123457)]));
  assert.equal(payload.cgst_amount, 1851.86);
  assert.equal(payload.sgst_amount, 1851.86);
  assert.equal(payload.gst_amount, 3703.72);
  assert.equal(payload.rounded_off, 0.28);
  assert.equal(payload.grand_total, 127161);

  const doc = buildInv01(payload, DELHI_SHOP);
  assert.equal(doc.ValDtls.CgstVal, payload.cgst_amount);
  assert.equal(doc.ValDtls.SgstVal, payload.sgst_amount);
  assert.equal(doc.ValDtls.RndOffAmt, payload.rounded_off);
  assert.equal(doc.ValDtls.TotInvVal, 127161);

  for (const template of TEMPLATES) {
    const printed = text(render(payload, template));
    assert.match(printed, /Add : CGST @ 1\.50 % 1,851\.86/, template);
    assert.match(printed, /Add : SGST @ 1\.50 % 1,851\.86/, template);
    assert.doesNotMatch(printed, /Add : GST @/, template);
    assert.doesNotMatch(printed, /IGST/, template);
    assert.match(printed, /Rounded Off \(\+\) 0\.28/, template);
  }
});

test('outside Delhi the invoice prints IGST alone', () => {
  const payload = payloadFor(request([gold(123457)]), UP_SHOP);
  assert.equal(payload.igst_amount, 3703.71);
  assert.equal(payload.cgst_amount, 0);
  const printed = text(render(payload));
  assert.match(printed, /Add : IGST @ 3\.00 % 3,703\.71/);
  assert.doesNotMatch(printed, /CGST|SGST/);
});

test('an odd-paise half rounds up on both heads, so the heads always add up to the GST', () => {
  // 1,74,123 at 1.5% is 2,611.845: half-up is 2,611.85 each (the old round2
  // gave 2,611.84 each, 5,223.68 against a GST of 5,223.69).
  const payload = payloadFor(request([gold(174123)]));
  assert.equal(payload.cgst_amount, 2611.85);
  assert.equal(payload.sgst_amount, 2611.85);
  assert.equal(payload.gst_amount, 5223.7);
  // 50,001: 750.015 -> 750.02 each.
  const small = payloadFor(request([gold(50001)]));
  assert.equal(small.cgst_amount + small.sgst_amount, small.gst_amount);
  assert.equal(small.cgst_amount, 750.02);
});

// ── INV-01 ───────────────────────────────────────────────────────────────

test('INV-01 names the parties LglNm, never falls back to a two-letter NA, and leaves out a missing PIN', () => {
  const payload = payloadFor(request([gold(100000)], {
    customer_gstin: UP_BUYER,
    customer_name: 'Referred Jewels',
    customer_address: 'Aminabad, Lucknow',
  }));
  const doc = buildInv01(payload, { ...DELHI_SHOP, stateName: '' });
  assert.equal(doc.SellerDtls.LglNm, 'Pratham International Pvt Ltd');
  assert.equal(doc.BuyerDtls.LglNm, 'Referred Jewels');
  assert.ok(!('LglName' in doc.SellerDtls) && !('LglName' in doc.BuyerDtls));
  // Seller location from its GSTIN's state when the profile has none.
  assert.equal(doc.SellerDtls.Loc, 'Delhi');
  assert.equal(doc.BuyerDtls.Loc, 'Uttar Pradesh');
  assert.equal(doc.BuyerDtls.Pos, '09');
  assert.ok(!('Pin' in doc.BuyerDtls), 'no PIN in the address: Pin is left out, not sent as 0');
  for (const party of [doc.SellerDtls, doc.BuyerDtls]) {
    assert.ok(party.LglNm.length >= 3 && party.Loc.length >= 3);
    assert.ok(!Object.values(party).includes('NA'));
    assert.ok(!Object.values(party).includes(0));
  }
});

test('every line is registered with its unit: grams as GMS, carats as CTS, labour as OTH', () => {
  const payload = payloadFor(request([
    gold(93750),
    { description: 'Diamond (in carats)', qty: 0.37, qty_unit: 'CT', hsn: '71131913', price: 61111, amount: 20350 },
    { description: 'Colorstone (in carats)', qty: 1.56, qty_unit: 'CT', hsn: '71131913', price: 550, amount: 858 },
    labour(5000),
    { description: 'Hallmark', note: 'Other Charges', qty: 1, qty_unit: '', hsn: '71131913', price: 45, amount: 45 },
  ]));
  const doc = buildInv01(payload, DELHI_SHOP);
  const units = doc.ItemList.map((item) => [item.Unit, item.Qty]);
  assert.deepEqual(units, [['GMS', 10], ['CTS', 0.37], ['CTS', 1.56], ['OTH', 1], ['NOS', 1]]);
});

test('a discounted diamond registers TotAmt = Qty × UnitPrice with the discount beside it, and prints it', () => {
  // 0.37 ct at ₹61,111 less 10%: 22,611.07 gross, 2,261.07 off, 20,350 billed.
  const payload = payloadFor(request([
    gold(93750),
    { description: 'Diamond (in carats)', qty: 0.37, qty_unit: 'CT', hsn: '71131913', price: 61111, amount: 20350 },
  ]));
  const [, diamond] = buildInv01(payload, DELHI_SHOP).ItemList;
  assert.equal(diamond.Qty, 0.37);
  assert.equal(diamond.UnitPrice, 61111);
  assert.equal(diamond.TotAmt, 22611.07);
  assert.equal(diamond.Discount, 2261.07);
  assert.equal(diamond.AssAmt, 20350);
  assert.equal(toPaise(diamond.TotAmt) - toPaise(diamond.Discount), toPaise(diamond.AssAmt));

  const printed = text(render(payload));
  assert.match(printed, /Less discount @ 10\.00 % on 22,611\.07 : 2,261\.07/);
  // A line at its full price carries no discount.
  const [goldItem] = buildInv01(payload, DELHI_SHOP).ItemList;
  assert.equal(goldItem.Discount, undefined);
  assert.equal(goldItem.TotAmt, goldItem.AssAmt);
});

test('item taxes are each line\'s own and add up to the heads; the document foots with RndOffAmt', () => {
  // The audit's four lines: gold 55,556, diamond 20,350, labour 7,777,
  // hallmark 45. Prorating a pre-rounded total gave items summing to
  // 1,255.93 against CgstVal 1,255.92.
  const payload = payloadFor(request([
    gold(55556),
    { description: 'Diamond (in carats)', qty: 0.37, qty_unit: 'CT', hsn: '71131913', price: 61111, amount: 20350 },
    labour(7777),
    { description: 'Hallmark', qty: 1, qty_unit: '', hsn: '71131913', price: 45, amount: 45 },
  ]));
  const doc = buildInv01(payload, DELHI_SHOP);
  const sum = (key) => doc.ItemList.reduce((total, item) => total + toPaise(item[key]), 0);
  assert.equal(sum('CgstAmt'), toPaise(doc.ValDtls.CgstVal));
  assert.equal(sum('SgstAmt'), toPaise(doc.ValDtls.SgstVal));
  assert.equal(sum('AssAmt'), toPaise(doc.ValDtls.AssVal));
  assert.equal(sum('TotItemVal') + toPaise(doc.ValDtls.RndOffAmt), toPaise(doc.ValDtls.TotInvVal));
  assert.equal(doc.ValDtls.CgstVal, payload.cgst_amount);
  assert.equal(doc.ValDtls.RndOffAmt, payload.rounded_off);
});

/** Deterministic pseudo-random numbers (mulberry32). */
const seeded = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('across 3,000 random invoices the printed and registered figures agree to the paisa', () => {
  const random = seeded(20261015);
  const pick = (min, max) => min + random() * (max - min);
  for (let i = 0; i < 3000; i += 1) {
    const weight = Math.round(pick(1, 60) * 1000) / 1000;
    const lines = [gold(Math.round(pick(5000, 900000)), weight)];
    for (let d = Math.floor(pick(0, 4)); d > 0; d -= 1) {
      const carats = Math.round(pick(0.01, 2) * 1000) / 1000;
      const rate = Math.round(pick(500, 150000));
      const discount = [0, 5, 10, 33.33][Math.floor(pick(0, 4))];
      lines.push({
        description: 'Diamond (in carats)', qty: carats, qty_unit: 'CT', hsn: '71131913', price: rate,
        amount: Math.round(carats * rate * (1 - discount / 100)),
      });
    }
    if (random() < 0.8) lines.push(labour(Math.round(pick(100, 60000))));
    if (random() < 0.5) {
      const grams = Math.round(weight * pick(0.01, 0.12) * 1000) / 1000;
      lines.push({ description: 'Wastage', qty: grams, qty_unit: 'Gms.', hsn: '71131913', price: 12500, amount: Math.round(grams * 12500) });
    }
    const business = random() < 0.5 ? DELHI_SHOP : UP_SHOP;
    const payload = payloadFor(request(lines, { customer_gstin: random() < 0.5 ? UP_BUYER : '' }), business);
    const doc = buildInv01(payload, business);
    const p = toPaise;

    assert.equal(p(payload.cgst_amount) + p(payload.sgst_amount) + p(payload.igst_amount), p(payload.gst_amount));
    assert.equal(p(payload.cgst_amount), p(payload.sgst_amount));
    assert.ok(Math.abs(p(payload.rounded_off)) <= 50, `rounded off ${payload.rounded_off}`);
    assert.equal(
      p(payload.subtotal) + p(payload.gst_amount) + p(payload.rounded_off),
      p(payload.grand_total),
    );
    assert.equal(payload.grand_total, Math.round(payload.grand_total));

    const v = doc.ValDtls;
    assert.equal(p(v.AssVal) + p(v.CgstVal) + p(v.SgstVal) + p(v.IgstVal) + p(v.RndOffAmt), p(v.TotInvVal));
    assert.equal(v.TotInvVal, payload.grand_total);
    assert.equal(v.CgstVal, payload.cgst_amount);
    assert.equal(v.IgstVal, payload.igst_amount);
    const itemSum = (key) => doc.ItemList.reduce((total, item) => total + p(item[key] || 0), 0);
    assert.equal(itemSum('CgstAmt'), p(v.CgstVal));
    assert.equal(itemSum('SgstAmt'), p(v.SgstVal));
    assert.equal(itemSum('IgstAmt'), p(v.IgstVal));
    assert.equal(itemSum('AssAmt'), p(v.AssVal));
    for (const item of doc.ItemList) {
      assert.equal(p(item.TotAmt) - p(item.Discount || 0), p(item.AssAmt));
      if (item.Discount) assert.equal(p(item.TotAmt), p(item.Qty * item.UnitPrice));
      // Without a discount the unit price is the amount over the quantity,
      // to the IRP's three places.
      else assert.ok(Math.abs(item.Qty * item.UnitPrice - item.TotAmt) <= item.Qty * 0.0005 + 1e-6);
      assert.ok(/^\d+$/.test(item.HsnCd) && item.HsnCd.startsWith('7113'));
    }
  }
});

// ── Place of supply ──────────────────────────────────────────────────────

test('place of supply is the buyer GSTIN\'s state, else the shop\'s own, printed with its code', () => {
  const walkIn = payloadFor(request([gold(100000)], { place_of_supply: 'Goa' }));
  assert.equal(walkIn.place_of_supply, 'Delhi (07)', 'a walk-in: the shop\'s state; a typed place is not used');
  assert.match(text(render(walkIn)), /Place of Supply : Delhi \(07\)/);

  const b2b = payloadFor(request([gold(100000)], { customer_gstin: UP_BUYER }));
  assert.equal(b2b.place_of_supply, 'Uttar Pradesh (09)');
  assert.equal(b2b.place_of_supply_code, '09');
  assert.match(text(render(b2b)), /Place of Supply : Uttar Pradesh \(09\)/);
  assert.equal(buildInv01(b2b, DELHI_SHOP).BuyerDtls.Pos, '09');

  const upWalkIn = payloadFor(request([gold(100000)]), UP_SHOP);
  assert.equal(upWalkIn.place_of_supply, 'Uttar Pradesh (09)');

  // A shop without a GSTIN falls back to its saved state code.
  const unregistered = payloadFor(request([gold(100000)]), { stateCode: '27' });
  assert.equal(unregistered.place_of_supply, 'Maharashtra (27)');
});

// ── HSN, wastage, rounding ───────────────────────────────────────────────

test('the labour line prints the HSN it is registered under', () => {
  const payload = payloadFor(request([gold(93750), labour(5000)]));
  const html = render(payload);
  const labourRow = html.split('<tr>').find((row) => row.includes('Labour Charge'));
  assert.ok(labourRow.includes('71131913'), 'HSN printed on the labour row');
  const [, labourItem] = buildInv01(payload, DELHI_SHOP).ItemList;
  assert.equal(labourItem.HsnCd, payload.line_items[1].hsn);
  assert.equal(labourItem.HsnCd, '71131913');
});

test('a wastage line bills like gold, so the subtotal is the MRP the card showed', () => {
  // 10 g net at 18K on ₹1,25,000/10 g: gold 93,750; labour ₹500/g: 5,000;
  // wastage 5% = 0.5 g at the 24K ₹12,500/g: 6,250. MRP 1,05,000.
  const wastage = {
    description: 'Wastage', note: '5% of 10.000 g', qty: 0.5, qty_unit: 'Gms.', hsn: '71131913', price: 12500, amount: 6250,
  };
  const payload = payloadFor(request([gold(93750), labour(5000), wastage]));
  assert.equal(payload.subtotal, 105000);
  assert.equal(payload.gst_amount, 3150);
  assert.equal(payload.grand_total, 108150);
  assert.equal(payload.amount_in_words, 'One Lakh Eight Thousand One Hundred Fifty Rupees Only');

  const row = payload.line_items[2];
  assert.equal(row.kind, 'wastage');
  assert.equal(row.hsn, '71131913');
  assert.equal(row.uqc, 'GMS');
  assert.equal(row.qty_display, '0.500');
  assert.equal(row.unit_display, 'Gms.');
  const html = render(payload);
  const wastageRow = html.split('<tr>').find((r) => r.includes('Wastage'));
  assert.match(text(wastageRow), /Wastage 5% of 10\.000 g 71131913 0\.500 Gms\. 12,500\.00 6,250\.00/);

  const item = buildInv01(payload, DELHI_SHOP).ItemList[2];
  assert.deepEqual(
    [item.HsnCd, item.Unit, item.Qty, item.UnitPrice, item.AssAmt, item.GstRt, item.CgstAmt, item.SgstAmt],
    ['71131913', 'GMS', 0.5, 12500, 6250, 3, 93.75, 93.75],
  );
});

test('an amount exactly on a half rupee is kept to the paisa and its total rounds up', () => {
  // 0.284 ct × ₹87,500 less 5% = 23,607.50, which arrives as 23607.499999999996.
  const amount = 0.284 * 87500 - 0.284 * 87500 * 0.05;
  const payload = payloadFor(request([
    { description: 'Diamond (in carats)', qty: 0.284, qty_unit: 'CT', hsn: '71131913', price: 87500, amount },
  ]), UP_SHOP);
  assert.equal(payload.line_items[0].amount, 23607.5);
  assert.equal(payload.line_items[0].amount_display, '23,607.50');
  // 23,607.50 + 708.23 (3%, 708.225 half-up) = 24,315.73 -> 24,316.
  assert.equal(payload.igst_amount, 708.23);
  assert.equal(payload.grand_total, 24316);
});

test('Rounded Off never leaves ±50 paise and the grand total ties round up', () => {
  // Subtotal 50 at IGST 3%: 51.50 exactly -> 52 (+0.50).
  const tie = payloadFor(request([gold(50, 1)]), UP_SHOP);
  assert.equal(tie.grand_total, 52);
  assert.equal(tie.rounded_off, 0.5);
  for (let subtotal = 1; subtotal <= 20000; subtotal += 1) {
    const payload = payloadFor(request([gold(subtotal, 1)]), subtotal % 2 ? DELHI_SHOP : UP_SHOP);
    assert.ok(Math.abs(payload.rounded_off) <= 0.5, `subtotal ${subtotal}: ${payload.rounded_off}`);
  }
});
