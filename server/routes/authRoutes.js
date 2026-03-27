const express = require('express');
const passport = require('passport');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');

// Basic Auth Routes
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/change-password', authenticateToken, authController.changePassword);

// Google OAuth Routes
router.get('/google', passport.authenticate('google', {
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'],
    accessType: 'offline',
    prompt: 'consent'
}));

router.get('/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login.html' }), 
    authController.googleCallback
);

// Google OAuth API endpoint for mobile
router.post('/google', authController.googleAuth);

// Microsoft OAuth Routes
router.get('/microsoft', passport.authenticate('microsoft', {
    scope: ['user.read', 'mail.send', 'offline_access'],
    prompt: 'consent'
}));

router.get('/microsoft/callback', 
    passport.authenticate('microsoft', { failureRedirect: '/login.html' }), 
    authController.microsoftCallback
);

// Microsoft OAuth API endpoint for mobile
router.post('/microsoft', authController.microsoftAuth);

// LinkedIn OAuth Routes (Disabled due to API compatibility issues)
/*
router.get('/linkedin', passport.authenticate('linkedin', {
    scope: ['profile', 'email']
}));

router.get('/linkedin/callback', 
    passport.authenticate('linkedin', { failureRedirect: '/login.html' }), 
    authController.linkedinCallback
);
*/

module.exports = router;
