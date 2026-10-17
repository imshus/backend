const mongoose = require('mongoose');
const { sendSuccess } = require('../utils/apiResponse');
const scanHistory = require('../services/scanHistory.service');

/**
 * GET /api/v1/history/scans?limit=30 — Settings -> History -> Tag scan
 * history: { items: [{ scanId, itemName, tagCode, finalMRP, createdAt }] },
 * newest first. The owner sees the shop's scans, an employee their own.
 * (Wishlist and Checkout history read GET /wishlist and GET /invoices.)
 */
const getScanHistory = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(String(req.user?.businessId || ''))) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    const items = await scanHistory.listScans(req.user, { limit: req.query?.limit });
    sendSuccess(res, { items });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getScanHistory,
};
