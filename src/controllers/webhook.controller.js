const webhookService = require('../services/webhook.service');
const appleIapService = require('../services/appleIap.service');

async function handleRazorpayWebhook(req, res, next) {
  try {
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    const parsedBody = req.body instanceof Buffer ? JSON.parse(rawBody || '{}') : req.body;

    const result = await webhookService.handleRazorpayWebhook({
      rawBody,
      parsedBody,
      headers: req.headers,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
}

// App Store Server Notifications V2 (set this URL in App Store Connect):
// refunds and revocations of iPhone purchases. Apple retries on non-200.
async function handleAppleNotification(req, res, next) {
  try {
    const result = await appleIapService.handleServerNotification(req.body?.signedPayload);
    return res.status(200).json({ success: true, data: { ignored: Boolean(result?.ignored) } });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleRazorpayWebhook,
  handleAppleNotification,
};
