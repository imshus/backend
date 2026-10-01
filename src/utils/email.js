/**
 * One email address: no spaces or header characters, and a dot in the
 * domain. It refuses only what no mail server would take.
 */
const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

const isEmail = (value) => {
  const email = String(value ?? '').trim();
  return email.length <= 254 && EMAIL_PATTERN.test(email);
};

module.exports = { isEmail };
