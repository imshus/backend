/**
 * An Indian mobile number as the ten digits it is stored under, or '' when
 * the value cannot be one. Separators and a leading 91 / +91 are tolerated,
 * because that is how numbers get typed and pasted; anything else is refused
 * rather than guessed at.
 */
function normalizeIndianMobile(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return /^[0-9]{10}$/.test(digits) ? digits : '';
}

/**
 * The spellings a number may have been stored under by code that kept what
 * was typed. Employee phones written before they were normalised are matched
 * through these so an old record still counts.
 */
function storedSpellingsOf(tenDigits) {
  return [tenDigits, `91${tenDigits}`, `+91${tenDigits}`, `0${tenDigits}`, `+91 ${tenDigits}`];
}

/**
 * Which account a sign-in identifier names, exactly as the login looks it up:
 * a value holding at least ten digits is the phone number its last ten digits
 * spell, whatever else is typed around them; anything else is a User ID, as
 * typed. The login and its attempt counter both use this, so every spelling
 * that reaches one account is counted against that one account.
 */
function loginLookupOf(value) {
  const identifier = String(value ?? '').trim();
  const phone = identifier.replace(/\D/g, '').slice(-10);
  return /^[0-9]{10}$/.test(phone) ? { phone } : { userId: identifier };
}

module.exports = { normalizeIndianMobile, storedSpellingsOf, loginLookupOf };
