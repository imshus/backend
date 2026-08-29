const express = require('express');
const router = express.Router();
const scanController = require('../controllers/scan.controller');
const upload = require('../middleware/upload.middleware');
const { validate } = require('../middleware/validation.middleware');
const joi = require('joi');
const { authenticateJWT } = require('../middleware/auth.middleware');
const {
  attachLicenseContext,
  requireScannerAccess,
} = require('../middleware/license.middleware');

router.use(authenticateJWT);
router.use(attachLicenseContext);
router.use(requireScannerAccess);

const createScanSchema = joi.object({
  jewelleryType: joi.string().valid('DIAMOND', 'GOLD', 'SILVER', 'COLOUR_STONE').required(),
  scanType: joi.string().valid('SINGLE_SIDE', 'BOTH_SIDES', 'DOUBLE_SIDE').required()
});

const clarificationSchema = joi.object({
  confirmedMappings: joi.array().items(
    joi.object({
      abbreviation: joi.string().required(),
      mappedField: joi.string().required(),
      description: joi.string().optional().allow('')
    })
  ).required()
});

router.post('/', validate(createScanSchema), scanController.createScan);
router.post('/:scanId/front-image', upload.single('image'), scanController.uploadFrontImage);
router.post('/:scanId/back-image', upload.single('image'), scanController.uploadBackImage);
router.post('/:scanId/analyze', scanController.analyzeScan);

router.get('/:scanId/clarification', scanController.getClarification);
router.post('/:scanId/clarification', validate(clarificationSchema), scanController.submitClarification);

router.get('/:scanId/review', scanController.getReview);
router.post('/:scanId/review', scanController.submitReview);

const calculationController = require('../controllers/calculation.controller');
router.post('/:scanId/calculate', calculationController.calculateMRP);

module.exports = router;
