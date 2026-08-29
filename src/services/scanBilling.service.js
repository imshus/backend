const ScanBilling = require('../models/scanBilling.model');
const mongoose = require('mongoose');
const licenseService = require('./license.service');
const walletService = require('./wallet.service');
const { calculateScanCharge } = require('./billing.service');
const billingConfigService = require('./billingConfig.service');

function isDuplicateKeyError(error) {
  return error?.code === 11000 || /E11000 duplicate key/i.test(String(error?.message || ''));
}

function isTransactionUnsupportedError(error) {
  const message = String(error?.message || '');
  return error?.code === 20 && /Transaction numbers are only allowed/i.test(message);
}

function isSuccessfulBilling(row) {
  return row && (!row.billingStatus || row.billingStatus === 'SUCCEEDED');
}

function buildBillingPayload({ scan, session, usage, chargeBreakdown, balanceBefore = 0, balanceAfter = 0, billingStatus = 'SUCCEEDED' }) {
  return {
    businessId: scan.businessId,
    userId: session?.userId || null,
    scanId: scan.scanId,
    model: usage.model,
    provider: usage.provider,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    inputCostUsd: chargeBreakdown.inputCostUsd,
    outputCostUsd: chargeBreakdown.outputCostUsd,
    totalUsd: chargeBreakdown.totalUsd,
    erf: chargeBreakdown.erf,
    lComp: chargeBreakdown.lComp,
    kComp: chargeBreakdown.kComp,
    aComp: chargeBreakdown.aComp,
    totalScanCharge: chargeBreakdown.totalScanCharge,
    billingStatus,
    failureReason: '',
    balanceBefore,
    balanceAfter,
    billedAt: new Date(),
  };
}

function readUsageFromAnalysis(analysisResult = {}) {
  const billingMeta = analysisResult.billingMeta || {};
  const promptTokens = Number(billingMeta.promptTokens ?? analysisResult.promptTokens ?? 0) || 0;
  const completionTokens = Number(billingMeta.completionTokens ?? analysisResult.completionTokens ?? 0) || 0;
  const model = String(billingMeta.model || analysisResult.model || '').trim();
  const provider = String(analysisResult.provider || billingMeta.provider || 'openai').trim();

  return {
    promptTokens,
    completionTokens,
    model,
    provider,
  };
}

async function billCompletedScan({ scan, analysisResult, session, precomputedOverview = null }) {
  if (!scan || !scan.scanId || !scan.businessId) {
    return null;
  }

  console.info('[BILLING_START]', { scanId: scan.scanId, businessId: String(scan.businessId) });

  const existing = await ScanBilling.findOne({ scanId: scan.scanId }).lean();
  if (isSuccessfulBilling(existing)) {
    console.info('[BILLING_IDEMPOTENCY_CHECK]', {
      scanId: scan.scanId,
      alreadyBilled: true,
    });
    return existing;
  }

  if (existing) {
    const err = new Error('BILLING_RECONCILIATION_REQUIRED');
    err.statusCode = 409;
    console.error('[BILLING_ERROR]', {
      scanId: scan.scanId,
      stage: 'idempotency_check',
      billingStatus: existing.billingStatus,
      error: err.message,
    });
    throw err;
  }

  const overview = precomputedOverview || await licenseService.getLicenseOverview(scan.businessId);
  if (!overview.scannerEnabled) {
    const err = new Error(overview.license?.trialExpiredAt ? 'TRIAL_EXPIRED' : 'TRIAL_REQUIRED');
    err.statusCode = 403;
    throw err;
  }

  const usage = readUsageFromAnalysis(analysisResult);
  const config = await billingConfigService.getEffectiveConfig();
  const chargeBreakdown = calculateScanCharge({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    erf: config.erf,
    inputTokenPricePerMillionUsd: config.inputTokenPricePerMillionUsd,
    outputTokenPricePerMillionUsd: config.outputTokenPricePerMillionUsd,
    kComp: config.kComp,
    aComp: config.aComp,
  });

  console.info('[BILLING_CALCULATION]', {
    scanId: scan.scanId,
    lComp: chargeBreakdown.lComp,
    kComp: chargeBreakdown.kComp,
    aComp: chargeBreakdown.aComp,
    scanCharge: chargeBreakdown.totalScanCharge,
  });

  const dbSession = await mongoose.startSession();
  let billing;

  try {
    await dbSession.withTransaction(async () => {
      const billed = await ScanBilling.findOne({ scanId: scan.scanId })
        .session(dbSession)
        .lean();
      console.info('[BILLING_IDEMPOTENCY_CHECK]', {
        scanId: scan.scanId,
        alreadyBilled: Boolean(billed),
      });

      if (billed) {
        billing = billed;
        return;
      }

      const walletBefore = await walletService.ensureWallet(scan.businessId, { dbSession });
      console.info('[WALLET_BEFORE]', {
        scanId: scan.scanId,
        balance: Number(walletBefore.creditBalance || 0),
      });

      const { balanceBefore, balanceAfter } = await walletService.deductScanCharge({
        businessId: scan.businessId,
        userId: session?.userId || null,
        actionByUserId: session?.userId || null,
        amount: chargeBreakdown.totalScanCharge,
        note: 'OCR scan billing deduction',
        metadata: {
          scanId: scan.scanId,
          model: usage.model,
          provider: usage.provider,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        },
        dbSession,
        effectiveConfig: config,
      });

      console.info('[WALLET_DEDUCTED]', {
        scanId: scan.scanId,
        deduction: chargeBreakdown.totalScanCharge,
        balanceBefore,
        balanceAfter,
      });

      const [created] = await ScanBilling.create([
        {
          ...buildBillingPayload({
            scan,
            session,
            usage,
            chargeBreakdown,
            balanceBefore,
            balanceAfter,
            billingStatus: 'SUCCEEDED',
          }),
        },
      ], { session: dbSession });

      billing = created;
      console.info('[BILLING_RECORD_CREATED]', { scanId: scan.scanId });
      console.info('[CREDIT_TRANSACTION_CREATED]', { scanId: scan.scanId });
      console.info('[USAGE_COUNTER_UPDATED]', { scanId: scan.scanId });
    });
  } catch (error) {
    if (isTransactionUnsupportedError(error)) {
      console.warn('[BILLING_TRANSACTION_UNAVAILABLE]', {
        scanId: scan.scanId,
        fallback: 'standalone_idempotent_flow',
        error: error?.message || String(error),
      });
      billing = await billCompletedScanWithoutTransaction({
        scan,
        session,
        usage,
        chargeBreakdown,
        effectiveConfig: config,
      });
      return billing;
    }

    if (isDuplicateKeyError(error)) {
      const billed = await ScanBilling.findOne({ scanId: scan.scanId }).lean();
      if (isSuccessfulBilling(billed)) {
        console.info('[BILLING_IDEMPOTENCY_CHECK]', {
          scanId: scan.scanId,
          alreadyBilled: true,
          recoveredFromDuplicateKey: true,
        });
        return billed;
      }
    }

    console.error('[BILLING_ERROR]', {
      scanId: scan.scanId,
      stage: 'transaction',
      error: error?.message || String(error),
    });
    throw error;
  } finally {
    await dbSession.endSession();
  }

  console.info('[BILLING_SUCCESS]', {
    scanId: scan.scanId,
    totalScanCharge: chargeBreakdown.totalScanCharge,
  });

  return billing;
}

async function billCompletedScanWithoutTransaction({ scan, session, usage, chargeBreakdown, effectiveConfig = null }) {
  let reservation;

  try {
    reservation = await ScanBilling.create(buildBillingPayload({
      scan,
      session,
      usage,
      chargeBreakdown,
      billingStatus: 'PENDING',
    }));
    console.info('[BILLING_RECORD_RESERVED]', { scanId: scan.scanId });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await ScanBilling.findOne({ scanId: scan.scanId }).lean();
      if (isSuccessfulBilling(existing)) {
        console.info('[BILLING_IDEMPOTENCY_CHECK]', {
          scanId: scan.scanId,
          alreadyBilled: true,
          recoveredFromDuplicateKey: true,
        });
        return existing;
      }
    }
    throw error;
  }

  try {
    const walletBefore = await walletService.ensureWallet(scan.businessId);
    console.info('[WALLET_BEFORE]', {
      scanId: scan.scanId,
      balance: Number(walletBefore.creditBalance || 0),
    });

    const { balanceBefore, balanceAfter } = await walletService.deductScanCharge({
      businessId: scan.businessId,
      userId: session?.userId || null,
      actionByUserId: session?.userId || null,
      amount: chargeBreakdown.totalScanCharge,
      note: 'OCR scan billing deduction',
      metadata: {
        scanId: scan.scanId,
        model: usage.model,
        provider: usage.provider,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
      effectiveConfig,
    });

    console.info('[WALLET_DEDUCTED]', {
      scanId: scan.scanId,
      deduction: chargeBreakdown.totalScanCharge,
      balanceBefore,
      balanceAfter,
    });

    const billing = await ScanBilling.findOneAndUpdate(
      { _id: reservation._id, billingStatus: 'PENDING' },
      {
        $set: {
          billingStatus: 'SUCCEEDED',
          failureReason: '',
          balanceBefore,
          balanceAfter,
          billedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );

    console.info('[BILLING_RECORD_CREATED]', { scanId: scan.scanId });
    console.info('[CREDIT_TRANSACTION_CREATED]', { scanId: scan.scanId });
    console.info('[USAGE_COUNTER_UPDATED]', { scanId: scan.scanId });
    console.info('[BILLING_SUCCESS]', {
      scanId: scan.scanId,
      totalScanCharge: chargeBreakdown.totalScanCharge,
      transactionMode: 'standalone_fallback',
    });

    return billing;
  } catch (error) {
    const nextStatus = error?.message === 'INSUFFICIENT_CREDITS'
      ? 'FAILED'
      : 'RECONCILIATION_REQUIRED';
    await ScanBilling.updateOne(
      { _id: reservation._id, billingStatus: 'PENDING' },
      {
        $set: {
          billingStatus: nextStatus,
          failureReason: error?.message || String(error),
        },
      },
    );

    console.error('[BILLING_ERROR]', {
      scanId: scan.scanId,
      stage: 'standalone_fallback',
      billingStatus: nextStatus,
      error: error?.message || String(error),
    });
    throw error;
  }
}

module.exports = {
  billCompletedScan,
};
