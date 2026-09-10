const mongoose = require('mongoose');
const ItemCode = require('../models/itemCode.model');
const {
  settingsScope,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
} = require('../services/userScope.service');

const normalizeCode = (raw) => String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');

const byCode = (a, b) => String(a.code).localeCompare(String(b.code));

/**
 * The item codes this user reads, A to Z: their own list when they have one,
 * otherwise the shop's. The owner's list is the shop's.
 */
const listItemCodes = async (req, res) => {
  try {
    const items = await findScopedRows(ItemCode, settingsScope(req.user));
    res.status(200).json({ success: true, data: [...items].sort(byCode) });
  } catch (error) {
    console.error('List Item Codes Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch item codes' });
  }
};

/** Creates a code, or renames/redescribes one when an id is sent along. */
const saveItemCode = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const { id, code, description } = req.body || {};
    const normalized = normalizeCode(code);

    if (!normalized) {
      return res.status(400).json({ success: false, message: 'Item code is required' });
    }
    if (normalized.length > 40) {
      return res.status(400).json({ success: false, message: 'Item code must stay under 40 characters' });
    }

    // An employee editing the shop's list for the first time gets their own
    // copy of the whole list, so one change never strands them with one row.
    await materializeOwnRows(ItemCode, scope);

    const set = {
      code: normalized,
      description: String(description || '').trim().slice(0, 200),
    };

    let item;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      // The id may still point at the shop row this user was inheriting; the
      // matching row in their own list is what gets written.
      const target = await resolveScopedRowById(ItemCode, scope, id, ['code']);
      if (!target) {
        return res.status(404).json({ success: false, message: 'Item code not found' });
      }
      target.set(set);
      item = await target.save();
    } else {
      item = await ItemCode.create({ businessId: scope.businessId, userId: scope.userId, ...set });
    }

    res.status(200).json({ success: true, data: item });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'This item code already exists' });
    }
    console.error('Save Item Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to save item code' });
  }
};

const deleteItemCode = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    await materializeOwnRows(ItemCode, scope);
    const target = await resolveScopedRowById(ItemCode, scope, req.params.id, ['code']);
    if (target) await target.deleteOne();
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete Item Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete item codes' });
  }
};

module.exports = {
  listItemCodes,
  saveItemCode,
  deleteItemCode,
};
