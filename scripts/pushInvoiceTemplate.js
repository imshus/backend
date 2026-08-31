/**
 * Uploads templates/invoice-pdfmonkey.html into the PDFMonkey account.
 *
 * The template is not part of this codebase at runtime: pdfmonkey.service.js
 * sends only a document_template_id, and PDFMonkey renders whatever HTML is
 * stored under that id. Editing the local file changes nothing until it is
 * pushed here.
 *
 *   node scripts/pushInvoiceTemplate.js --dry-run   # validate, no network
 *   node scripts/pushInvoiceTemplate.js             # back up, then upload
 *
 * IMPORTANT: deploy the backend BEFORE running this. The new template reads
 * payload keys (qty_display, unit_display, subtotal_display, grand_total_display,
 * qr_code_image) that only the new controller sends. Pushing the template to an
 * old backend prints invoices with blank quantities and amounts.
 *
 * The current template body is always saved to backend/templates/backups/
 * before anything is overwritten.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const API = 'https://api.pdfmonkey.io/api/v1';
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'invoice-pdfmonkey.html');
const BACKUP_DIR = path.join(__dirname, '..', 'templates', 'backups');

const DRY_RUN = process.argv.includes('--dry-run');

// Keys the template needs the backend to supply. Listed so the failure mode
// (blank cells on a real invoice) is caught here instead of on paper.
const REQUIRED_PAYLOAD_KEYS = [
  'qty_display',
  'unit_display',
  'price_display',
  'amount_display',
  'subtotal_display',
  'grand_total_display',
  'qr_code_image',
];

async function main() {
  const templateId = process.env.PDFMONKEY_TEMPLATE_ID;
  const apiSecret = process.env.PDFMONKEY_API_SECRET;

  if (!templateId || !apiSecret) {
    console.error('PDFMONKEY_TEMPLATE_ID and PDFMONKEY_API_SECRET must be set.');
    process.exitCode = 1;
    return;
  }

  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  console.log(`Local template: ${TEMPLATE_PATH}`);
  console.log(`  ${html.length} bytes, target template ${templateId}`);

  // Guard against pushing a template the controller cannot feed.
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'invoice.controller.js'),
    'utf8',
  );
  const missing = REQUIRED_PAYLOAD_KEYS.filter(
    (key) => html.includes(key) && !controller.includes(key),
  );
  if (missing.length) {
    console.error(
      `\nRefusing to push: the template uses ${missing.join(', ')}, which this ` +
        'controller does not send. Deploy the matching backend first.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('  payload keys check: OK');

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was sent. Re-run without --dry-run to upload.');
    return;
  }

  const headers = {
    Authorization: `Bearer ${apiSecret}`,
    'Content-Type': 'application/json',
  };

  // 1. Back up whatever is live right now.
  const current = await fetch(`${API}/document_templates/${templateId}`, { headers });
  if (!current.ok) {
    console.error(`Could not read the current template: ${current.status} ${await current.text()}`);
    process.exitCode = 1;
    return;
  }
  const currentBody = (await current.json())?.document_template?.body ?? '';

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `invoice-${stamp}.html`);
  fs.writeFileSync(backupPath, currentBody, 'utf8');
  console.log(`\nBacked up the live template (${currentBody.length} bytes) to:`);
  console.log(`  ${backupPath}`);

  // 2. Upload the new one.
  const res = await fetch(`${API}/document_templates/${templateId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ document_template: { body: html } }),
  });

  if (!res.ok) {
    console.error(`\nUpload failed: ${res.status} ${await res.text()}`);
    console.error(`The live template is unchanged. Backup kept at ${backupPath}`);
    process.exitCode = 1;
    return;
  }

  // 3. Confirm what is actually stored now.
  const after = await fetch(`${API}/document_templates/${templateId}`, { headers });
  const storedBody = (await after.json())?.document_template?.body ?? '';

  if (storedBody.trim() === html.trim()) {
    console.log('\nUploaded and verified — the live template matches the local file.');
  } else {
    console.error(
      `\nUploaded, but the stored body differs (${storedBody.length} vs ${html.length} bytes). ` +
        'Check the PDFMonkey dashboard.',
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exitCode = 1;
});
