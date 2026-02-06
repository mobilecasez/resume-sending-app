const dbConfig = require('../../db-config');

/**
 * Admin/Packages Controller
 * Handles all package/plan management operations for administrators
 */

// Get all active packages (public endpoint for users)
const getActivePackages = async (req, res) => {
    try {
        const result = await dbConfig.query(`
            SELECT id, name, price as amount, credits, validity_days, description, 'USD' as currency, is_popular, display_order
            FROM plans 
            WHERE is_active = 1
            ORDER BY display_order ASC, id ASC
        `, []);
        res.json({ packages: result.rows || result });
    } catch (error) {
        console.error('Error fetching packages:', error);
        res.status(500).json({ error: 'Failed to fetch packages' });
    }
};

// Get all packages including inactive (admin only)
const getAllPackages = async (req, res) => {
    try {
        const packages = await dbConfig.query(`
            SELECT 
                id,
                name,
                credits,
                price as amount,
                validity_days,
                description,
                features,
                is_active,
                'USD' as currency,
                is_popular,
                display_order,
                created_at,
                updated_at
            FROM plans 
            ORDER BY id ASC
        `, []);
        res.json({ packages });
    } catch (error) {
        console.error('Error fetching packages:', error);
        res.status(500).json({ error: 'Failed to fetch packages' });
    }
};

// Get single package by ID (admin only)
const getPackageById = async (req, res) => {
    const { id } = req.params;
    
    try {
        const package = await dbConfig.get(`
            SELECT 
                id,
                name,
                credits,
                price as amount,
                validity_days,
                description,
                features,
                is_active,
                'USD' as currency,
                is_popular,
                display_order,
                created_at,
                updated_at
            FROM plans 
            WHERE id = ?
        `, [id]);
        
        if (!package) {
            return res.status(404).json({ error: 'Package not found' });
        }
        res.json({ package });
    } catch (error) {
        console.error('Error fetching package:', error);
        res.status(500).json({ error: 'Failed to fetch package' });
    }
};

// Create new package (admin only)
const createPackage = async (req, res) => {
    const { name, amount, credits, validity_days, description, currency, is_popular, display_order } = req.body;
    
    // Validation
    if (!name || amount === undefined || !credits || !validity_days) {
        return res.status(400).json({ error: 'Missing required fields: name, amount, credits, validity_days' });
    }
    
    if (amount < 0 || credits < 1 || validity_days < 1) {
        return res.status(400).json({ error: 'Invalid values for amount, credits, or validity_days' });
    }
    
    try {
        const result = await dbConfig.run(`
            INSERT INTO plans (name, price, credits, validity_days, description, is_active, is_popular, display_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [
            name, 
            amount, 
            credits, 
            validity_days, 
            description || null,
            1,
            is_popular !== undefined ? (is_popular ? 1 : 0) : 0,
            display_order || 0
        ]);
        
        const packageId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
        
        res.json({ 
            success: true, 
            message: 'Package created successfully',
            packageId: packageId
        });
    } catch (error) {
        console.error('Error creating package:', error);
        return res.status(500).json({ error: 'Failed to create package' });
    }
};

// Update existing package (admin only)
const updatePackage = async (req, res) => {
    const { id } = req.params;
    const { name, amount, credits, validity_days, description, currency, is_active, is_popular, display_order } = req.body;
    
    // Validation
    if (!name || amount === undefined || !credits || !validity_days) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (amount < 0 || credits < 1 || validity_days < 1) {
        return res.status(400).json({ error: 'Invalid values' });
    }
    
    try {
        const result = await dbConfig.run(`
            UPDATE plans 
            SET name = ?, 
                price = ?, 
                credits = ?, 
                validity_days = ?, 
                description = ?, 
                is_active = ?,
                is_popular = ?,
                display_order = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            name, 
            amount, 
            credits, 
            validity_days, 
            description || null,
            is_active !== undefined ? (is_active ? 1 : 0) : 1,
            is_popular !== undefined ? (is_popular ? 1 : 0) : 0,
            display_order || 0,
            id
        ]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Package not found' });
        }
        
        res.json({ 
            success: true, 
            message: 'Package updated successfully'
        });
    } catch (error) {
        console.error('Error updating package:', error);
        return res.status(500).json({ error: 'Failed to update package' });
    }
};

// Delete package (admin only)
const deletePackage = async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await dbConfig.run('DELETE FROM plans WHERE id = ?', [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Package not found' });
        }
        
        res.json({ 
            success: true, 
            message: 'Package deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting package:', error);
        return res.status(500).json({ error: 'Failed to delete package' });
    }
};

// Toggle package active/inactive status (admin only)
const togglePackageStatus = async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await dbConfig.run(`
            UPDATE plans 
            SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Package not found' });
        }
        
        res.json({ 
            success: true, 
            message: 'Package status toggled successfully'
        });
    } catch (error) {
        console.error('Error toggling package status:', error);
        return res.status(500).json({ error: 'Failed to toggle package status' });
    }
};

module.exports = {
    getActivePackages,
    getAllPackages,
    getPackageById,
    createPackage,
    updatePackage,
    deletePackage,
    togglePackageStatus
};
