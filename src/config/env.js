const dotenv = require('dotenv');
const joi = require('joi');

dotenv.config();

const envVarsSchema = joi.object({
  NODE_ENV: joi.string().valid('production', 'development', 'test').required(),
  PORT: joi.number().default(3000),
  REDIS_URL: joi.string().required().description('Redis url'),
  MONGODB_URI: joi.string().required().description('MongoDB URI'),
  JWT_ACCESS_SECRET: joi.string().required().description('JWT Access Secret'),
  JWT_REFRESH_SECRET: joi.string().required().description('JWT Refresh Secret'),
  MSG91_AUTH_KEY: joi.string().required().description('MSG91 Auth Key'),
  MSG91_TEMPLATE_ID: joi.string().required().description('MSG91 Template ID'),
  OPENAI_API_KEY: joi.string().required().description('OpenAI API Key'),
  OPENAI_SERVICE_TIER: joi.string().valid('auto', 'default', 'flex', 'scale', 'priority').optional()
    .description('OpenAI service tier; priority ~1.3s faster at ~2x token cost'),
  // GPT-6 Luna's levels; "minimal" (GPT-5) is still accepted and read as "none".
  OPENAI_REASONING_EFFORT: joi.string().valid('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max').optional()
    .description('Reasoning effort for gpt-6-luna'),
  RAZORPAY_KEY_ID: joi.string().allow('').optional().description('Razorpay Key ID'),
  RAZORPAY_KEY_SECRET: joi.string().allow('').optional().description('Razorpay Key Secret'),
  RAZORPAY_WEBHOOK_SECRET: joi.string().allow('').optional().description('Razorpay Webhook Secret'),
  SANDBOX_API_KEY: joi.string().required().description('Sandbox (sandbox.co.in) API Key for GST verification'),
  SANDBOX_API_SECRET: joi.string().required().description('Sandbox (sandbox.co.in) API Secret for GST verification'),
  SANDBOX_API_VERSION: joi.string().default('1.0.0').description('Sandbox API version header'),
  GST_VERIFY_MODE: joi.string().valid('live', 'mock').default('live')
    .description('mock = accept any structurally valid GSTIN with stub data (dev only); live = real Sandbox lookup'),
  EINVOICE_CRED_KEY: joi.string().allow('').default('')
    .description('Server-side key that encrypts each business\'s IRP password at rest; without it e-invoice credentials cannot be saved'),
  // Where the Pratham AI voice agent (Dynamic Voice Agent server) is hosted,
  // e.g. https://ai.example.com. Served to the app so it can be changed here
  // without rebuilding the APK; the app falls back to its own build-time value.
  PRATHAM_AI_URL: joi.string().allow('').default(''),
  BILLING_TIMEZONE: joi.string().default('Asia/Kolkata'),
  MCX_SCHEDULER_TIMEZONE: joi.string().default('Asia/Kolkata'),
  MCX_TRADING_DAYS: joi.string().default('1,2,3,4,5').description('ISO weekdays for MCX trading scheduler (1=Mon..7=Sun)'),
  MCX_TRADING_START_TIME: joi.string().default('09:00:00').description('Trading session start time in HH:mm:ss'),
  MCX_TRADING_END_TIME: joi.string().default('23:55:00').description('Trading session end time in HH:mm:ss'),
  MCX_POLL_INTERVAL_SECONDS: joi.number().integer().min(1).default(140),
  // The owner's rate board, two server-sent-event streams (the variable
  // names keep the owner's spelling). The live one, several updates a
  // second, is what the app's Home and Settings show; the 3-minute one is
  // what the server prices scans, invoices and the MCX scheduler on.
  MCX_LIVE_STEAMING: joi.string().uri().empty('').default('https://jmd.mrpscan.com/api/stream'),
  MCX_3MINUTE_STREAMING: joi.string().uri().empty('').default('https://jmd.mrpscan.com/api/3min/stream'),
  MAX_UPLOAD_MB: joi.number().min(5).max(200).default(80),
  OCR_MAX_EDGE_PX: joi.number().min(1000).max(8000).default(2400),
  OCR_JPEG_QUALITY: joi.number().min(40).max(95).default(82),
  // Tag reading accuracy: magnified parts of each image alongside the whole
  // image, a second independent read compared field by field, and a third
  // targeted look at whatever the two reads disagree on.
  OCR_MULTI_VIEW: joi.boolean().default(true),
  OCR_DOUBLE_READ: joi.boolean().default(true),
  OCR_ADJUDICATE: joi.boolean().default(true),
  // Turns a tag photographed upside down or sideways upright before it is read.
  OCR_ORIENTATION_FIX: joi.boolean().default(true),
  // Where tag uploads land until they are analysed. Point it outside the
  // deploy directory on the server, or a redeploy deletes in-flight scans.
  UPLOAD_DIR: joi.string().allow('').default(''),
  // Invoice PDF rendering; missing config previously surfaced only as a 502 at
  // request time, so it is declared here to be visible at startup.
  PDFMONKEY_API_SECRET: joi.string().allow('').default(''),
  PDFMONKEY_TEMPLATE_ID: joi.string().allow('').default(''),
  // One PDFMonkey template per document; the ids are account identifiers,
  // not secrets, so the current ones double as defaults.
  PDFMONKEY_TEMPLATE_ID_FOR_PREVIEW_INVOICE: joi.string().allow('')
    .default('EAB5F3BB-F10F-4282-9EF3-3FBB51B88D3D'),
  PDFMONKEY_TEMPLATE_ID_FOR_E_INVOICE: joi.string().allow('')
    .default('D1795ED5-9A5D-4BBF-B3AF-EB59DD949E0A'),
  // Origin this API is reachable at from outside. The invoice QR code encodes
  // a URL under it, so it must be the public address, not localhost.
  PUBLIC_BASE_URL: joi.string().uri().default('https://amitaash.com'),
  INVOICE_PDF_CACHE_TTL_SECONDS: joi.number().integer().min(60).max(2592000).default(604800),
  INVOICE_PDF_CACHE_MAX_MB: joi.number().min(1).max(50).default(15),
  // Invoice email. Without SMTP_HOST and SMTP_FROM the app keeps using the
  // phone's own mail app. Titan: smtp.titan.email on 587 with STARTTLS
  // (required, see mail.service) and the mailbox login; 465 would be TLS from
  // the start. SMTP_FROM must be an address the SMTP account may send as.
  SMTP_HOST: joi.string().allow('').default(''),
  SMTP_PORT: joi.number().integer().min(1).max(65535).default(587),
  SMTP_SECURE: joi.boolean().optional(),
  SMTP_USER: joi.string().allow('').default(''),
  SMTP_PASS: joi.string().allow('').default(''),
  SMTP_FROM: joi.string().allow('').default(''),
  // MRPscan's own details on the invoice emailed after a licence or credit
  // payment. Without INVOICE_SELLER_GSTIN it goes out as a Payment Receipt.
  // The defaults are the GST registration certificate's (REG-06, 22/09/2026):
  // public business details printed on every invoice, not secrets.
  INVOICE_SELLER_NAME: joi.string().allow('').default('Amitaash IT Solutions Private Limited'),
  INVOICE_SELLER_ADDRESS: joi.string().allow('').default('1st Floor, Plot No. 2, Right Portion, WZ-3, DLF Industrial Area, Moti Nagar, New Delhi, Delhi - 110015'),
  INVOICE_SELLER_GSTIN: joi.string().allow('').default('07ABGCA3065M1ZG'),
  INVOICE_SELLER_EMAIL: joi.string().allow('').default(''),
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
  openai: {
    apiKey: envVars.OPENAI_API_KEY,
    serviceTier: envVars.OPENAI_SERVICE_TIER || null,
    reasoningEffort: envVars.OPENAI_REASONING_EFFORT || 'low',
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
  sandbox: {
    apiKey: envVars.SANDBOX_API_KEY,
    apiSecret: envVars.SANDBOX_API_SECRET,
    apiVersion: envVars.SANDBOX_API_VERSION
  },
  gstVerifyMode: envVars.GST_VERIFY_MODE,
  prathamAi: {
    url: envVars.PRATHAM_AI_URL,
  },
  einvoice: {
    credKey: envVars.EINVOICE_CRED_KEY,
  },
  pdfmonkey: {
    apiSecret: envVars.PDFMONKEY_API_SECRET,
    templateId: envVars.PDFMONKEY_TEMPLATE_ID,
    previewTemplateId: envVars.PDFMONKEY_TEMPLATE_ID_FOR_PREVIEW_INVOICE,
    eInvoiceTemplateId: envVars.PDFMONKEY_TEMPLATE_ID_FOR_E_INVOICE,
  },
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
  mcx: {
    liveStreamUrl: envVars.MCX_LIVE_STEAMING,
    threeMinuteStreamUrl: envVars.MCX_3MINUTE_STREAMING,
  },
  upload: {
    maxUploadMb: envVars.MAX_UPLOAD_MB,
    dir: envVars.UPLOAD_DIR || '',
  },
  ocr: {
    maxEdgePx: envVars.OCR_MAX_EDGE_PX,
    jpegQuality: envVars.OCR_JPEG_QUALITY,
    multiView: envVars.OCR_MULTI_VIEW,
    doubleRead: envVars.OCR_DOUBLE_READ,
    adjudicate: envVars.OCR_ADJUDICATE,
    orientationFix: envVars.OCR_ORIENTATION_FIX,
  },
  publicBaseUrl: String(envVars.PUBLIC_BASE_URL).replace(/\/+$/, ''),
  invoicePdfCache: {
    ttlSeconds: envVars.INVOICE_PDF_CACHE_TTL_SECONDS,
    maxBytes: envVars.INVOICE_PDF_CACHE_MAX_MB * 1024 * 1024,
  },
  smtp: {
    host: envVars.SMTP_HOST,
    port: envVars.SMTP_PORT,
    secure: envVars.SMTP_SECURE ?? envVars.SMTP_PORT === 465,
    user: envVars.SMTP_USER,
    pass: envVars.SMTP_PASS,
    from: envVars.SMTP_FROM,
  },
  invoiceSeller: {
    name: envVars.INVOICE_SELLER_NAME,
    address: envVars.INVOICE_SELLER_ADDRESS,
    gstin: envVars.INVOICE_SELLER_GSTIN.trim().toUpperCase(),
    email: envVars.INVOICE_SELLER_EMAIL || envVars.SMTP_FROM,
  },
};
