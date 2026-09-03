const dotenv = require('dotenv');
const joi = require('joi');

dotenv.config();

const envVarsSchema = joi.object({
  NODE_ENV: joi.string().valid('production', 'development', 'test').required(),
  PORT: joi.number().default(3000),
  REDIS_URL: joi.string().required().description('Redis url'),
  GEMINI_API_KEY: joi.string().required().description('Gemini API Key'),
  MONGODB_URI: joi.string().required().description('MongoDB URI'),
  JWT_ACCESS_SECRET: joi.string().required().description('JWT Access Secret'),
  JWT_REFRESH_SECRET: joi.string().required().description('JWT Refresh Secret'),
  MSG91_AUTH_KEY: joi.string().required().description('MSG91 Auth Key'),
  MSG91_TEMPLATE_ID: joi.string().required().description('MSG91 Template ID'),
  RESEND_API_KEY: joi.string().allow('').optional().description('Resend API Key'),
  OPENAI_API_KEY: joi.string().required().description('OpenAI API Key'),
  OPENAI_SERVICE_TIER: joi.string().valid('auto', 'default', 'flex', 'scale', 'priority').optional()
    .description('OpenAI service tier; priority ~1.3s faster at ~2x token cost'),
  OPENAI_REASONING_EFFORT: joi.string().valid('minimal', 'low', 'medium', 'high').optional()
    .description('Reasoning effort for gpt-5.x'),
  RAZORPAY_KEY_ID: joi.string().allow('').optional().description('Razorpay Key ID'),
  RAZORPAY_KEY_SECRET: joi.string().allow('').optional().description('Razorpay Key Secret'),
  RAZORPAY_WEBHOOK_SECRET: joi.string().allow('').optional().description('Razorpay Webhook Secret'),
  SANDBOX_API_KEY: joi.string().required().description('Sandbox (sandbox.co.in) API Key for GST verification'),
  SANDBOX_API_SECRET: joi.string().required().description('Sandbox (sandbox.co.in) API Secret for GST verification'),
  SANDBOX_API_VERSION: joi.string().default('1.0.0').description('Sandbox API version header'),
  GST_VERIFY_MODE: joi.string().valid('live', 'mock').default('live')
    .description('mock = accept any structurally valid GSTIN with stub data (dev only); live = real Sandbox lookup'),
  BILLING_TIMEZONE: joi.string().default('Asia/Kolkata'),
  MCX_SCHEDULER_TIMEZONE: joi.string().default('Asia/Kolkata'),
  MCX_TRADING_DAYS: joi.string().default('1,2,3,4,5').description('ISO weekdays for MCX trading scheduler (1=Mon..7=Sun)'),
  MCX_TRADING_START_TIME: joi.string().default('09:00:00').description('Trading session start time in HH:mm:ss'),
  MCX_TRADING_END_TIME: joi.string().default('23:55:00').description('Trading session end time in HH:mm:ss'),
  MCX_POLL_INTERVAL_SECONDS: joi.number().integer().min(1).default(140),
  MAX_UPLOAD_MB: joi.number().min(5).max(200).default(80),
  OCR_MAX_EDGE_PX: joi.number().min(1000).max(8000).default(2400),
  OCR_JPEG_QUALITY: joi.number().min(40).max(95).default(82),
  // Tag reading accuracy: magnified parts of each image alongside the whole
  // image, a second independent read compared field by field, and a third
  // targeted look at whatever the two reads disagree on.
  OCR_MULTI_VIEW: joi.boolean().default(true),
  OCR_DOUBLE_READ: joi.boolean().default(true),
  OCR_ADJUDICATE: joi.boolean().default(true),
  // Invoice PDF rendering; missing config previously surfaced only as a 502 at
  // request time, so it is declared here to be visible at startup.
  PDFMONKEY_API_SECRET: joi.string().allow('').default(''),
  PDFMONKEY_TEMPLATE_ID: joi.string().allow('').default(''),
  // Origin this API is reachable at from outside. The invoice QR code encodes
  // a URL under it, so it must be the public address, not localhost.
  PUBLIC_BASE_URL: joi.string().uri().default('https://amitaash.com'),
  INVOICE_PDF_CACHE_TTL_SECONDS: joi.number().integer().min(60).max(2592000).default(604800),
  INVOICE_PDF_CACHE_MAX_MB: joi.number().min(1).max(50).default(15)
})
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

function parseIsoWeekdays(value) {
  const parsed = String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);

  return parsed.length ? [...new Set(parsed)] : [1, 2, 3, 4, 5];
}

module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  redis: {
    url: envVars.REDIS_URL,
  },
  gemini: {
    apiKey: envVars.GEMINI_API_KEY,
  },
  openai: {
    apiKey: envVars.OPENAI_API_KEY,
    serviceTier: envVars.OPENAI_SERVICE_TIER || null,
    reasoningEffort: envVars.OPENAI_REASONING_EFFORT || 'minimal',
  },
  razorpay: {
    keyId: envVars.RAZORPAY_KEY_ID,
    keySecret: envVars.RAZORPAY_KEY_SECRET,
    webhookSecret: envVars.RAZORPAY_WEBHOOK_SECRET,
  },
  mongodb: {
    uri: envVars.MONGODB_URI,
  },
  jwt: {
    accessSecret: envVars.JWT_ACCESS_SECRET,
    refreshSecret: envVars.JWT_REFRESH_SECRET,
  },
  msg91: {
    authKey: envVars.MSG91_AUTH_KEY,
    templateId: envVars.MSG91_TEMPLATE_ID,
  },
  resend: {
    apiKey: envVars.RESEND_API_KEY,
  },
  sandbox: {
    apiKey: envVars.SANDBOX_API_KEY,
    apiSecret: envVars.SANDBOX_API_SECRET,
    apiVersion: envVars.SANDBOX_API_VERSION
  },
  gstVerifyMode: envVars.GST_VERIFY_MODE,
  billing: {
    timezone: envVars.BILLING_TIMEZONE,
  },
  mcxScheduler: {
    timezone: envVars.MCX_SCHEDULER_TIMEZONE,
    tradingDays: parseIsoWeekdays(envVars.MCX_TRADING_DAYS),
    startTime: envVars.MCX_TRADING_START_TIME,
    endTime: envVars.MCX_TRADING_END_TIME,
    pollIntervalSeconds: envVars.MCX_POLL_INTERVAL_SECONDS,
  },
  upload: {
    maxUploadMb: envVars.MAX_UPLOAD_MB,
  },
  ocr: {
    maxEdgePx: envVars.OCR_MAX_EDGE_PX,
    jpegQuality: envVars.OCR_JPEG_QUALITY,
    multiView: envVars.OCR_MULTI_VIEW,
    doubleRead: envVars.OCR_DOUBLE_READ,
    adjudicate: envVars.OCR_ADJUDICATE,
  },
  publicBaseUrl: String(envVars.PUBLIC_BASE_URL).replace(/\/+$/, ''),
  invoicePdfCache: {
    ttlSeconds: envVars.INVOICE_PDF_CACHE_TTL_SECONDS,
    maxBytes: envVars.INVOICE_PDF_CACHE_MAX_MB * 1024 * 1024,
  },
};
