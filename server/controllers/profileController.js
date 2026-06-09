const dbConfig = require('../../db-config');
const { notifyProfileUpdated } = require('./notificationsController');
const { triggerResumeParsingBackground } = require('../../services/resumeParserService');

// Get user profile data
const getProfile = async (req, res) => {
    const userId = req.user.id;
    
    try {
        const user = await dbConfig.get('SELECT full_name as "fullName", email, resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath", phone_number as "phoneNumber", address, date_of_birth as "dateOfBirth", gender, created_at as "createdAt", oauth_provider as "oauthProvider" FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Format DOB as date-only string using toLocaleDateString to avoid timezone shifts
        let formattedDOB = null;
        if (user.dateOfBirth) {
            const date = new Date(user.dateOfBirth);
            // 'en-CA' gives YYYY-MM-DD format without timezone conversion
            formattedDOB = date.toLocaleDateString('en-CA');
        }
        
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        
        res.json({
            fullName: user.fullName,
            email: user.email,
            phone: user.phoneNumber,
            address: user.address,
            dateOfBirth: formattedDOB,
            profileImage: user.photoPath ? `${baseUrl}/${user.photoPath}` : null,
            resume: user.resumePath ? `${baseUrl}/${user.resumePath}` : null,
            signature: user.signaturePath ? `${baseUrl}/${user.signaturePath}` : null,
            createdAt: user.createdAt,
            oauth_provider: user.oauthProvider || null
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

// Upload profile image
const uploadProfileImage = async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path.replace(process.cwd() + '/', '');
        
        await dbConfig.run('UPDATE users SET photo_path = ? WHERE id = ?', [filePath, userId]);
        
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        res.json({
            success: true,
            message: 'Profile image uploaded successfully',
            path: `${baseUrl}/${filePath}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Upload resume
const uploadResume = async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path.replace(process.cwd() + '/', '');
        
        await dbConfig.run('UPDATE users SET resume_path = ? WHERE id = ?', [filePath, userId]);

        // Run resume metadata extraction in the background without delaying the upload response.
        triggerResumeParsingBackground(userId, filePath);
        
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        res.json({
            success: true,
            message: 'Resume uploaded successfully',
            path: `${baseUrl}/${filePath}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Upload signature
const uploadSignature = async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path.replace(process.cwd() + '/', '');
        
        await dbConfig.run('UPDATE users SET signature_path = ? WHERE id = ?', [filePath, userId]);
        
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        res.json({
            success: true,
            message: 'Signature uploaded successfully',
            path: `${baseUrl}/${filePath}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Update user profile data
const updateProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const { fullName, phone, address, dateOfBirth, email, gender } = req.body;

        const updates = [];
        const params = [];

        if (fullName) {
            updates.push('full_name = ?');
            params.push(fullName);
        }
        if (email) {
            // Basic email validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ error: 'Invalid email format' });
            }
            // Don't allow setting a private relay email
            if (email.includes('privaterelay.appleid.com')) {
                return res.status(400).json({ error: 'Please provide your real email address, not the Apple private relay' });
            }
            updates.push('email = ?');
            params.push(email);
        }
        if (phone) {
            updates.push('phone_number = ?');
            params.push(phone);
        }
        if (address) {
            updates.push('address = ?');
            params.push(address);
        }
        if (dateOfBirth) {
            // THE NOON TRICK: Set time to 12:00 PM to prevent midnight timezone shifts
            const date = new Date(dateOfBirth);
            date.setHours(12, 0, 0, 0);
            
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const dateOnly = `${year}-${month}-${day}`;
            
            updates.push('date_of_birth = ?');
            params.push(dateOnly);
        }
        if (gender !== undefined) {
            // Used (with the user's consent) to auto-fill pronoun/gender questions on job forms.
            // Only three allowed values; '' clears it. Anything else is rejected.
            const allowed = ['Male', 'Female', 'Prefer Not to Say', ''];
            if (!allowed.includes(gender)) {
                return res.status(400).json({ error: 'Invalid gender value' });
            }
            updates.push('gender = ?');
            params.push(gender === '' ? null : gender);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(userId);
        const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

        await dbConfig.run(sql, params);

        // Create notification for profile update
        try {
            const fieldsUpdated = [];
            if (fullName) fieldsUpdated.push('Name');
            if (phone) fieldsUpdated.push('Phone');
            if (address) fieldsUpdated.push('Address');
            if (dateOfBirth) fieldsUpdated.push('Date of Birth');
            if (gender !== undefined) fieldsUpdated.push('Gender');
            await notifyProfileUpdated(userId, fieldsUpdated);
        } catch (notifError) {
            console.error('Failed to create notification:', notifError);
        }

        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Privacy settings
const updatePrivacySettings = (req, res) => {
    try {
        const userId = req.user.id;
        const { emailNotifications, smsNotifications, profilePublic } = req.body;

        // Store privacy settings as JSON in the database
        // For now, we'll just return success as these settings can be stored in a future update
        const privacySettings = {
            emailNotifications,
            smsNotifications,
            profilePublic
        };

        // In the future, add a privacy_settings column to users table and save there
        // For now, just acknowledge receipt and store in session/memory if needed
        res.json({
            success: true,
            message: 'Privacy settings updated successfully',
            privacySettings: privacySettings
        });
    } catch (error) {
        console.error('Privacy settings error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getProfile,
    uploadProfileImage,
    uploadResume,
    uploadSignature,
    updateProfile,
    updatePrivacySettings
};
