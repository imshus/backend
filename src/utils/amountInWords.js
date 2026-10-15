/**
 * A whole-rupee amount in Indian English words, worded exactly as the app's
 * utils/numberToWords.ts words it: "One Lakh Eight Thousand One Hundred
 * Fifty Rupees Only".
 *
 * The server words the grand total it prints itself, so the words can never
 * disagree with the figure beside them.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const twoDigitWords = (num) => {
  if (num < 20) return ONES[num];
  const ones = num % 10;
  return `${TENS[Math.floor(num / 10)]}${ones ? ` ${ONES[ones]}` : ''}`.trim();
};

const threeDigitWords = (num) => {
  if (num === 0) return '';
  const hundreds = Math.floor(num / 100);
  const remainder = num % 100;
  const hundredPart = hundreds ? `${ONES[hundreds]} Hundred` : '';
  const remainderPart = remainder ? twoDigitWords(remainder) : '';
  return hundredPart && remainderPart ? `${hundredPart} ${remainderPart}` : hundredPart || remainderPart;
};

const integerToWords = (num) => {
  if (num === 0) return 'Zero';
  // Above 99 crore the crore count itself is worded in full.
  const crore = Math.floor(num / 10000000);
  const lakh = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred = num % 1000;
  const parts = [];
  if (crore) parts.push(`${crore < 100 ? twoDigitWords(crore) : integerToWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigitWords(thousand)} Thousand`);
  if (hundred) parts.push(threeDigitWords(hundred));
  return parts.join(' ');
};

/** @param {number} rupees a whole number of rupees (anything else is floored) */
function amountInWords(rupees) {
  const whole = Number.isFinite(Number(rupees)) && Number(rupees) > 0 ? Math.floor(Number(rupees)) : 0;
  return `${integerToWords(whole)} ${whole === 1 ? 'Rupee' : 'Rupees'} Only`;
}

module.exports = { amountInWords };
