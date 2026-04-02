const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const {
    getProfile,
    uploadProfileImage,
    uploadResume,
    uploadSignature,
    updateProfile,
    updatePrivacySettings
} = require('../controllers/profileController');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = req.user.id;
        const uploadDir = path.join(process.cwd(), 'uploads', `user_${userId}`);
        const fs = require('fs');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage });

// Get user profile
router.get('/profile', getProfile);

// Upload files with multer middleware
router.post('/profile/image', upload.single('profileImage'), uploadProfileImage);
router.post('/profile/resume', upload.single('resume'), uploadResume);
router.post('/profile/signature', upload.single('signature'), uploadSignature);

// Update profile
router.post('/profile/update', updateProfile);

// Privacy settings
router.post('/privacy-settings', updatePrivacySettings);

module.exports = router;
