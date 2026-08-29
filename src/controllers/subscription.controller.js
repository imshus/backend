const { sendSuccess } = require('../utils/apiResponse');
const licenseService = require('../services/license.service');
const walletService = require('../services/wallet.service');
const creditService = require('../services/credit.service');
const ScanBilling = require('../models/scanBilling.model');
const CreditTransaction = require('../models/creditTransaction.model');
const billingConfigService = require('../services/billingConfig.service');
const paymentService = require('../services/payment.service');

async function getOverview(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const {
      license,
      licenseStatus,
      walletEnabled,
      scannerEnabled,
      rechargeEnabled,
      paymentHistoryEnabled,
      trialDaysRemaining,
      trialHoursRemaining,
    } = await licenseService.getLicenseOverview(businessId);
    const wallet = await walletService.ensureWallet(businessId);
    const cfg = await billingConfigService.getEffectiveConfig();
    const monthSummary = await paymentService.getMonthCostSummary({ businessId });

    let creditWarningLevel = 'NONE';
    const creditBalance = walletEnabled ? Number(wallet.creditBalance || 0) : 0;

    if (walletEnabled && creditBalance <= 0) {
      creditWarningLevel = 'BLOCKED';
    } else if (walletEnabled && creditBalance <= Number(cfg.criticalCreditThreshold || 10)) {
      creditWarningLevel = 'CRITICAL';
    } else if (walletEnabled && creditBalance <= Number(cfg.lowCreditThreshold || 20)) {
      creditWarningLevel = 'LOW';
    }

    sendSuccess(res, {
      licenseStatus,
      status: licenseStatus,
      walletEnabled,
      scannerEnabled,
      rechargeEnabled,
      paymentHistoryEnabled,
      trialDays: license.trialDays,
      trialCredits: license.trialCredits,
      trialStartDate: license.trialStartDate,
      trialEndDate: license.trialEndDate,
      trialExpiredAt: license.trialExpiredAt,
      trialDaysRemaining,
      trialHoursRemaining,
      purchaseAmount: license.purchaseAmount,
      purchaseDate: license.purchaseDate,
      permanentActivatedAt: license.permanentActivatedAt,
      purchaseOrderId: license.purchaseOrderId,
      purchasePaymentId: license.purchasePaymentId,
      purchaseInvoiceNumber: license.purchaseInvoiceNumber,
      applicationPurchased: license.licenseStatus === 'PERMANENT_LICENSE',
      bonusCredits: Number(cfg.purchasedBonusCredits || 1000),
      creditBalance: walletEnabled ? creditBalance : 0,
      lowCreditThreshold: Number(cfg.lowCreditThreshold || 20),
      criticalCreditThreshold: Number(cfg.criticalCreditThreshold || 10),
      creditWarningLevel,
      todayScans: walletEnabled ? monthSummary.todayScans : 0,
      monthScans: walletEnabled ? monthSummary.monthScans : 0,
      todayScanCost: walletEnabled ? monthSummary.todayScanCost : 0,
      currentMonthCost: walletEnabled ? monthSummary.currentMonthCost : 0,
      applicationPrice: Number(cfg.applicationPrice || 12000),
      freeTrialCreditsConfigured: Number(cfg.freeTrialCredits || 100),
      purchasedBonusCreditsConfigured: Number(cfg.purchasedBonusCredits || 1000),
      trialDaysConfigured: Number(cfg.trialDays || 10),
      lastScanCost: walletEnabled ? (wallet.lastScanCost || 0) : 0,
      lastScanAt: walletEnabled ? wallet.lastScanAt : null,
    });
  } catch (error) {
    next(error);
  }
}

async function startTrial(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const actorUserId = req.user.userId;

    const result = await licenseService.startTrialLicense(businessId, actorUserId);
    if (result.started && result.trialCreditsToGrant > 0) {
      await creditService.grantTrialCredits({
        businessId,
        actionByUserId: actorUserId,
        credits: result.trialCreditsToGrant,
        metadata: {
          licenseStatus: result.license.licenseStatus,
          reason: 'TRIAL_START',
        },
      });
    }

    const wallet = await walletService.ensureWallet(businessId);

    sendSuccess(res, {
      trialStarted: result.started,
      reason: result.reason || null,
      licenseStatus: result.license.licenseStatus,
      trialStartDate: result.license.trialStartDate,
      trialEndDate: result.license.trialEndDate,
      creditBalance: wallet.creditBalance,
    });
  } catch (error) {
    next(error);
  }
}

async function purchaseApplication(req, res, next) {
  const error = new Error('PURCHASE_VIA_PAYMENT_REQUIRED');
  error.statusCode = 400;
  next(error);
}

function resolveTargetBusinessId(req) {
  const requestedBusinessId = req.body?.businessId;
  if (requestedBusinessId) {
    return requestedBusinessId;
  }
  return req.user.businessId;
}

async function addCredits(req, res, next) {
  try {
    const businessId = resolveTargetBusinessId(req);
    const amount = Number(req.body?.amount || 0);
    const note = String(req.body?.note || 'Admin credit add');

    const wallet = await creditService.addCreditsByAdmin({
      businessId,
      actionByUserId: req.user.userId,
      amount,
      note,
    });

    sendSuccess(res, { creditBalance: wallet.creditBalance });
  } catch (error) {
    next(error);
  }
}

async function removeCredits(req, res, next) {
  try {
    const businessId = resolveTargetBusinessId(req);
    const amount = Number(req.body?.amount || 0);
    const note = String(req.body?.note || 'Admin credit remove');

    const wallet = await creditService.removeCreditsByAdmin({
      businessId,
      actionByUserId: req.user.userId,
      amount,
      note,
    });

    sendSuccess(res, { creditBalance: wallet.creditBalance });
  } catch (error) {
    next(error);
  }
}

async function setCredits(req, res, next) {
  try {
    const businessId = resolveTargetBusinessId(req);
    const targetAmount = Number(req.body?.amount || 0);
    const note = String(req.body?.note || 'Admin credit set');

    const wallet = await creditService.setCreditsByAdmin({
      businessId,
      actionByUserId: req.user.userId,
      targetAmount,
      note,
    });

    sendSuccess(res, { creditBalance: wallet.creditBalance });
  } catch (error) {
    next(error);
  }
}

async function resetCredits(req, res, next) {
  try {
    const businessId = resolveTargetBusinessId(req);
    const note = String(req.body?.note || 'Admin credit reset');

    const wallet = await creditService.resetCreditsByAdmin({
      businessId,
      actionByUserId: req.user.userId,
      note,
    });

    sendSuccess(res, { creditBalance: wallet.creditBalance });
  } catch (error) {
    next(error);
  }
}

async function getScanBillingHistory(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 20)));

    const rows = await ScanBilling.find({
      businessId,
      billingStatus: { $nin: ['PENDING', 'FAILED', 'RECONCILIATION_REQUIRED'] },
    })
      .sort({ billedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const safeRows = rows.map((row) => ({
      scanId: row.scanId,
      totalScanCharge: Number(row.totalScanCharge || 0),
      balanceBefore: Number(row.balanceBefore || 0),
      balanceAfter: Number(row.balanceAfter || 0),
      billedAt: row.billedAt || row.createdAt,
    }));

    sendSuccess(res, safeRows);
  } catch (error) {
    next(error);
  }
}

async function getCreditTransactionHistory(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 20)));
    const skip = (page - 1) * limit;

    const [rows, totalRecords] = await Promise.all([
      CreditTransaction.find({ businessId })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CreditTransaction.countDocuments({ businessId }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalRecords / limit));

    sendSuccess(res, {
      records: rows,
      page,
      limit,
      totalRecords,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOverview,
  startTrial,
  purchaseApplication,
  addCredits,
  removeCredits,
  setCredits,
  resetCredits,
  getScanBillingHistory,
  getCreditTransactionHistory,
};
