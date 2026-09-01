const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoice.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

// GET /api/v1/invoices/p/:token – the address printed as a QR code on the
// invoice. Declared before the JWT guard because whoever holds the paper
// invoice is not logged in; the random token is what authorises the read.
router.get('/p/:token', invoiceController.getPublicInvoice);

// Every other invoice route requires a valid JWT
router.use(authenticateJWT);

// POST /api/v1/invoices/reserve-qr – the token and QR the next invoice will
// carry, so the preview shows the same code the PDF ends up printing
router.post('/reserve-qr', invoiceController.reserveInvoiceQr);

// POST /api/v1/invoices/preview-html – the invoice rendered from the same
// template the PDF uses, for on-screen preview. Persists nothing.
router.post('/preview-html', invoiceController.previewInvoiceHtml);

// POST /api/v1/invoices/generate  – generate PDF invoice via PDFMonkey
router.post('/generate', invoiceController.generateInvoice);

// GET  /api/v1/invoices/preview/next-number - peek next invoice number
router.get('/preview/next-number', invoiceController.getNextInvoiceNumber);

// GET  /api/v1/invoices            – list invoices for business
router.get('/', invoiceController.getInvoices);

// GET  /api/v1/invoices/:id        – get single invoice
router.get('/:id', invoiceController.getInvoice);

module.exports = router;
