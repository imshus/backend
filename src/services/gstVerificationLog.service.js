const GstVerification = require('../models/gstVerification.model');

const mobileOf = (value) => String(value ?? '').replace(/\D/g, '').slice(-10);
const gstOf = (value) => String(value ?? '').toUpperCase().replace(/\s+/g, '').slice(0, 20);
const nameOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const text = (value, max = 300) => String(value ?? '').trim().slice(0, max);

/** The GST details worth keeping from a successful check's reply. */
const detailsOf = (data = {}) => ({
  legalName: text(data.legalName, 200),
  tradeName: text(data.tradeName, 200),
  businessType: text(data.businessType, 80),
  companyType: text(data.companyType, 80),
  address: text(data.address, 500),
  stateCode: text(data.stateCode, 10),
  stateName: text(data.stateName, 80),
  pincode: text(data.pincode, 10),
  gstStatus: text(data.gstStatus, 40),
  isMock: Boolean(data.isMock),
});

const keyOf = ({ mobile, gstNumber }) => ({ mobile: mobileOf(mobile), gstNumber: gstOf(gstNumber) });

/**
 * One sign-up GST check, passed or failed, kept with the name and mobile
 * entered: upserts the row for this mobile and number with the latest
 * outcome. A pass stores the details GSTN returned and marks this mobile's
 * other failed numbers resolved.
 */
async function recordCheck({ gstNumber, fullName, mobile, ok, data, reason, errorCode, statusCode }) {
  const key = keyOf({ mobile, gstNumber });
  if (!key.gstNumber) return null;
  const now = new Date();
  const name = nameOf(fullName);
  const outcome = ok
    ? { status: 'VERIFIED', details: detailsOf(data), verifiedAt: now, resolvedAt: null, resolvedGstNumber: '' }
    : {
      status: 'FAILED',
      reason: text(reason),
      errorCode: text(errorCode, 60),
      statusCode: Number(statusCode) || null,
      lastFailedAt: now,
    };

  const row = await GstVerification.findOneAndUpdate(
    key,
    {
      $set: { ...(name ? { fullName: name } : {}), lastCheckedAt: now, ...outcome },
      $inc: ok ? { attempts: 1 } : { attempts: 1, failures: 1 },
      $setOnInsert: { firstCheckedAt: now, source: 'REGISTRATION' },
    },
    { upsert: true, new: true },
  );

  if (ok && key.mobile) {
    await GstVerification.updateMany(
      { mobile: key.mobile, gstNumber: { $ne: key.gstNumber }, status: 'FAILED', resolvedAt: null },
      { $set: { resolvedAt: now, resolvedGstNumber: key.gstNumber } },
    );
  }
  return row;
}

/** The account was created with this number (the confirm step passed). */
async function recordConfirmed({ gstNumber, fullName, mobile, businessId }) {
  const key = keyOf({ mobile, gstNumber });
  if (!key.gstNumber) return null;
  const now = new Date();
  const name = nameOf(fullName);
  return GstVerification.findOneAndUpdate(
    key,
    {
      $set: {
        ...(name ? { fullName: name } : {}),
        status: 'VERIFIED',
        confirmedAt: now,
        businessId: text(businessId, 40),
        lastCheckedAt: now,
      },
      $setOnInsert: { firstCheckedAt: now, source: 'REGISTRATION', verifiedAt: now },
    },
    { upsert: true, new: true },
  );
}

module.exports = { recordCheck, recordConfirmed, mobileOf, detailsOf };
