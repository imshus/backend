const walletService = require('./wallet.service');

async function grantTrialCredits({ businessId, actionByUserId, credits, note = 'Free trial credits granted', metadata = {} }) {
  return walletService.addCredits({
    businessId,
    amount: credits,
    actionByUserId,
    type: 'TRIAL_CREDIT',
    note,
    metadata,
  });
}

async function grantPurchaseBonusCredits({ businessId, actionByUserId, credits, note = 'Purchase bonus credits granted', metadata = {} }) {
  return walletService.addCredits({
    businessId,
    amount: credits,
    actionByUserId,
    type: 'BONUS',
    note,
    metadata,
  });
}

async function addCreditsByAdmin({ businessId, actionByUserId, amount, note }) {
  return walletService.addCredits({
    businessId,
    amount,
    actionByUserId,
    type: 'CREDIT_ADD',
    note,
  });
}

async function removeCreditsByAdmin({ businessId, actionByUserId, amount, note }) {
  return walletService.removeCredits({
    businessId,
    amount,
    actionByUserId,
    type: 'CREDIT_REMOVE',
    note,
  });
}

async function resetCreditsByAdmin({ businessId, actionByUserId, note }) {
  return walletService.setCredits({
    businessId,
    targetAmount: 0,
    actionByUserId,
    type: 'CREDIT_RESET',
    note,
  });
}

async function setCreditsByAdmin({ businessId, actionByUserId, targetAmount, note }) {
  return walletService.setCredits({
    businessId,
    targetAmount,
    actionByUserId,
    type: 'CREDIT_SET',
    note,
  });
}

module.exports = {
  grantTrialCredits,
  grantPurchaseBonusCredits,
  addCreditsByAdmin,
  removeCreditsByAdmin,
  resetCreditsByAdmin,
  setCreditsByAdmin,
};
