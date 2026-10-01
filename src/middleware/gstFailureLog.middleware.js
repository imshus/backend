const gstFailureLog = require('../services/gstFailureLog.service');

/**
 * Logs the outcome of a sign-up GST check without changing it. Every refusal
 * the check answers with, whether a malformed number turned away by
 * validation, a number GSTN does not know or has cancelled, or the lookup
 * itself failing, is stored with the name and mobile sent alongside. A pass
 * closes that mobile's earlier failures.
 *
 * Mounted after the rate limiter, so a caller being throttled is not logged
 * once per refused request. The write is best-effort and never delays or
 * alters the reply.
 */
const logGstVerifyOutcome = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    const { gstNumber, fullName, mobile } = req.body || {};
    const write = status >= 400 && status !== 429
      ? gstFailureLog.recordFailure({
        gstNumber,
        fullName,
        mobile,
        statusCode: status,
        // errorHandler replies { error: CODE, message }; sendError replies { error: message }.
        reason: body?.message || body?.error || '',
        errorCode: body?.message ? body?.error : '',
      })
      : status < 300
        ? gstFailureLog.resolveFor({ mobile, gstNumber })
        : null;
    if (write) {
      Promise.resolve(write).catch((err) => {
        console.warn('[GST_FAILURE_LOG]', err?.message || err);
      });
    }
    return json(body);
  };
  next();
};

module.exports = { logGstVerifyOutcome };
