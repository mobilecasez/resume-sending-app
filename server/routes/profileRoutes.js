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
    saveOnboarding,
    updatePrivacySettings
} = require('../controllers/profileController');
const { MESSAGES: RESUME_FILE_MESSAGES, MAX_UPLOAD_BYTES } = require('../../services/resumeText');
const { noteProfileBefore } = require('../services/onboardingProgress');

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

// ⚠️ THE RÉSUMÉ HAS A SIZE LIMIT (2026-09-19); it had none, and uploadResume now reads the whole file to check what
// it is before committing it. multer's own refusal is an error thrown into Express (an HTML 500 the app shows as
// "did not go through"), so it is answered here as JSON the app can show: what was wrong, and what to do.
// ⚠️ THE LIMIT IS THE READERS' OWN, NOT A ROUND NUMBER (review, 2026-09-20). It was first written as 10 MB "because a
// CV is kilobytes" — true of the Word and text files this server parses itself, and false of the PDFs and phone
// photos most people actually upload, which pdf-parse and the vision reader take to 18 MB. A 12 MB scanned CV
// uploaded and parsed end to end before this route had a limit and was a 413 after, with nothing in the app to
// shrink it with. services/resumeText.MAX_UPLOAD_BYTES is that ceiling, and the sentence below quotes it.
const uploadResumeFile = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }).single('resume');
const resumeUpload = (req, res, next) => uploadResumeFile(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: RESUME_FILE_MESSAGES.too_large, reason: 'too_large' });
    return res.status(400).json({ error: 'That upload did not go through. Please choose the file again.', reason: 'upload_failed' });
});

// Get user profile
router.get('/profile', getProfile);

// ⚠️ noteProfileBefore FIRST, before multer (review round 2, 2026-09-19): Account Settings closes an open Make Yours
// wizard only on the write that COMPLETED the profile, so the profile has to be read before this write lands.
// Upload files with multer middleware
router.post('/profile/image', noteProfileBefore, upload.single('profileImage'), uploadProfileImage);
router.post('/profile/resume', noteProfileBefore, resumeUpload, uploadResume);
router.post('/profile/signature', noteProfileBefore, upload.single('signature'), uploadSignature);

// Update profile
router.post('/profile/update', noteProfileBefore, updateProfile);

// The Make Yours wizard's own progress — notes, lane, skips (server/services/onboardingProgress.js)
router.post('/profile/onboarding', saveOnboarding);

// Privacy settings
router.post('/privacy-settings', updatePrivacySettings);

module.exports = router;
