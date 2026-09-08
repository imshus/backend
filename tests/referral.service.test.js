const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REFERRAL_BONUS_CREDITS,
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

test('the reward pays the shop wallet 100 once, attributed to the sharer', async () => {
  const referred = fakeBusiness({
    _id: 'b2',
    tradeName: 'Referred Jewels',
    referredByBusinessId: 'b1',
    referredByUserId: 'emp7',
    referralRewardedAt: null,
  });
  const credited = [];
  const deps = {
    Business: { findById: async () => referred },
    CreditTransaction: { findOne: async () => null },
    walletService: { addCredits: async (args) => credited.push(args) },
  };

  const first = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'TRIAL_STARTED' }, deps);
  assert.equal(first.rewarded, true);
  assert.equal(credited.length, 1);
  assert.equal(credited[0].businessId, 'b1');
  assert.equal(credited[0].userId, 'emp7');
  assert.equal(credited[0].amount, REFERRAL_BONUS_CREDITS);
  assert.equal(credited[0].type, 'REFERRAL_BONUS');
  assert.equal(credited[0].metadata.referredBusinessId, 'b2');
  assert.equal(credited[0].metadata.earnedByUserId, 'emp7');
  assert.ok(referred.referralRewardedAt instanceof Date);

  const second = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'LICENSE_PURCHASED' }, deps);
  assert.equal(second.rewarded, false);
  assert.equal(credited.length, 1);
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
  const referred = fakeBusiness({ _id: 'b2', referredByBusinessId: 'b1', referralRewardedAt: null });
  const deps = {
    Business: { findById: async () => referred },
    CreditTransaction: { findOne: async () => ({ _id: 'tx1' }) },
    walletService: { addCredits: async () => { throw new Error('should not double pay'); } },
  };
  const result = await rewardReferrerIfEligible({ businessId: 'b2', trigger: 'LICENSE_PURCHASED' }, deps);
  assert.equal(result.rewarded, false);
  assert.ok(referred.referralRewardedAt instanceof Date);
});

test('the overview is personal: it counts only referrals of my own code', async () => {
  const counts = [];
  const deps = {
    ReferralCode: { findOne: async () => ({ businessId: 'b1', userId: 'u1', code: 'KEPT77' }) },
    Business: {
      countDocuments: async (filter) => {
        counts.push(filter);
        return filter.referralRewardedAt ? 2 : 5;
      },
    },
  };
  const overview = await getReferralOverview({ businessId: 'b1', userId: 'u1' }, deps);
  assert.deepEqual(overview, {
    referralCode: 'KEPT77',
    creditsPerReferral: 100,
    invitedCount: 5,
    rewardedCount: 2,
    pendingCount: 3,
    creditsEarned: 200,
  });
  assert.equal(counts[0].referredByUserId, 'u1');
  assert.equal(counts[0].isRegistered, true);
});
