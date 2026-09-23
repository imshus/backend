const mongoose = require('mongoose');
const WastageCode = require('../models/wastageCode.model');
const {
  settingsScope,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
} = require('../services/userScope.service');

const normalizeCode = (raw) => String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');

const byCode = (a, b) => String(a.code).localeCompare(String(b.code));

/**
 * A percentage the shop may simply not have given. Blank stays blank rather
 * than becoming zero; anything outside 0–100 is refused.
 */
const toOptionalPercent = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
  return parsed;
};

/** The wastage codes this user reads, A to Z: their own list, else the shop's. */
const listWastageCodes = async (req, res) => {
  try {
    const rows = await findScopedRows(WastageCode, settingsScope(req.user));
    res.status(200).json({ success: true, data: [...rows].sort(byCode) });
  } catch (error) {
    console.error('List Wastage Codes Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch wastage codes' });
  }
};

/** Creates a code, or edits one when an id is sent along. */
const saveWastageCode = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const { id, code, percent } = req.body || {};
    const normalized = normalizeCode(code);
    const parsedPercent = toOptionalPercent(percent);

    if (!normalized) {
      return res.status(400).json({ success: false, message: 'Wastage code is required' });
    }
    if (normalized.length > 40) {
      return res.status(400).json({ success: false, message: 'Wastage code must stay under 40 characters' });
    }
    if (parsedPercent === undefined) {
      return res.status(400).json({ success: false, message: 'Wastage must be a percentage between 0 and 100' });
    }

    // An employee editing the shop's list for the first time gets their own
    // copy of the whole list, so one change never strands them with one row.
    await materializeOwnRows(WastageCode, scope);

    const set = { code: normalized, percent: parsedPercent };

    let row;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      const target = await resolveScopedRowById(WastageCode, scope, id, ['code']);
      if (!target) {
        return res.status(404).json({ success: false, message: 'Wastage code not found' });
      }
      target.set(set);
      row = await target.save();
    } else {
      row = await WastageCode.create({ businessId: scope.businessId, userId: scope.userId, ...set });
    }

    res.status(200).json({ success: true, data: row });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'This wastage code already exists' });
    }
    console.error('Save Wastage Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to save wastage code' });
  }
};

const deleteWastageCode = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    await materializeOwnRows(WastageCode, scope);
    const target = await resolveScopedRowById(WastageCode, scope, req.params.id, ['code']);
    if (target) await target.deleteOne();
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete Wastage Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete wastage code' });
  }
};

module.exports = {
  listWastageCodes,
  saveWastageCode,
  deleteWastageCode,
};
