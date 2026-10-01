/**
 * MRPscan's own invoice for a licence or credit payment, as an HTML email
 * in the app's look: the cream page, the deep-red band the dashboard header
 * uses, khaki labels, and the serif display face for the brand.
 *
 * A pure function of the payment, the shop and the seller, so it can be
 * rendered in tests and previews without a database. Laid out with tables
 * and inline styles, which is what mail clients honour.
 *
 * It is titled "Tax Invoice" only when the seller's GSTIN is configured; until
 * then it is a "Payment Receipt", so no document goes out claiming to be a
 * tax invoice without one.
 */

const COLORS = {
  page: '#FBF7F0',
  card: '#FFFFFF',
  alt: '#F4ECDC',
  border: '#E9DDC4',
  text: '#15120D',
  label: '#857A63',
  brand: '#A81F17',
  khaki: '#C7B792',
  success: '#1A8A4A',
  successBg: '#E7F4EC',
};

const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "Roboto, 'Segoe UI', Arial, sans-serif";

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value) => `₹ ${inr.format(Number(value) || 0)}`;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** DD-MM-YYYY in India time, as the shop's own invoices print it. */
const istDate = (value) => {
  const date = value ? new Date(value) : new Date();
  return date
    .toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
    .split('/')
    .join('-');
};

const istTime = (value) => (value ? new Date(value) : new Date())
  .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
  .toUpperCase();

/** The two-digit state code a GSTIN starts with, or ''. */
const stateOfGstin = (gstin) => {
  const code = String(gstin || '').trim().slice(0, 2);
  return /^\d{2}$/.test(code) ? code : '';
};

/** The shop's state: its saved state code, else the one its GSTIN starts with. */
const buyerStateOf = (business) => {
  const code = String(business?.stateCode ?? '').trim();
  return /^\d{1,2}$/.test(code) && Number(code) > 0 ? code.padStart(2, '0') : stateOfGstin(business?.gstNumber);
};

/**
 * The GST lines: CGST + SGST when seller and buyer are in one state, IGST
 * across states, a single GST line when either state is unknown, none when
 * nothing was charged (credit recharges carry no GST).
 */
const taxLines = ({ gstAmount, gstPercent, sellerState, buyerState }) => {
  const gst = Number(gstAmount) || 0;
  if (gst <= 0) return [];
  if (sellerState && buyerState && sellerState === buyerState) {
    const half = Math.round((gst / 2) * 100) / 100;
    return [
      { label: `CGST @ ${gstPercent / 2}%`, amount: half },
      { label: `SGST @ ${gstPercent / 2}%`, amount: Math.round((gst - half) * 100) / 100 },
    ];
  }
  if (sellerState && buyerState) return [{ label: `IGST @ ${gstPercent}%`, amount: gst }];
  return [{ label: `GST @ ${gstPercent}%`, amount: gst }];
};

/** What was bought, as the invoice's one line. */
const describe = (txn, bonusCredits) => {
  if (txn.paymentType === 'APPLICATION_PURCHASE') {
    return {
      title: 'MRPscan Application Licence',
      note: `Lifetime access${bonusCredits ? ` · ${inr.format(bonusCredits).replace(/\.00$/, '')} bonus credits included` : ''}`,
    };
  }
  return {
    title: 'MRPscan Scan Credits',
    note: `${money(txn.creditsPurchased || txn.amount)} of credits added to the wallet`,
  };
};

/**
 * @param {object} args
 * @param {object} args.txn       payment transaction (amount, baseAmount, gstAmount, invoiceNumber, …)
 * @param {object} args.business  the shop: legalName, tradeName, gstNumber, address, stateName, pincode
 * @param {object} args.seller    { name, address, gstin, email }
 * @param {number} [args.bonusCredits] credits granted with a licence
 * @returns {{ subject: string, html: string, text: string, title: string }}
 */
function buildPaymentInvoice({ txn, business = {}, seller = {}, bonusCredits = 0 }) {
  const isTaxInvoice = Boolean(String(seller.gstin || '').trim());
  const title = isTaxInvoice ? 'Tax Invoice' : 'Payment Receipt';
  const amount = Number(txn.amount) || 0;
  const gstAmount = Number(txn.gstAmount) || 0;
  const taxable = Number(txn.baseAmount) > 0 ? Number(txn.baseAmount) : Math.max(0, amount - gstAmount);
  const gstPercent = gstAmount > 0 && taxable > 0 ? Math.round((gstAmount / taxable) * 100) : 0;
  const lines = taxLines({
    gstAmount,
    gstPercent,
    sellerState: stateOfGstin(seller.gstin),
    buyerState: buyerStateOf(business),
  });
  const item = describe(txn, bonusCredits);
  const shopName = business.tradeName || business.legalName || txn.organizationTradeName || txn.organizationLegalName || 'Customer';
  const shopLegal = business.legalName && business.legalName !== shopName ? business.legalName : '';
  const shopGstin = business.gstNumber || txn.organizationGstNumber || '';
  const shopAddress = [business.address, [business.stateName, business.pincode].filter(Boolean).join(' - ')]
    .filter(Boolean)
    .join(', ');
  const number = txn.invoiceNumber || txn.receipt || txn.orderId;
  const paidAt = txn.capturedAt || txn.verifiedAt || txn.invoiceDate;

  const label = (text) => `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${COLORS.label};margin-bottom:6px;">${escapeHtml(text)}</div>`;
  const party = ({ heading, name, legal, lines: rows }) => `
    ${label(heading)}
    <div style="font-family:${SANS};font-size:15px;font-weight:800;color:${COLORS.text};">${escapeHtml(name)}</div>
    ${legal ? `<div style="font-family:${SANS};font-size:12.5px;color:${COLORS.label};margin-top:2px;">${escapeHtml(legal)}</div>` : ''}
    ${rows.filter(Boolean).map((row) => `<div style="font-family:${SANS};font-size:12.5px;line-height:1.5;color:${COLORS.text};margin-top:3px;">${row}</div>`).join('')}`;

  const totalRow = (text, value, strong = false) => `
    <tr>
      <td style="padding:7px 16px;font-family:${SANS};font-size:${strong ? 15 : 13}px;font-weight:${strong ? 800 : 600};color:${strong ? COLORS.text : COLORS.label};">${escapeHtml(text)}</td>
      <td align="right" style="padding:7px 16px;font-family:${SANS};font-size:${strong ? 17 : 13}px;font-weight:${strong ? 900 : 700};color:${strong ? COLORS.brand : COLORS.text};white-space:nowrap;">${money(value)}</td>
    </tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(`${title} ${number}`)}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:18px;overflow:hidden;">

  <tr><td style="background:${COLORS.brand};padding:22px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${SERIF};font-size:26px;font-weight:800;color:#FFFFFF;">MRPscan</td>
      <td align="right" style="font-family:${SANS};">
        <div style="font-size:16px;font-weight:800;color:#FFFFFF;">${escapeHtml(title)}</div>
        <div style="font-size:12px;font-weight:600;color:#F6D9D5;margin-top:3px;">${escapeHtml(number)}</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:18px 24px 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${SANS};font-size:12.5px;color:${COLORS.label};">Date <b style="color:${COLORS.text};">${istDate(txn.invoiceDate || paidAt)}</b></td>
      <td align="right"><span style="display:inline-block;background:${COLORS.successBg};color:${COLORS.success};font-family:${SANS};font-size:12px;font-weight:800;padding:5px 11px;border-radius:999px;">&#10003; Paid</span></td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:12px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top" width="50%" style="padding-right:10px;">${party({
        heading: 'From',
        name: seller.name || 'Amitaash IT Solutions Private Limited',
        lines: [
          seller.address ? escapeHtml(seller.address) : '',
          seller.gstin ? `GSTIN <b>${escapeHtml(seller.gstin)}</b>` : '',
          seller.email ? escapeHtml(seller.email) : '',
        ],
      })}</td>
      <td valign="top" width="50%" style="padding-left:10px;border-left:1px solid ${COLORS.border};">${party({
        heading: 'Billed to',
        name: shopName,
        legal: shopLegal,
        lines: [
          shopAddress ? escapeHtml(shopAddress) : '',
          shopGstin ? `GSTIN <b>${escapeHtml(shopGstin)}</b>` : '',
        ],
      })}</td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:10px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.border};border-radius:14px;overflow:hidden;">
      <tr style="background:${COLORS.alt};">
        <td style="padding:10px 16px;font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${COLORS.label};">Description</td>
        <td align="right" style="padding:10px 16px;font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${COLORS.label};">Amount</td>
      </tr>
      <tr>
        <td style="padding:14px 16px;border-top:1px solid ${COLORS.border};">
          <div style="font-family:${SANS};font-size:14.5px;font-weight:800;color:${COLORS.text};">${escapeHtml(item.title)}</div>
          <div style="font-family:${SANS};font-size:12.5px;color:${COLORS.label};margin-top:3px;">${escapeHtml(item.note)}</div>
        </td>
        <td align="right" valign="top" style="padding:14px 16px;border-top:1px solid ${COLORS.border};font-family:${SANS};font-size:14px;font-weight:700;color:${COLORS.text};white-space:nowrap;">${money(taxable)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:10px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};border:1px solid ${COLORS.border};border-radius:14px;">
      ${lines.length ? totalRow('Taxable value', taxable) : ''}
      ${lines.map((line) => totalRow(line.label, line.amount)).join('')}
      <tr><td colspan="2" style="padding:0 16px;"><div style="border-top:1px dashed ${COLORS.khaki};"></div></td></tr>
      ${totalRow('Total paid', amount, true)}
    </table>
  </td></tr>

  <tr><td style="padding:16px 24px 6px;">
    ${label('Payment')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${SANS};font-size:12.5px;color:${COLORS.text};">
      <tr><td style="padding:3px 0;color:${COLORS.label};">Paid on</td><td align="right" style="padding:3px 0;font-weight:700;">${istDate(paidAt)}, ${istTime(paidAt)}</td></tr>
      <tr><td style="padding:3px 0;color:${COLORS.label};">Method</td><td align="right" style="padding:3px 0;font-weight:700;">Razorpay</td></tr>
      ${txn.paymentId ? `<tr><td style="padding:3px 0;color:${COLORS.label};">Payment ID</td><td align="right" style="padding:3px 0;font-weight:700;">${escapeHtml(txn.paymentId)}</td></tr>` : ''}
      <tr><td style="padding:3px 0;color:${COLORS.label};">Order ID</td><td align="right" style="padding:3px 0;font-weight:700;">${escapeHtml(txn.orderId)}</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:16px 24px 22px;">
    <div style="border-top:1px solid ${COLORS.border};padding-top:14px;font-family:${SANS};font-size:12px;line-height:1.55;color:${COLORS.label};text-align:center;">
      Thank you for choosing MRPscan.<br>
      This is a computer-generated ${isTaxInvoice ? 'invoice' : 'receipt'} and needs no signature.${seller.email ? `<br>Questions? Write to <a href="mailto:${escapeHtml(seller.email)}" style="color:${COLORS.brand};font-weight:700;text-decoration:none;">${escapeHtml(seller.email)}</a>` : ''}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    `MRPscan — ${title} ${number}`,
    `Date: ${istDate(txn.invoiceDate || paidAt)}`,
    '',
    `From: ${seller.name || 'Amitaash IT Solutions Private Limited'}${seller.gstin ? ` (GSTIN ${seller.gstin})` : ''}`,
    `Billed to: ${shopName}${shopGstin ? ` (GSTIN ${shopGstin})` : ''}`,
    '',
    `${item.title} — ${item.note}: ${money(taxable)}`,
    ...lines.map((line) => `${line.label}: ${money(line.amount)}`),
    `Total paid: ${money(amount)}`,
    '',
    `Paid on ${istDate(paidAt)}, ${istTime(paidAt)} via Razorpay`,
    txn.paymentId ? `Payment ID: ${txn.paymentId}` : '',
    `Order ID: ${txn.orderId}`,
  ].filter((row, index, all) => row !== '' || all[index - 1] !== '').join('\n');

  return {
    title,
    subject: `MRPscan ${title} ${number} — ${money(amount)} paid`,
    html,
    text,
  };
}

module.exports = { buildPaymentInvoice, taxLines, stateOfGstin };
