/**
 * PDFMonkey service — wraps the REST API.
 *
 * Uses the /api/v1/documents/sync endpoint which polls server-side and
 * returns the final download_url in a single HTTP call (~2-10 seconds).
 */

const config = require('../config/env');

const PDFMONKEY_BASE_URL = 'https://api.pdfmonkey.io/api/v1';
const API_SECRET = config.pdfmonkey.apiSecret;

// Two PDFMonkey templates, one per document. The plain tax invoice renders
// through the preview template; a document carrying an IRN band (live or
// test e-invoice) renders through the e-invoice template. Read through the
// validated config so the ids' defaults apply even on a server whose .env
// never mentions them; the legacy single PDFMONKEY_TEMPLATE_ID is the
// fallback for either.
const LEGACY_TEMPLATE_ID = config.pdfmonkey.templateId || '';
const PREVIEW_TEMPLATE_ID = config.pdfmonkey.previewTemplateId || LEGACY_TEMPLATE_ID;
const E_INVOICE_TEMPLATE_ID = config.pdfmonkey.eInvoiceTemplateId || PREVIEW_TEMPLATE_ID;

if (!PREVIEW_TEMPLATE_ID || !API_SECRET) {
  console.warn('[PDFMonkey] template id or PDFMONKEY_API_SECRET not set in .env');
}

/** The template a payload renders through: e-invoice when it carries an IRN. */
function templateIdFor(payload) {
  return String(payload?.irn || '').trim() ? E_INVOICE_TEMPLATE_ID : PREVIEW_TEMPLATE_ID;
}

/**
 * Generates a PDF synchronously via PDFMonkey and returns the download URL.
 * @param {object} payload  – The invoice data object sent to the template
 * @param {string} filename – Desired filename for the PDF (without path)
 * @returns {Promise<{ downloadUrl: string, docId: string }>}
 */
async function generateInvoicePdf(payload, filename) {
  const templateId = templateIdFor(payload);
  console.info('[PDFMonkey] rendering', {
    filename,
    template: templateId === E_INVOICE_TEMPLATE_ID && templateId !== PREVIEW_TEMPLATE_ID ? 'e-invoice' : 'preview',
  });
  const response = await fetch(`${PDFMONKEY_BASE_URL}/documents/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      document: {
        document_template_id: templateId,
        status: 'pending',
        payload,
        meta: {
          _filename: filename,
        },
      },
    }),
    // Sync endpoint can take up to 5 minutes on PDFMonkey's side, but in
    // practice jewellery invoices finish in 3-10 s. Node's default is fine.
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`PDFMonkey API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const card = data.document_card;

  if (!card) {
    throw new Error('PDFMonkey returned no document_card in response');
  }

  if (card.status === 'failure') {
    throw new Error(`PDFMonkey generation failed: ${card.failure_cause ?? 'unknown reason'}`);
  }

  if (!card.download_url) {
    throw new Error('PDFMonkey returned success but download_url is empty');
  }

  return {
    downloadUrl: card.download_url,
    docId: card.id,
  };
}

/**
 * Fetches a fresh download URL for an already-generated document.
 *
 * The URL returned by generateInvoicePdf is a signed link that expires, so it
 * cannot be handed out later from a QR code. Given the stored document id this
 * asks PDFMonkey for a currently-valid one.
 *
 * @param {string} docId – PDFMonkey document id stored on the invoice
 * @returns {Promise<string>} a currently-valid download URL
 */
async function getDownloadUrl(docId) {
  const response = await fetch(`${PDFMONKEY_BASE_URL}/documents/${docId}`, {
    headers: { Authorization: `Bearer ${API_SECRET}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`PDFMonkey API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const card = data.document ?? data.document_card;
  const url = card?.download_url;

  if (!url) {
    throw new Error(`PDFMonkey returned no download_url for document ${docId}`);
  }

  return url;
}

module.exports = { generateInvoicePdf, getDownloadUrl };
