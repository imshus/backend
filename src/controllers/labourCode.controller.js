const mongoose = require('mongoose');
const LabourCode = require('../models/labourCode.model');
const {
  settingsScope,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
} = require('../services/userScope.service');
const { codeKey } = require('../services/labourResolution.service');
const { labourUnitOf } = require('../services/pricingInputs');

const MAX_CODE_LENGTH = 20;
// Past this a rupee rate is a mistake, not a labour charge (as a /calculate
// body's labour).
const MAX_RUPEE_RATE = 1e9;

const normalizeCode = (raw) => String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');

const byCode = (a, b) => String(a.code).localeCompare(String(b.code));

/** 'Per Gram' when none is sent; null for a unit that is none of the three. */
const toUnit = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return 'Per Gram';
  return typeof value === 'string' ? labourUnitOf(value) : null;
};

/**
 * A code's rate, which every code must have: picking a code on the card
 * fills the Labour Rate box with it, and a code without one left the box
 * holding another code's or the shop's rate, recorded against this code.
 * Blank is null (refused as missing, never read as zero); a negative
 * figure, or a percent above 100, is undefined (refused as out of range).
 */
const toRate = (value, unit) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/[₹,\s]/g, ''));
  const max = unit === 'Percent' ? 100 : MAX_RUPEE_RATE;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return undefined;
  return parsed;
};

/** The labour codes this user reads, A to Z: their own list, else the shop's. */
const listLabourCodes = async (req, res) => {
  try {
    const rows = await findScopedRows(LabourCode, settingsScope(req.user));
    res.status(200).json({ success: true, data: [...rows].sort(byCode) });
  } catch (error) {
    console.error('List Labour Codes Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch labour codes' });
  }
};

/** Creates a code, or edits one when an id is sent along. */
const saveLabourCode = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const { id, code, rate, unit } = req.body || {};
    const normalized = normalizeCode(code);
    const parsedUnit = toUnit(unit);

    if (!normalized || !codeKey(normalized)) {
      return res.status(400).json({ success: false, message: 'Labour code is required' });
    }
    if (normalized.length > MAX_CODE_LENGTH) {
      return res.status(400).json({ success: false, message: `Labour code must stay within ${MAX_CODE_LENGTH} characters` });
    }
    if (!parsedUnit) {
      return res.status(400).json({ success: false, message: 'Unit must be "Per Gram", "Per 10 Gram" or "Percent"' });
    }
    const parsedRate = toRate(rate, parsedUnit);
    if (parsedRate === null) {
      return res.status(400).json({ success: false, message: 'Labour rate is required' });
    }
    if (parsedRate === undefined) {
      return res.status(400).json({
        success: false,
        message: parsedUnit === 'Percent'
          ? 'Labour must be a percentage between 0 and 100'
          : 'Labour rate must be a number of rupees, 0 or more',
      });
    }

    // An employee editing the shop's list for the first time gets their own
    // copy of the whole list, so one change never strands them with one row.
    await materializeOwnRows(LabourCode, scope);

    let target = null;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      target = await resolveScopedRowById(LabourCode, scope, id, ['code']);
      if (!target) {
        return res.status(404).json({ success: false, message: 'Labour code not found' });
      }
    }

    // One code per list, whatever its spacing or punctuation: LB-01 and
    // LB 01 would both match a tag printing LB01.
    const ownRows = await LabourCode.find({ businessId: scope.businessId, userId: scope.userId ?? null });
    const key = codeKey(normalized);
    const clash = ownRows.find(
      (row) => codeKey(row.code) === key && (!target || String(row._id) !== String(target._id)),
    );
    if (clash) {
      return res.status(409).json({ success: false, message: 'This labour code already exists' });
    }

    const set = { code: normalized, rate: parsedRate, unit: parsedUnit };

    let row;
    if (target) {
      target.set(set);
      row = await target.save();
    } else {
      row = await LabourCode.create({ businessId: scope.businessId, userId: scope.userId, ...set });
    }

    res.status(200).json({ success: true, data: row });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'This labour code already exists' });
    }
    console.error('Save Labour Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to save labour code' });
  }
};

const deleteLabourCode = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    await materializeOwnRows(LabourCode, scope);
    const target = mongoose.Types.ObjectId.isValid(req.params.id)
      ? await resolveScopedRowById(LabourCode, scope, req.params.id, ['code'])
      : null;
    if (target) await target.deleteOne();
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete Labour Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete labour code' });
  }
};

module.exports = {
  listLabourCodes,
  saveLabourCode,
  deleteLabourCode,
};
