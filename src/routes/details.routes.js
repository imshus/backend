const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const config = require('../config/env');

const router = express.Router();

// Every business-readable GET endpoint, aggregated by GET /api/v1/details/all.
const ENDPOINTS = {
  business_profile: '/api/v1/settings/business-profile',
  gold_rates: '/api/v1/rates/gold',
  gold_tax_settings: '/api/v1/rates/gold/tax-settings',
  diamond_rates: '/api/v1/rates/diamond',
  colorstone_rates: '/api/v1/rates/colorstone',
  labour_rates: '/api/v1/rates/labour',
  invoices: '/api/v1/invoices',
  next_invoice_number: '/api/v1/invoices/preview/next-number',
  wishlist: '/api/v1/wishlist',
  employees: '/api/v1/employees',
  formula_settings: '/api/v1/settings/formula',
  matrices_settings: '/api/v1/settings/matrices',
  charge_names: '/api/v1/settings/charge-names',
  subscription_overview: '/api/v1/subscription/overview',
  scan_billing_history: '/api/v1/subscription/scan-billing',
  credit_transactions: '/api/v1/subscription/credit-transactions',
  payment_history: '/api/v1/payments/history',
};

// Loops back through the app's own HTTP endpoints so each controller's
// auth/RBAC/business scoping applies unchanged; per-endpoint failures land
// inline instead of failing the whole response.
router.get('/all', authenticateJWT, async (req, res) => {
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { authorization: req.headers.authorization };

  const entries = await Promise.all(
    Object.entries(ENDPOINTS).map(async ([key, path]) => {
      try {
        const r = await fetch(base + path, { headers });
        const body = await r.json().catch(() => null);
        return [key, r.ok ? body : { error: `HTTP ${r.status}`, detail: body }];
      } catch (err) {
        return [key, { error: err.message }];
      }
    })
  );

  res.json({ success: true, data: Object.fromEntries(entries) });
});

module.exports = router;
