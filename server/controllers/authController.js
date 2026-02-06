const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const dbConfig = require('../../db-config');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Register new user
const register = async (req, res) => {
    try {
        const { fullName, email, password } = req.body;

        if (!fullName || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if user already exists
        const existingUser = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);
        
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const result = await dbConfig.run(
            'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
            [fullName, email, hashedPassword]
        );

        const userId = result.lastID || result.id;
        
        // Give 2 free credits to new user
        try {
            await dbConfig.run(
                'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)',
                [userId, 2, 2]
            );
            
            // Log the credit transaction
            await dbConfig.run(
                `INSERT INTO credit_transactions 
                (user_id, transaction_type, credits_change, balance_after, description) 
                VALUES (?, ?, ?, ?, ?)`,
                [userId, 'purchase', 2, 2, 'Welcome bonus - Free credits']
            );
        } catch (creditErr) {
            console.error('Failed to add welcome credits:', creditErr);
        }

        // Generate JWT token for auto-login after registration
        const token = jwt.sign(
            { id: userId, email: email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ 
            success: true, 
            message: 'User created successfully! You received 2 free credits.',
            token,
            user: {
                id: userId,
                fullName: fullName,
                email: email
            },
            freeCredits: 2
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Login user
const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Generate JWT
        const token = jwt.sign(
            { id: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Set secure HTTP-only cookie for admin page protection
        res.cookie('authToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
            sameSite: 'strict'
        });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Logout user
const logout = (req, res) => {
    res.clearCookie('authToken');
    res.json({ success: true, message: 'Logged out successfully' });
};

// Google OAuth callback handler
const googleCallback = (req, res) => {
    // Check if this is a mobile request
    const isMobile = req.query.mobile === 'true' || req.headers['user-agent']?.includes('Expo');
    
    // Generate JWT token for the user
    const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    const userData = {
        id: req.user.id,
        fullName: req.user.full_name,
        email: req.user.email
    };

    // For mobile apps, return JSON instead of HTML redirect
    if (isMobile) {
        res.json({
            success: true,
            token,
            user: userData
        });
    } else {
        // For web, redirect to success page
        res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userData))}`);
    }
};

// Google OAuth API endpoint for mobile (returns JSON)
const googleAuth = async (req, res) => {
    try {
        console.log('Google OAuth Request Body:', req.body);
        const { accessToken } = req.body;
        
        if (!accessToken) {
            console.log('Missing accessToken in request');
            return res.status(400).json({ error: 'Access token is required' });
        }

        console.log('Verifying access token with Google API...');
        // Get user info from Google
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            console.error('Google API Error:', userInfoResponse.status, userInfoResponse.statusText);
            return res.status(401).json({ error: 'Failed to get user info from Google', googleStatus: userInfoResponse.status });
        }

        const googleUser = await userInfoResponse.json();
        console.log('Google User Info:', { email: googleUser.email, name: googleUser.name });
        
        // Find or create user in database
        try {
            let user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [googleUser.email]);

            if (!user) {
                // Create new user from Google data
                const hashedPassword = await bcrypt.hash('google-oauth-' + googleUser.id, 10);
                const result = await dbConfig.run(
                    'INSERT INTO users (email, full_name, password, oauth_provider, google_access_token) VALUES (?, ?, ?, ?, ?) RETURNING id',
                    [googleUser.email, googleUser.name, hashedPassword, 'google', accessToken]
                );

                const newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;

                // Generate JWT
                const token = jwt.sign(
                    { id: newUserId, email: googleUser.email },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );

                return res.json({
                    success: true,
                    token,
                    user: {
                        id: newUserId,
                        fullName: googleUser.name,
                        email: googleUser.email
                    }
                });
            } else {
                // User exists, update OAuth tokens
                await dbConfig.run(
                    'UPDATE users SET oauth_provider = ?, google_access_token = ? WHERE id = ?',
                    ['google', accessToken, user.id]
                );
                
                // Generate JWT
                const token = jwt.sign(
                    { id: user.id, email: user.email },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );

                return res.json({
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        fullName: user.full_name,
                        email: user.email
                    }
                });
            }
        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Database error' });
        }
    } catch (error) {
        console.error('Google OAuth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// LinkedIn OAuth callback handler (Disabled due to API compatibility issues)
const linkedinCallback = (req, res) => {
    // Generate JWT token for the user
    const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify({
        id: req.user.id,
        fullName: req.user.full_name,
        email: req.user.email
    }))}`);
};

// Change password
const changePassword = async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        // Get user from database
        const user = await dbConfig.get('SELECT password FROM users WHERE id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password in database
        await dbConfig.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    register,
    login,
    logout,
    googleCallback,
    googleAuth,
    linkedinCallback,
    changePassword
};
