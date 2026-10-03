/**
 * Checks the invoice SMTP settings in .env (SMTP_*) by signing in and sending
 * one short message, before the app relies on them.
 *
 *   node scripts/send_test_email.js you@example.com
 *
 * Titan (GoDaddy Professional Email): SMTP_HOST=smtp.titan.email,
 * SMTP_PORT=587 (STARTTLS), SMTP_USER and SMTP_FROM = the full mailbox address,
 * SMTP_PASS = its password. "Enable Titan on other apps" must be on in Titan
 * webmail settings, and two-factor sign-in off for that mailbox.
 */
require('dotenv').config();
const config = require('../src/config/env');
const mail = require('../src/services/mail.service');

const main = async () => {
  const to = String(process.argv[2] || '').trim();
  if (!to) {
    console.error('Usage: node scripts/send_test_email.js you@example.com');
    process.exit(1);
  }
  if (!mail.isConfigured()) {
    console.error('SMTP_HOST and SMTP_FROM are not set in .env.');
    process.exit(1);
  }
  const { host, port, secure, user, from } = config.smtp;
  console.log(`Signing in to ${host}:${port} (${secure ? 'TLS' : 'STARTTLS'}) as ${user || '(no user)'}…`);
  await mail.verifyConnection();
  console.log('Signed in. Sending…');
  const info = await mail.sendMail({
    to,
    subject: 'MRPscan invoice email test',
    text: `This message was sent by ${from} through ${host} to check the invoice email settings.`,
    fromName: 'MRPscan',
  });
  console.log(`Sent to ${to}. Message id: ${info.messageId}`);
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Failed: ${err.message}`);
  if (/auth|535|credentials/i.test(err.message)) {
    console.error('Check SMTP_USER / SMTP_PASS, that "Enable Titan on other apps" is on, and that 2FA is off.');
  }
  process.exit(1);
});
