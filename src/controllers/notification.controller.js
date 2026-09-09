const { sendSuccess } = require('../utils/apiResponse');
const CreditTransaction = require('../models/creditTransaction.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const Business = require('../models/business.model');
const licenseService = require('../services/license.service');
const walletService = require('../services/wallet.service');
const billingConfigService = require('../services/billingConfig.service');
const { isOwnerRole } = require('../services/userScope.service');

const rupees = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;

const bold = (text) => ({ text, bold: true });
const plain = (text) => ({ text });

/**
 * GET /api/v1/notifications
 *
 * The bell's feed, derived from what already happened rather than stored
 * separately: referral rewards from the credit ledger (with the balance each
 * one left behind), a low-balance warning, and a trial-ending reminder.
 * Owners see the business's referral rewards; an employee sees the ones
 * their own code earned.
 */
const getNotifications = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const owner = isOwnerRole(req.user.role);

    const [rewards, payments, wallet, cfg, overview] = await Promise.all([
      CreditTransaction.find({
        businessId,
        type: 'REFERRAL_BONUS',
        ...(owner ? {} : { userId: req.user.userId }),
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      // Razorpay purchases: the licence itself and credit recharges. Owners
      // only — payments are the shop's money, not an employee's feed.
      owner
        ? PaymentTransaction.find({ businessId, status: 'PAYMENT_SUCCESS' })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean()
        : Promise.resolve([]),
      walletService.ensureWallet(businessId),
      billingConfigService.getEffectiveConfig(),
      licenseService.getLicenseOverview(businessId),
    ]);

    const referredIds = rewards
      .map((txn) => txn.metadata?.referredBusinessId)
      .filter(Boolean);
    const referredBusinesses = referredIds.length
      ? await Business.find({ _id: { $in: referredIds } }).select('tradeName legalName').lean()
      : [];
    const nameById = new Map(
      referredBusinesses.map((b) => [String(b._id), b.tradeName || b.legalName || 'A referred shop']),
    );

    const items = rewards.map((txn) => {
      const name = nameById.get(String(txn.metadata?.referredBusinessId || '')) || 'A referred shop';
      const credits = Math.round(Number(txn.amount) || 0);
      const balance = Math.round(Number(txn.balanceAfter) || 0);
      const purchase = txn.metadata?.tier === 'PURCHASE';
      return {
        id: `reward-${txn._id}`,
        kind: purchase ? 'referral_purchase' : 'referral_invite',
        at: txn.createdAt,
        segments: purchase
          ? [
              plain('Congratulations! '),
              bold(`${credits} credits`),
              plain(' have been credited to your account — '),
              bold(name),
              plain(' made a purchase using your referral link. You have '),
              bold(`${balance} credits`),
              plain(' left.'),
            ]
          : [
              plain('You earned '),
              bold(`${credits} credits`),
              plain(' — '),
              bold(name),
              plain(' installed MRPscan using your invite link. You have '),
              bold(`${balance} credits`),
              plain(' left.'),
            ],
      };
    });

    for (const txn of payments) {
      if (txn.paymentType === 'APPLICATION_PURCHASE') {
        items.push({
          id: `payment-${txn._id}`,
          kind: 'license_purchased',
          at: txn.createdAt,
          segments: [
            plain('Licence purchased! Your payment of '),
            bold(rupees(txn.amount)),
            plain(' via Razorpay is confirmed — lifetime access is active and '),
            bold(`${Math.round(Number(cfg.purchasedBonusCredits || 1000))} bonus credits`),
            plain(' were added to your wallet.'),
          ],
        });
      } else if (txn.paymentType === 'CREDIT_RECHARGE') {
        items.push({
          id: `payment-${txn._id}`,
          kind: 'credits_purchased',
          at: txn.createdAt,
          segments: [
            plain('You purchased '),
            bold(`${Math.round(Number(txn.creditsPurchased) || 0)} credits`),
            plain(' for '),
            bold(rupees(txn.amount)),
            plain(' via Razorpay. Happy scanning!'),
          ],
        });
      }
    }

    const balance = Math.round(Number(wallet.creditBalance) || 0);
    const lowThreshold = Number(cfg.lowCreditThreshold || 20);
    if (overview.hasActiveLicense && balance > 0 && balance <= lowThreshold) {
      items.push({
        id: 'low-credit',
        kind: 'low_credit',
        at: wallet.updatedAt || new Date(),
        segments: [
          plain('Your credit balance is running low — only '),
          bold(`${balance} credits`),
          plain(' left. Recharge now to keep scanning without interruption.'),
        ],
      });
    }

    if (overview.licenseStatus === 'FREE_TRIAL_LICENSE' && overview.trialDaysRemaining <= 3) {
      items.push({
        id: 'trial-ending',
        kind: 'trial_ending',
        at: new Date(),
        segments: [
          plain('Your free trial ends in '),
          bold(`${overview.trialDaysRemaining} days`),
          plain('. Upgrade to a Subscription for lifetime access.'),
        ],
      });
    }

    if (overview.license?.trialExpiredAt && overview.licenseStatus === 'NO_LICENSE') {
      items.push({
        id: 'trial-ended',
        kind: 'trial_ending',
        at: overview.license.trialExpiredAt,
        segments: [
          plain('Your free trial has ended. Purchase the '),
          bold('Subscription'),
          plain(' to keep scanning with lifetime access.'),
        ],
      });
    }

    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    sendSuccess(res, { notifications: items.slice(0, 20) });
  } catch (error) {
    console.error('Get Notifications Error:', error);
    res.status(500).json({ success: false, message: 'Failed to load notifications' });
  }
};

module.exports = { getNotifications };
