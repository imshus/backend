const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const errorHandler = require('./middleware/errorHandler');

const scanRoutes = require('./routes/scan.routes');
const authRoutes = require('./routes/auth.routes');
const settingsRoutes = require('./routes/settings.routes');

const helmet = require('helmet');
const config = require('./config/env');
const webhookController = require('./controllers/webhook.controller');

const app = express();

app.use(helmet());
app.use(cors());
app.locals.razorpayKeyId = config.razorpay?.keyId || null;
app.post('/api/v1/webhooks/razorpay', express.raw({ type: 'application/json' }), webhookController.handleRazorpayWebhook);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));




app.use('/api/v1/scans', scanRoutes);
app.use('/api/v1/auth', require('./routes/auth.routes'));
app.use('/api/v1/employees', require('./routes/employee.routes'));
app.use('/api/v1/rates', require('./routes/rate.routes'));
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/subscription', require('./routes/subscription.routes'));
app.use('/api/v1/payments', require('./routes/payment.routes'));
app.use('/api/v1/wishlist', require('./routes/wishlist.routes'));
app.use('/api/v1/invoices', require('./routes/invoice.routes'));
app.use('/api/v1/item-codes', require('./routes/itemCode.routes'));
app.use('/api/v1/notifications', require('./routes/notification.routes'));
app.use('/api/v1/details', require('./routes/details.routes'));

app.get('/explorer', (req, res) => {
  res.sendFile(require('path').join(__dirname, '..', 'templates', 'explorer.html'));
});
app.get('/explorer.js', (req, res) => {
  res.sendFile(require('path').join(__dirname, '..', 'templates', 'explorer.js'));
});

// The running commit, read once at startup, so a deploy can be verified
// from outside without a login: `curl /api/v1/health` names it.
const runningCommit = (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();

// Public, unauthenticated: the few settings the app reads before or without a
// login. The Pratham AI address lives here so a move of that server needs a
// .env change and a restart, not a new APK.
app.get('/api/v1/app-config', (req, res) => {
  res.status(200).json({
    success: true,
    data: { prathamAiUrl: config.prathamAi?.url || '' },
  });
});

app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    commit: runningCommit,
    // Capabilities the app relies on; a missing one here means the server
    // is behind the app.
    features: { analyzePricing: true, einvoiceTestMode: true, notifications: true },
  });
});

app.get('/', (req, res) => {
  res.status(200).send('Jewellery Tag Backend is running');
});


app.use(errorHandler);

module.exports = app;

