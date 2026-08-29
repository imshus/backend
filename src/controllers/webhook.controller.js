const webhookService = require('../services/webhook.service');

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

module.exports = {
  handleRazorpayWebhook,
};
