const axios = require('axios');
const config = require('./src/config/env');

async function test() {
  const phoneInput = process.argv[2] || '9625060017';
  const phone = String(phoneInput).replace(/\D/g, '').slice(-10);
  const otp = String(Math.floor(100000 + Math.random() * 900000));

  if (!/^\d{10}$/.test(phone)) {
    console.error('Invalid phone. Usage: node test_msg91.js 9625060017');
    process.exit(1);
  }

  if (!config.msg91.authKey || !config.msg91.templateId) {
    console.error('MSG91 config missing. Check MSG91_AUTH_KEY and MSG91_TEMPLATE_ID');
    process.exit(1);
  }

  console.log('Sending OTP with runtime config:');
  console.log(`Template ID: ${config.msg91.templateId}`);
  console.log(`Mobile: 91${phone}`);

  try {
    const response = await axios.post(
      'https://control.msg91.com/api/v5/otp',
      { otp },
      {
        headers: { 'Content-Type': 'application/json' },
        params: {
          template_id: config.msg91.templateId,
          mobile: `91${phone}`,
          authkey: config.msg91.authKey,
          otp,
          otp_expiry: 10,
          realTimeResponse: 1,
        },
        timeout: 12000,
      }
    );

    console.log('HTTP Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    console.log('Generated OTP (for verification test):', otp);
  } catch (error) {
    console.error('MSG91 call failed');
    console.error('HTTP Status:', error.response?.status || 'NA');
    console.error('Response:', JSON.stringify(error.response?.data || { message: error.message }, null, 2));
    process.exit(1);
  }
}

test();
