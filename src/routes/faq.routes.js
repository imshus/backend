const express = require('express');
const faqController = require('../controllers/faq.controller');

const router = express.Router();

// Open on purpose: help should be readable before anyone signs in, and the
// voice agent reads the same text.
router.get('/', faqController.listFaqs);

module.exports = router;
