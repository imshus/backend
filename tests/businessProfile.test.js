/**
 * GET /settings/business-profile — the business identity the Profile screen
 * shows. Pins which stored field becomes the displayed business name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'settings.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);

const state = { business: null, user: null };

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: CONTROLLER, filename: CONTROLLER, paths: Module._nodeModulePaths(CONTROLLER_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/formulaConfig.model', { findOne: async () => null });
stub('../models/dashboardMetrics.model', { findOne: async () => null });
stub('../models/business.model', {
  findById: () => ({ lean: async () => state.business }),
});
stub('../models/businessUser.model', {
  findById: () => ({ select: () => ({ lean: async () => state.user }) }),
});

const { getBusinessProfile } = require(CONTROLLER);

const makeRes = () => ({
  statusCode: null,
  payload: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.payload = body; return this; },
});

const call = async () => {
  const res = makeRes();
  await getBusinessProfile(
    { user: { businessId: 'b1', userId: 'u1' } },
    res,
  );
  return res;
};

test('the trade name is the business name when one is set', async () => {
  state.business = {
    _id: 'b1',
    tradeName: 'PRATHAM INTERNATIONAL',
    legalName: 'AMIT GUPTA',
    gstNumber: '07ADIPG0941R1Z8',
    address: 'MODEL TOWN, DELHI',
  };
  state.user = { phone: '9876543210', userId: 'amit.gupta' };

  const res = await call();

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.businessName, 'PRATHAM INTERNATIONAL');
  // The legal name stays available separately rather than being lost.
  assert.equal(res.payload.data.legalName, 'AMIT GUPTA');
});

test('a proprietorship with no trade name falls back to the legal name', async () => {
  state.business = {
    _id: 'b1',
    tradeName: '',
    legalName: 'AMIT GUPTA',
    gstNumber: '07ADIPG0941R1Z8',
    address: 'MODEL TOWN, DELHI',
  };
  state.user = { phone: '9876543210', userId: 'amit.gupta' };

  const res = await call();

  assert.equal(res.payload.data.businessName, 'AMIT GUPTA');
});

test('the response carries the GSTIN, address and the bank block', async () => {
  state.business = {
    _id: 'b1',
    tradeName: 'PRATHAM INTERNATIONAL',
    legalName: 'AMIT GUPTA',
    gstNumber: '07ADIPG0941R1Z8',
    address: 'MODEL TOWN, DELHI',
    companyType: 'Proprietorship',
    bankName: 'ICICI BANK',
    bankIfsc: 'ICIC0001694',
    invoiceTerms: ['Goods once sold will not be taken back.'],
  };
  state.user = { phone: '9876543210', userId: 'amit.gupta' };

  const { payload } = await call();

  assert.equal(payload.data.gstNumber, '07ADIPG0941R1Z8');
  assert.equal(payload.data.address, 'MODEL TOWN, DELHI');
  assert.equal(payload.data.businessType, 'Proprietorship');
  assert.equal(payload.data.bankName, 'ICICI BANK');
  assert.deepEqual(payload.data.invoiceTerms, ['Goods once sold will not be taken back.']);
  assert.equal(payload.data.phone, '9876543210');
  assert.equal(payload.data.loginId, 'amit.gupta');
});

test('a missing business is a 404, not an empty profile', async () => {
  state.business = null;
  state.user = null;
  const res = await call();
  assert.equal(res.statusCode, 404);
});
