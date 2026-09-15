const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INVITE_REWARD_CREDITS,
  PURCHASE_REWARD_CREDITS,
  generateCode,
  normalizeCode,
  ensureReferralCode,
  applyReferralCode,
  rewardReferrerIfEligible,
  getReferralOverview,
} = require('../src/services/referral.service');

function fakeBusiness(fields) {
  return { save: async function () { this.saved = true; return this; }, ...fields };
}

/**
 * The Business collection as the reward path uses it: findById, plus the
 * compare-and-set the tier claim depends on — the stamp moves only while it
 * is unset, and the call reports whether this caller was the one who set it.
 */
function fakeBusinessStore(doc) {
  return {
    findById: async () => doc,
    findOneAndUpdate: async (filter, update) => {
      const [field] = Object.keys(update.$set);
      if (doc[field] !== null && doc[field] !== undefined) return null;
      const before = { ...doc };
      doc[field] = update.$set[field];
      return before;
    },
    updateOne: async (filter, update) => {
      Object.assign(doc, update.$set);
      return { acknowledged: true };
    },
  };
}

test('codes use only unambiguous characters and survive hand-copying', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(generateCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
  assert.equal(normalizeCode(' mrp-7k2 m4x '), 'MRP7K2M4X');
  assert.equal(normalizeCode(null), '');
});

test('each person keeps one personal code; a second ask returns it', async () => {
  const created = [];
  const deps = {
    ReferralCode: {
      findOne: async ({ businessId, userId }) =>
        created.find((c) => c.businessId === businessId && c.userId === userId) || null,
      create: async (doc) => { created.push(doc); return doc; },
    },
  };
  const first = await ensureReferralCode({ businessId: 'b1', userId: 'u1' }, deps);
  const again = await ensureReferralCode({ businessId: 'b1', userId: 'u1' }, deps);
  const other = await ensureReferralCode({ businessId: 'b1', userId: 'u2' }, deps);
  assert.equal(again, first);
  assert.notEqual(other, first);
  assert.equal(created.length, 2);
  await assert.rejects(ensureReferralCode({ businessId: 'b1' }, deps), /REFERRAL_SCOPE_MISSING/);
});

test('an unknown or own-business code is refused at registration', async () => {
  const deps = { ReferralCode: { findOne: async () => null } };
  await assert.rejects(
    applyReferralCode({ businessId: 'b1', code: 'NOPE99' }, deps),
    /REFERRAL_CODE_INVALID/,
  );

  const self = { ReferralCode: { findOne: async () => ({ businessId: 'b1', userId: 'u1' }) } };
  await assert.rejects(
    applyReferralCode({ businessId: 'b1', code: 'MINE22' }, self),
    /REFERRAL_CODE_INVALID/,
  );
});

test('a valid code links the registering business to the member who shared it', async () => {
  const registering = fakeBusiness({ _id: 'b2', referralRewardedAt: null });
  const deps = {
    ReferralCode: {
      findOne: async ({ code }) => (code === 'GOOD22' ? { businessId: 'b1', userId: 'emp7' } : null),
    },
    Business: { findById: async () => registering },
  };
  const result = await applyReferralCode({ businessId: 'b2', code: 'good-22' }, deps);
  assert.deepEqual(result, { applied: true, referrerBusinessId: 'b1', referrerUserId: 'emp7' });
  assert.equal(registering.referredByBusinessId, 'b1');
  assert.equal(registering.referredByUserId, 'emp7');
  assert.ok(registering.saved);
});

test('joining pays 50 once; the purchase later pays 500 more, never again', async () => {
  const referred = fakeBusiness({
    _id: 'b2',
    tradeName: 'Referred Jewels',
    referredByBusinessId: 'b1',
    referredByUserId: 'emp7',
    referralRewardedAt: null,
    referralPurchaseRewardedAt: null,
  });
  const credited = [];
  const deps = {
    Business: fakeBusinessStore(referred),
    CreditTransaction: { findOne: async () => null },
    walletService: { addCredits: async (args) => credited.push(args) },
  };

  const joined = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'TRIAL_STARTED' }, deps);
  assert.equal(joined.credits, INVITE_REWARD_CREDITS);
  assert.equal(credited.length, 1);
  assert.equal(credited[0].businessId, 'b1');
  assert.equal(credited[0].userId, 'emp7');
  assert.equal(credited[0].metadata.tier, 'INVITE');
  assert.ok(referred.referralRewardedAt instanceof Date);

  const bought = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'LICENSE_PURCHASED' }, deps);
  assert.equal(bought.credits, PURCHASE_REWARD_CREDITS);
  assert.equal(credited.length, 2);
  assert.equal(credited[1].amount, PURCHASE_REWARD_CREDITS);
  assert.equal(credited[1].metadata.tier, 'PURCHASE');
  assert.ok(referred.referralPurchaseRewardedAt instanceof Date);

  const again = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'LICENSE_PURCHASED' }, deps);
  assert.equal(again.rewarded, false);
  assert.equal(credited.length, 2);
});

test('a direct purchase with no trial settles both tiers together', async () => {
  const referred = fakeBusiness({
    _id: 'b3',
    referredByBusinessId: 'b1',
    referredByUserId: 'u1',
    referralRewardedAt: null,
    referralPurchaseRewardedAt: null,
  });
  const credited = [];
  const deps = {
    Business: fakeBusinessStore(referred),
    CreditTransaction: { findOne: async () => null },
    walletService: { addCredits: async (args) => credited.push(args) },
  };

  const result = await rewardReferrerIfEligible({ businessId: 'b3', trigger: 'LICENSE_PURCHASED' }, deps);
  assert.equal(result.credits, INVITE_REWARD_CREDITS + PURCHASE_REWARD_CREDITS);
  assert.deepEqual(credited.map((c) => c.metadata.tier), ['INVITE', 'PURCHASE']);
});

test('a business that was never referred pays nothing', async () => {
  const deps = {
    Business: { findById: async () => fakeBusiness({ _id: 'b9', referredByBusinessId: null }) },
    CreditTransaction: { findOne: async () => { throw new Error('should not look'); } },
    walletService: { addCredits: async () => { throw new Error('should not pay'); } },
  };
  assert.deepEqual(await rewardReferrerIfEligible({ businessId: 'b9', trigger: 'TRIAL_STARTED' }, deps), {
    rewarded: false,
  });
});

test('an existing payout transaction blocks a second payment but still stamps', async () => {
  const referred = fakeBusiness({
    _id: 'b2',
    referredByBusinessId: 'b1',
    referralRewardedAt: null,
    referralPurchaseRewardedAt: null,
  });
  const deps = {
    Business: fakeBusinessStore(referred),
    CreditTransaction: { findOne: async () => ({ _id: 'tx1' }) },
    walletService: { addCredits: async () => { throw new Error('should not double pay'); } },
  };
  const result = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'LICENSE_PURCHASED' }, deps);
  assert.equal(result.rewarded, false);
  assert.ok(referred.referralRewardedAt instanceof Date);
  assert.ok(referred.referralPurchaseRewardedAt instanceof Date);
});

test('two triggers at once pay one reward, not two', async () => {
  const referred = fakeBusiness({
    _id: 'b4',
    referredByBusinessId: 'b1',
    referredByUserId: 'u1',
    referralRewardedAt: null,
    referralPurchaseRewardedAt: null,
  });
  const credited = [];
  const deps = {
    Business: fakeBusinessStore(referred),
    // Both callers look before either has paid, which is exactly the race the
    // ledger lookup alone cannot see.
    CreditTransaction: { findOne: async () => null },
    walletService: {
      addCredits: async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        credited.push(args);
      },
    },
  };

  const [first, second] = await Promise.all([
    rewardReferrerIfEligible({ businessId: 'b4', trigger: 'TRIAL_STARTED' }, deps),
    rewardReferrerIfEligible({ businessId: 'b4', trigger: 'TRIAL_STARTED' }, deps),
  ]);

  assert.equal(credited.length, 1, 'one invite reward only');
  assert.equal(first.credits + second.credits, INVITE_REWARD_CREDITS);
});

test('a payment that fails gives the tier back, so it can be retried', async () => {
  const referred = fakeBusiness({
    _id: 'b5',
    referredByBusinessId: 'b1',
    referralRewardedAt: null,
    referralPurchaseRewardedAt: null,
  });
  let attempts = 0;
  const credited = [];
  const deps = {
    Business: fakeBusinessStore(referred),
    CreditTransaction: { findOne: async () => null },
    walletService: {
      addCredits: async (args) => {
        attempts += 1;
        if (attempts === 1) throw new Error('WALLET_UNAVAILABLE');
        credited.push(args);
      },
    },
  };

  await assert.rejects(
    rewardReferrerIfEligible({ businessId: 'b5', trigger: 'TRIAL_STARTED' }, deps),
    /WALLET_UNAVAILABLE/,
  );
  assert.equal(referred.referralRewardedAt, null, 'the stamp is not left behind');

  const retried = await rewardReferrerIfEligible({ businessId: 'b5', trigger: 'TRIAL_STARTED' }, deps);
  assert.equal(retried.credits, INVITE_REWARD_CREDITS);
  assert.equal(credited.length, 1);
});

test('the overview is personal and splits invite from purchase credits', async () => {
  const counts = [];
  const deps = {
    ReferralCode: { findOne: async () => ({ businessId: 'b1', userId: 'u1', code: 'KEPT77' }) },
    Business: {
      countDocuments: async (filter) => {
        counts.push(filter);
        return filter.referralPurchaseRewardedAt ? 2 : 4;
      },
    },
  };
  const overview = await getReferralOverview({ businessId: 'b1', userId: 'u1' }, deps);
  assert.deepEqual(overview, {
    referralCode: 'KEPT77',
    inviteReward: 50,
    purchaseReward: 500,
    invitedCount: 4,
    purchasedCount: 2,
    inviteCredits: 200,
    purchaseCredits: 1000,
    totalCredits: 1200,
  });
  assert.equal(counts[0].referredByUserId, 'u1');
});
