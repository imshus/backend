/**
 * PDFMonkey service — wraps the REST API.
 *
 * Uses the /api/v1/documents/sync endpoint which polls server-side and
 * returns the final download_url in a single HTTP call (~2-10 seconds).
 */

const PDFMONKEY_BASE_URL = 'https://api.pdfmonkey.io/api/v1';
const TEMPLATE_ID = process.env.PDFMONKEY_TEMPLATE_ID;
const API_SECRET = process.env.PDFMONKEY_API_SECRET;

if (!TEMPLATE_ID || !API_SECRET) {
  console.warn('[PDFMonkey] PDFMONKEY_TEMPLATE_ID or PDFMONKEY_API_SECRET not set in .env');
}

/**
 * Generates a PDF synchronously via PDFMonkey and returns the download URL.
 * @param {object} payload  – The invoice data object sent to the template
 * @param {string} filename – Desired filename for the PDF (without path)
 * @returns {Promise<{ downloadUrl: string, docId: string }>}
 */
async function generateInvoicePdf(payload, filename) {
  const response = await fetch(`${PDFMONKEY_BASE_URL}/documents/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      document: {
        document_template_id: TEMPLATE_ID,
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

module.exports = { generateInvoicePdf };
