const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/adminUsersController');
const { authenticateAdmin } = require('../middleware/auth');

router.get('/admin/users/search', authenticateAdmin, ctrl.searchUsers);
router.get('/admin/users/:id/credits', authenticateAdmin, ctrl.getUserCredits);
router.put('/admin/users/:id/credits', authenticateAdmin, ctrl.setUserCredits);

module.exports = router;
