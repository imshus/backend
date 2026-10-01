const GstVerificationFailure = require('../models/gstVerificationFailure.model');

const mobileOf = (value) => String(value ?? '').replace(/\D/g, '').slice(-10);
const gstOf = (value) => String(value ?? '').toUpperCase().replace(/\s+/g, '').slice(0, 20);
const nameOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * Records a GST number that could not be verified at sign-up, with the name
 * and mobile entered. Upserts one row per mobile and GST number, counting
 * attempts; a name sent later fills in or updates the stored one.
 */
async function recordFailure({ gstNumber, fullName, mobile, reason, errorCode, statusCode }) {
  const gst = gstOf(gstNumber);
  if (!gst) return null;
  const now = new Date();
  const name = nameOf(fullName);
  return GstVerificationFailure.findOneAndUpdate(
    { mobile: mobileOf(mobile), gstNumber: gst },
    {
      $set: {
        ...(name ? { fullName: name } : {}),
        reason: String(reason || '').slice(0, 300),
        errorCode: String(errorCode || '').slice(0, 60),
        statusCode: Number(statusCode) || null,
        lastFailedAt: now,
        resolvedAt: null,
        resolvedGstNumber: '',
      },
      $inc: { attempts: 1 },
      $setOnInsert: { firstFailedAt: now, source: 'REGISTRATION' },
    },
    { upsert: true, new: true },
  );
}

/** A successful check from this mobile closes its open failures. */
async function resolveFor({ mobile, gstNumber }) {
  const phone = mobileOf(mobile);
  if (!phone) return null;
  return GstVerificationFailure.updateMany(
    { mobile: phone, resolvedAt: null },
    { $set: { resolvedAt: new Date(), resolvedGstNumber: gstOf(gstNumber) } },
  );
}

module.exports = { recordFailure, resolveFor, mobileOf };
