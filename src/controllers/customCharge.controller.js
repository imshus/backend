const CustomCharge = require('../models/customCharge.model');
const {
  settingsScope,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
} = require('../services/userScope.service');

// Default charge names that are always available
const DEFAULT_CHARGES = [
  'Hall Marking',
  'HUIV',
  'Certificate',
  'Packing',
  'Insurance',
  'Design'
];

/**
 * Get all charge names (default + custom) for the business
 */
const getChargeNames = async (req, res) => {
  try {
    // The names this user reads: their own list once they have one, else the
    // shop's. isActive is applied afterwards on purpose — findScopedRows
    // decides "has this user a list of their own?" from what the query
    // returns, so filtering deleted names out of that question would let
    // someone who deleted all of theirs fall back to the shop's and watch
    // every name they removed return.
    const rows = await findScopedRows(CustomCharge, settingsScope(req.user));
    const customNames = rows
      .filter((charge) => charge.isActive)
      .map((charge) => charge.name)
      .sort((a, b) => a.localeCompare(b));

    // Combine default charges with custom charges
    const allCharges = [
      ...DEFAULT_CHARGES,
      ...customNames,
    ];

    res.status(200).json({
      success: true,
      data: {
        defaultCharges: DEFAULT_CHARGES,
        customCharges: customNames,
        allCharges,
      },
    });
  } catch (error) {
    console.error('Get Charge Names Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch charge names',
    });
  }
};

/**
 * Create a new custom charge name
 */
const createCustomCharge = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Charge name is required',
      });
    }

    const trimmedName = name.trim();

    // Check if it's a default charge
    if (DEFAULT_CHARGES.includes(trimmedName)) {
      return res.status(400).json({
        success: false,
        message: 'This charge name already exists in default charges',
      });
    }

    // An employee adding their first name gets their own copy of the list, so
    // this write cannot land on anyone else's.
    await materializeOwnRows(CustomCharge, scope);

    // Scoped: an unscoped lookup here would answer "already exists" because
    // somebody else holds the name, and would reactivate their row.
    const existing = await CustomCharge.findOne({
      businessId: scope.businessId,
      userId: scope.userId,
      name: trimmedName,
    });

    if (existing) {
      if (!existing.isActive) {
        // Reactivate if it was deactivated
        existing.isActive = true;
        await existing.save();
        return res.status(200).json({
          success: true,
          data: { id: existing.id, name: existing.name },
          message: 'Custom charge reactivated',
        });
      }
      return res.status(400).json({
        success: false,
        message: 'This custom charge already exists',
      });
    }

    // Create new custom charge
    const customCharge = await CustomCharge.create({
      businessId: scope.businessId,
      userId: scope.userId,
      name: trimmedName,
      isActive: true,
    });

    res.status(201).json({
      success: true,
      data: { id: customCharge.id, name: customCharge.name },
      message: 'Custom charge created successfully',
    });
  } catch (error) {
    console.error('Create Custom Charge Error:', error);
    
    // Handle unique constraint violation
    if (error && error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'This custom charge already exists',
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create custom charge',
    });
  }
};

/**
 * Delete a custom charge
 */
const deleteCustomCharge = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const { id } = req.params;

    // The id may still point at the shop row this user was inheriting; after
    // their own copy exists, the name is removed from that copy alone.
    await materializeOwnRows(CustomCharge, scope);
    const customCharge = await resolveScopedRowById(CustomCharge, scope, id, ['name']);

    if (!customCharge) {
      return res.status(404).json({
        success: false,
        message: 'Custom charge not found',
      });
    }

    // Soft delete by setting isActive to false
    customCharge.isActive = false;
    await customCharge.save();

    res.status(200).json({
      success: true,
      message: 'Custom charge deleted successfully',
    });
  } catch (error) {
    console.error('Delete Custom Charge Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete custom charge',
    });
  }
};

module.exports = {
  getChargeNames,
  createCustomCharge,
  deleteCustomCharge,
};
