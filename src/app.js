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

app.get('/api/v1/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/', (req, res) => {
  res.status(200).send('Jewellery Tag Backend is running');
});


app.use(errorHandler);

module.exports = app;

