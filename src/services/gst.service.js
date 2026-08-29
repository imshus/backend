const axios = require('axios');
const config = require('../config/env');

// Sandbox (sandbox.co.in) GST verification.
// Auth: POST /authenticate with x-api-key + x-api-secret -> JWT access token (valid 24h).
// Search: POST /gst/compliance/public/gstin/search with { gstin } -> GSTN public data.

const SANDBOX_BASE_URL = 'https://api.sandbox.co.in';

let accessToken = null;
let tokenExpiry = 0;

const getAccessToken = async () => {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  try {
    const response = await axios.post(`${SANDBOX_BASE_URL}/authenticate`, null, {
      headers: {
        'x-api-key': config.sandbox.apiKey,
        'x-api-secret': config.sandbox.apiSecret,
        'x-api-version': config.sandbox.apiVersion,
        'Content-Type': 'application/json'
      }
    });

    const token = response.data?.data?.access_token || response.data?.access_token;
    if (!token) {
      throw new Error('No access token in Sandbox authenticate response');
    }

    accessToken = token;
    // Sandbox tokens are valid for 24 hours; refresh after 23h to stay safe.
    tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

    return accessToken;
  } catch (error) {
    console.error('[GST Service] Failed to obtain Sandbox access token:', error.response?.data || error.message);
    throw new Error('GST_AUTH_FAILED');
  }
};

const formatAddress = (addrObj) => {
  if (!addrObj) return '';
  const fields = [
    addrObj.bno,
    addrObj.flno,
    addrObj.bnm,
    addrObj.st,
    addrObj.loc,
    addrObj.city,
    addrObj.dst,
    addrObj.stcd,
    addrObj.pncd
  ];
  return fields
    .filter(field => field && String(field).trim() !== '')
    .map(field => String(field).trim())
    .join(', ');
};

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// GST_VERIFY_MODE=mock (dev only): accept any structurally valid GSTIN and
// return stub details so registration can be exercised without Sandbox keys.
const mockVerifyGST = (gstNumber) => {
  const gstin = gstNumber.toUpperCase();
  if (!GSTIN_PATTERN.test(gstin)) {
    throw new Error('INVALID_GST_NUMBER');
  }

  console.warn(`[GST Service] GST_VERIFY_MODE=mock — returning stub data for ${gstin} (no real GSTN lookup).`);
  return {
    gstNumber: gstin,
    legalName: 'Dev Mode Business',
    tradeName: 'Dev Mode Business',
    businessType: 'Regular',
    companyType: 'Regular',
    address: 'Dev Mode Address, India',
    stateCode: gstin.substring(0, 2),
    stateName: '',
    pincode: '',
    gstStatus: 'Active'
  };
};

const verifyGST = async (gstNumber) => {
  if (!gstNumber || gstNumber.length < 15) {
      throw new Error('INVALID_GST_NUMBER');
  }

  if (config.gstVerifyMode === 'mock') {
    return mockVerifyGST(gstNumber);
  }

  try {
    const token = await getAccessToken();

    const response = await axios.post(
      `${SANDBOX_BASE_URL}/gst/compliance/public/gstin/search`,
      { gstin: gstNumber.toUpperCase() },
      {
        headers: {
          // Sandbox expects the raw JWT here — no "Bearer" prefix.
          'authorization': token,
          'x-api-key': config.sandbox.apiKey,
          'x-api-version': config.sandbox.apiVersion,
          'Content-Type': 'application/json'
        }
      }
    );

    // Response shape: { code, data: { data: { ...gstn fields }, status_cd }, ... }
    const envelope = response.data;
    if (!envelope || envelope.code !== 200) {
      throw new Error('INVALID_GST_NUMBER');
    }

    const payload = envelope.data || {};
    if (payload.status_cd !== undefined && String(payload.status_cd) === '0') {
      throw new Error('INVALID_GST_NUMBER');
    }

    const data = payload.data || payload;
    if (!data || !data.gstin) {
      throw new Error('INVALID_GST_NUMBER');
    }

    const tradeName = data.tradeNam || data.lgnm || '';
    const legalName = data.lgnm || data.tradeNam || '';
    const companyType = data.ctb || 'Regular';

    const addrObj = data.pradr && data.pradr.addr ? data.pradr.addr : {};
    const address = formatAddress(addrObj);

    return {
      gstNumber: data.gstin || gstNumber.toUpperCase(),
      legalName: legalName,
      tradeName: tradeName,
      businessType: companyType, // Keeping this for backward compatibility
      companyType: companyType, // Added specific companyType
      address: address || 'N/A',
      stateCode: data.stjCd || gstNumber.substring(0, 2),
      stateName: addrObj.stcd || '',
      pincode: addrObj.pncd || '',
      gstStatus: data.sts || 'Active'
    };

  } catch (error) {
    console.error('[GST Service] Failed to verify GST:', error.response?.data || error.message);
    if (error.message === 'INVALID_GST_NUMBER') throw error;
    throw new Error('GST_VERIFICATION_FAILED');
  }
};

module.exports = {
  verifyGST
};
