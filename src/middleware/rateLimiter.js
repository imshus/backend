const redisClient = require('../redis/redisClient');

const gstRateLimiter = async (req, res, next) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    const hrKey = `gst_limit_hr:${ip}`;
    const dayKey = `gst_limit_day:${ip}`;

    let hrCount = await redisClient.get(hrKey);
    if (hrCount && parseInt(hrCount) >= 20) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Maximum 20 GST verifications per hour allowed.' });
    }

    let dayCount = await redisClient.get(dayKey);
    if (dayCount && parseInt(dayCount) >= 60) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Maximum 10 GST verifications per 24 hours allowed.' });
    }

    if (hrCount) {
      await redisClient.incr(hrKey);
    } else {
      await redisClient.set(hrKey, '1', 'EX', 3600);
    }

    if (dayCount) {
      await redisClient.incr(dayKey);
    } else {
      await redisClient.set(dayKey, '1', 'EX', 86400);
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Counts one request against a key. INCR first, then the TTL on the first
 * hit: a GET-then-INCR pair could recreate an expired key without a TTL and
 * refuse that caller for good.
 */
const countHit = async (key, windowSeconds) => {
  const count = Number(await redisClient.incr(key));
  if (count === 1) await redisClient.expire(key, windowSeconds);
  return count;
};

/**
 * A per-account counter for an endpoint that spends a paid model call without
 * debiting a credit. Keyed by user and business rather than IP: a shop's
 * phones sit behind one NAT, and the point is to stop one login looping it.
 */
const perUserLimiter = ({ name, limit, windowSeconds, message }) => async (req, res, next) => {
  try {
    const who = `${req.user?.businessId || 'anon'}:${req.user?.userId || req.ip}`;
    const count = await countHit(`${name}_limit:${who}`, windowSeconds);
    if (count > limit) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message });
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * A counter keyed by a value in the request body — the phone number an OTP
 * goes to, the identifier a reset is asked for. Not by IP: the API sits
 * behind a proxy without trust proxy, so every phone would share one bucket.
 * A request without the value passes; validation refuses it anyway.
 */
const bodyKeyLimiter = ({ name, limit, windowSeconds, message, pick }) => async (req, res, next) => {
  try {
    const raw = String(pick(req) || '').trim().toLowerCase();
    if (!raw) return next();
    const count = await countHit(`${name}_limit:${raw.replace(/\s+/g, '')}`, windowSeconds);
    if (count > limit) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message });
    }
    next();
  } catch (error) {
    next(error);
  }
};

const mobileOf = (req) => String(req.body?.mobile || '').replace(/\D/g, '').slice(-10);

// Ten codes an hour to one number is plenty for a person and stops a number
// being flooded; fifteen checks an hour is far more than a real mistyping
// and far too few to guess a code within its ten-minute life.
const otpSendLimiter = bodyKeyLimiter({
  name: 'otp_send',
  limit: 10,
  windowSeconds: 3600,
  message: 'Too many codes were sent to this number. Please try again in an hour.',
  pick: mobileOf,
});
const otpVerifyLimiter = bodyKeyLimiter({
  name: 'otp_verify',
  limit: 15,
  windowSeconds: 3600,
  message: 'Too many attempts for this number. Please try again in an hour.',
  pick: mobileOf,
});
const accountLookupLimiter = bodyKeyLimiter({
  name: 'account_lookup',
  limit: 30,
  windowSeconds: 3600,
  message: 'Too many attempts. Please try again in an hour.',
  pick: (req) => req.body?.identifier || req.body?.userId || mobileOf(req),
});

/**
 * Signing in, counted per phone number.
 *
 * The credential is four digits: ten thousand possibilities, which an
 * unlimited endpoint gives up in minutes. Twenty attempts an hour is far more
 * than a shop mistyping its own MPIN and nowhere near enough to walk the
 * space — a script would need three weeks per account.
 *
 * Keyed on the number, not the IP: a shop's staff share one connection, and
 * whoever is guessing does not.
 */
const loginAttemptLimiter = bodyKeyLimiter({
  name: 'login_attempt',
  limit: 20,
  windowSeconds: 3600,
  message: 'Too many sign-in attempts for this number. Please try again in an hour.',
  pick: (req) => req.body?.mobile || mobileOf(req),
});

// One gallery pick is one detection; 120 an hour is far beyond a person
// and a firm cap on a script. A refused call just means framing by hand.
const detectTagRateLimiter = perUserLimiter({
  name: 'detect_tag',
  limit: 120,
  windowSeconds: 3600,
  message: 'Too many photo detections this hour. Frame the tag by hand for now.',
});

// Each tag photograph is uploaded once per side; 600 an hour is a shop's
// whole day of scans in one hour. What it caps is a script re-uploading a
// side to run the speculative analysis — a paid model call — over and over.
const scanUploadRateLimiter = perUserLimiter({
  name: 'scan_upload',
  limit: 600,
  windowSeconds: 3600,
  message: 'Too many uploads this hour. Please try again later.',
});

// The MPIN in front of a profile edit is a four-digit secret, so guessing it
// has to cost something: ten tries an hour for this signed-in user.
const profileEditLimiter = perUserLimiter({
  name: 'profile_edit_mpin',
  limit: 10,
  windowSeconds: 3600,
  message: 'Too many MPIN attempts. Please try again in an hour.',
});

module.exports = {
  gstRateLimiter,
  profileEditLimiter,
  perUserLimiter,
  bodyKeyLimiter,
  detectTagRateLimiter,
  scanUploadRateLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  accountLookupLimiter,
  loginAttemptLimiter,
};
