const gstVerificationLog = require('../services/gstVerificationLog.service');

/**
 * Logs every sign-up GST check, passed or failed, without changing its
 * reply: the GST number, the name and mobile sent alongside, and either the
 * details GSTN returned or the reason it was refused (a malformed number
 * turned away by validation, one GSTN does not know or has cancelled, or the
 * lookup itself failing). On the confirm step a pass records the account
 * created with the number.
 *
 * Mounted after the rate limiter, so a caller being throttled is not logged
 * once per refused request. The write is best-effort and never delays or
 * alters the reply.
 */
const logGstCheck = (step) => (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    const { gstNumber, fullName, mobile } = req.body || {};
    let write = null;
    if (status >= 400 && status !== 429) {
      write = gstVerificationLog.recordCheck({
        gstNumber,
        fullName,
        mobile,
        ok: false,
        statusCode: status,
        // errorHandler replies { error: CODE, message }; sendError replies { error: message }.
        reason: body?.message || body?.error || '',
        errorCode: body?.message ? body?.error : '',
      });
    } else if (status < 300 && step === 'verify') {
      write = gstVerificationLog.recordCheck({ gstNumber, fullName, mobile, ok: true, data: body?.data });
    } else if (status < 300 && step === 'confirm') {
      write = gstVerificationLog.recordConfirmed({
        gstNumber,
        fullName,
        mobile,
        businessId: body?.data?.businessId || body?.data?.id || '',
      });
    }
    if (write) {
      Promise.resolve(write).catch((err) => {
        console.warn('[GST_CHECK_LOG]', err?.message || err);
      });
    }
    return json(body);
  };
  next();
};

module.exports = { logGstCheck };
