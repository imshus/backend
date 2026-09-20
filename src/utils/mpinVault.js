const crypto = require('crypto');

const config = require('../config/env');

/**
 * Recoverable MPIN storage, for the Forgot MPIN screen that shows a shop its
 * own MPIN once an OTP has proved the phone.
 *
 * bcrypt remains the credential of record: `login` still compares against
 * `mpinHash` and nothing here touches that path. This is a second, sealed
 * copy that exists for one reason — the OTP-guarded reveal endpoint — and it
 * is AES-256-GCM under a server-side key, so a copied database row on its own
 * gives up nothing. The column is `select: false`, so it never rides along in
 * an ordinary query.
 *
 * The trade is real and was made deliberately: anyone holding BOTH the
 * database and MPIN_VAULT_KEY can read every MPIN sealed after this shipped.
 * Set MPIN_VAULT_KEY in the server environment and keep it out of the
 * database's own backups.
 *
 * Accounts whose MPIN was set before this existed have no sealed copy. There
 * is no way to recover those, so the screen falls back to setting a new one.
 */

const KEY = crypto
  .createHash('sha256')
  .update(String(process.env.MPIN_VAULT_KEY || config.jwt.accessSecret))
  .digest();

const VERSION = 'v1';

/** Seals a plain MPIN for storage; returns the string for the mpinVault column. */
function sealMpin(mpin) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(mpin), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Opens a sealed MPIN; null for anything missing, foreign, or tampered with. */
function openMpin(sealed) {
  try {
    const [version, iv, tag, ciphertext] = String(sealed || '').split(':');
    if (version !== VERSION || !iv || !tag || !ciphertext) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return /^\d{4,6}$/.test(plain) ? plain : null;
  } catch {
    // A wrong key, a truncated row or a tampered tag all land here, and all
    // mean the same thing to the caller: there is nothing to show.
    return null;
  }
}

module.exports = { sealMpin, openMpin };
