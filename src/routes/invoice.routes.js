const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoice.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

// All invoice routes require a valid JWT
router.use(authenticateJWT);

// POST /api/v1/invoices/generate  – generate PDF invoice via PDFMonkey
router.post('/generate', invoiceController.generateInvoice);

// GET  /api/v1/invoices/preview/next-number - peek next invoice number
router.get('/preview/next-number', invoiceController.getNextInvoiceNumber);

// GET  /api/v1/invoices            – list invoices for business
router.get('/', invoiceController.getInvoices);

// GET  /api/v1/invoices/:id        – get single invoice
router.get('/:id', invoiceController.getInvoice);

module.exports = router;
