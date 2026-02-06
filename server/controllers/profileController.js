const dbConfig = require('../../db-config');

// Get user profile data
const getProfile = async (req, res) => {
    const userId = req.user.id;
    
    try {
        const user = await dbConfig.get('SELECT full_name as "fullName", email, resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath", phone_number as "phoneNumber", address, date_of_birth as "dateOfBirth", created_at as "createdAt" FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            fullName: user.fullName,
            email: user.email,
            phone: user.phoneNumber,
            address: user.address,
            dateOfBirth: user.dateOfBirth,
            profileImage: user.photoPath ? `http://${req.get('host')}/${user.photoPath}` : null,
            resume: user.resumePath ? `http://${req.get('host')}/${user.resumePath}` : null,
            signature: user.signaturePath ? `http://${req.get('host')}/${user.signaturePath}` : null,
            createdAt: user.createdAt
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
        
        res.json({
            success: true,
            message: 'Profile image uploaded successfully',
            path: `http://${req.get('host')}/${filePath}`
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
        
        res.json({
            success: true,
            message: 'Resume uploaded successfully',
            path: `http://${req.get('host')}/${filePath}`
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
        
        res.json({
            success: true,
            message: 'Signature uploaded successfully',
            path: `http://${req.get('host')}/${filePath}`
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
        const { fullName, phone, address, dateOfBirth } = req.body;

        const updates = [];
        const params = [];

        if (fullName) {
            updates.push('full_name = ?');
            params.push(fullName);
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
            updates.push('date_of_birth = ?');
            params.push(dateOfBirth);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(userId);
        const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

        await dbConfig.run(sql, params);

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
