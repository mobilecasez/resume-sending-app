const express = require('express');
const router = express.Router();
const adminPackagesController = require('../controllers/adminPackagesController');
const { authenticateAdmin } = require('../middleware/auth');

/**
 * Admin/Packages Routes
 * Handles all package management operations
 */

// Public route - get active packages
router.get('/packages', adminPackagesController.getActivePackages);

// Admin routes - require admin authentication
router.get('/admin/packages', authenticateAdmin, adminPackagesController.getAllPackages);
router.get('/admin/packages/:id', authenticateAdmin, adminPackagesController.getPackageById);
router.post('/admin/packages', authenticateAdmin, adminPackagesController.createPackage);
router.put('/admin/packages/:id', authenticateAdmin, adminPackagesController.updatePackage);
router.delete('/admin/packages/:id', authenticateAdmin, adminPackagesController.deletePackage);
router.patch('/admin/packages/:id/toggle-active', authenticateAdmin, adminPackagesController.togglePackageStatus);

module.exports = router;
