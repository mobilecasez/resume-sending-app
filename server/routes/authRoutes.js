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
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'], // gmail.metadata removed — re-enable after CASA
    accessType: 'offline',
    prompt: 'consent'
}));

router.get('/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login.html' }), 
    authController.googleCallback
);

// Mobile-specific Google OAuth: initiates web OAuth, returns JWT via deep link
router.get('/google/mobile', passport.authenticate('google-mobile', {
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'], // gmail.readonly removed — re-enable after CASA
    accessType: 'offline',
    prompt: 'consent',
}));

router.get('/google/mobile-callback',
    passport.authenticate('google-mobile', { failureRedirect: '/login.html' }),
    authController.googleMobileCallback
);

// Google OAuth API endpoint for mobile
router.post('/google', authController.googleAuth);

// Microsoft OAuth Routes
router.get('/microsoft', passport.authenticate('microsoft', {
    scope: ['user.read', 'mail.send', 'offline_access'],
    prompt: 'select_account'
}));

router.get('/microsoft/callback', 
    passport.authenticate('microsoft', { failureRedirect: '/login.html' }), 
    authController.microsoftCallback
);

// Microsoft OAuth API endpoint for mobile
router.post('/microsoft', authController.microsoftAuth);

// Apple Sign-In API endpoint for mobile
// Apple Sign-In API endpoint for mobile
router.post('/apple', authController.appleAuth);

// Apple Sign-In Web Routes
router.get('/apple', authController.appleWebRedirect);
router.post('/apple/callback', authController.appleWebCallback);

// Link Google account to existing user (for Apple Sign-In users who need Gmail sending)
router.post('/link-google', authenticateToken, authController.linkGoogle);

// Link Microsoft account to existing user (for Apple Sign-In users who need Outlook sending)
router.post('/link-microsoft', authenticateToken, authController.linkMicrosoft);

// Revoke linked email provider (Google/Microsoft) — clears tokens
router.post('/revoke-email-provider', authenticateToken, authController.revokeEmailProvider);

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
