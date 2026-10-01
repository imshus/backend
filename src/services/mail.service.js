const nodemailer = require('nodemailer');
const config = require('../config/env');

/**
 * Outgoing email over the SMTP account in .env (SMTP_*).
 *
 * Mail goes out from SMTP_FROM, the address the account may send as, under
 * the shop's name, so the customer sees who it is from while SPF and DKIM
 * still pass for the sending domain.
 */

const smtp = () => config.smtp || {};

/** True once a host and a sender address are set. */
const isConfigured = () => Boolean(String(smtp().host || '').trim() && String(smtp().from || '').trim());

let transport = null;

const getTransport = () => {
  if (!transport) {
    const { host, port, secure, user, pass } = smtp();
    transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      // A stalled server must not hold the request open; the app waits on it.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transport;
};

/** A display name safe for a From header: no quotes, angle brackets or line breaks. */
const displayName = (value) => String(value || '').replace(/["<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The message nodemailer sends, kept apart from sending so its shape can be
 * checked without a server.
 */
const buildMessage = ({ to, subject, text, html, attachments = [], fromName = '' }) => {
  const name = displayName(fromName);
  const address = String(smtp().from || '').trim();
  return {
    from: name ? { name, address } : address,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    attachments,
  };
};

/** Sends one message. Resolves to nodemailer's info; rejects on any SMTP failure. */
const sendMail = async (message) => getTransport().sendMail(buildMessage(message));

/** Connects and signs in without sending: rejects with the server's reason. */
const verifyConnection = async () => getTransport().verify();

module.exports = { isConfigured, buildMessage, sendMail, verifyConnection };
