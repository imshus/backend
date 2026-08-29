const CustomCharge = require('../models/customCharge.model');

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
    const businessId = req.user.businessId;

    // Fetch custom charges for this business
    const customCharges = await CustomCharge.find({
      businessId,
      isActive: true,
    }).sort({ name: 1 });

    const customNames = customCharges.map((charge) => charge.name);

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
    const businessId = req.user.businessId;
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

    // Check if custom charge already exists
    const existing = await CustomCharge.findOne({
      businessId,
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
      businessId,
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
    const businessId = req.user.businessId;
    const { id } = req.params;

    const customCharge = await CustomCharge.findOne({
      _id: id,
      businessId,
    });

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
