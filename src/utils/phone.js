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

module.exports = { normalizeIndianMobile, storedSpellingsOf };
