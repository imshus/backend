const mongoose = require('mongoose');
const ItemCode = require('../models/itemCode.model');

const normalizeCode = (raw) => String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');

/** Every item code of the business, A to Z. */
const listItemCodes = async (req, res) => {
  try {
    const items = await ItemCode.find({ businessId: req.user.businessId }).sort({ code: 1 });
    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error('List Item Codes Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch item codes' });
  }
};

/** Creates a code, or renames/redescribes one when an id is sent along. */
const saveItemCode = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { id, code, description } = req.body || {};
    const normalized = normalizeCode(code);

    if (!normalized) {
      return res.status(400).json({ success: false, message: 'Item code is required' });
    }
    if (normalized.length > 40) {
      return res.status(400).json({ success: false, message: 'Item code must stay under 40 characters' });
    }

    const set = {
      code: normalized,
      description: String(description || '').trim().slice(0, 200),
    };

    let item;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      item = await ItemCode.findOneAndUpdate({ _id: id, businessId }, { $set: set }, { new: true });
      if (!item) {
        return res.status(404).json({ success: false, message: 'Item code not found' });
      }
    } else {
      item = await ItemCode.create({ businessId, ...set });
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
    await ItemCode.findOneAndDelete({ _id: req.params.id, businessId: req.user.businessId });
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete Item Code Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete item code' });
  }
};

module.exports = {
  listItemCodes,
  saveItemCode,
  deleteItemCode,
};
