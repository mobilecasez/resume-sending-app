const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const dbConfig = require('../../db-config');
const CryptoJS = require('crypto-js');
const validator = require('validator');
const jwksRsa = require('jwks-rsa');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// SECURITY: Get encryption key for OAuth tokens
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
    console.error('⚠️ WARNING: ENCRYPTION_KEY not set in authController');
}

// OAuth token encryption helper
function encryptOAuthToken(token) {
    if (!token) return null;
    if (!ENCRYPTION_KEY) return token; // Fallback for backward compatibility
    try {
        return CryptoJS.AES.encrypt(token, ENCRYPTION_KEY).toString();
    } catch (error) {
        console.error('OAuth token encryption error:', error);
        return null;
    }
}

// SECURITY: Security audit logging function
async function logSecurityEvent(userId, eventType, eventCategory, details = {}, req = null, success = true, errorMessage = null) {
    try {
        const ipAddress = req ? (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress) : null;
        const userAgent = req ? req.headers['user-agent'] : null;
        
        await dbConfig.run(
            `INSERT INTO security_audit_log 
            (user_id, event_type, event_category, ip_address, user_agent, details, success, error_message) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, eventType, eventCategory, ipAddress, userAgent, JSON.stringify(details), success, errorMessage]
        );
        
        console.log(`🔒 Security Event: [${eventCategory}] ${eventType} - User: ${userId || 'N/A'} - Success: ${success}`);
    } catch (error) {
        // Don't fail the main operation if logging fails
        console.error('⚠️ Failed to log security event:', error.message);
    }
}

// Register new user
const register = async (req, res) => {
    try {
        const { fullName, email, password } = req.body;

        // Input validation (CASA Tier 2 requirement)
        if (!fullName || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Validate and sanitize email
        if (!validator.isEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        const sanitizedEmail = validator.normalizeEmail(email);

        // Validate full name (alphanumeric and spaces only, max 100 chars)
        const trimmedName = fullName.trim();
        if (trimmedName.length < 2 || trimmedName.length > 100) {
            return res.status(400).json({ error: 'Full name must be between 2 and 100 characters' });
        }
        if (!/^[a-zA-Z\s'-]+$/.test(trimmedName)) {
            return res.status(400).json({ error: 'Full name contains invalid characters' });
        }

        // Validate password strength
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (password.length > 128) {
            return res.status(400).json({ error: 'Password must be less than 128 characters' });
        }
        // Check for basic password strength
        if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
            return res.status(400).json({ error: 'Password must contain both letters and numbers' });
        }

        // Check if user already exists
        const existingUser = await dbConfig.get('SELECT * FROM users WHERE email = ?', [sanitizedEmail]);
        
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user with sanitized data
        const result = await dbConfig.run(
            'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
            [trimmedName, sanitizedEmail, hashedPassword]
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

        // Log user registration
        await logSecurityEvent(userId, 'USER_REGISTERED', 'auth', {
            method: 'email_password'
        }, req);
        
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

        // Input validation (CASA Tier 2 requirement)
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Validate email format
        if (!validator.isEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        const sanitizedEmail = validator.normalizeEmail(email);

        // Validate password length (prevent extremely long inputs)
        if (password.length > 128) {
            return res.status(400).json({ error: 'Invalid input' });
        }

        const user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [sanitizedEmail]);
        
        if (!user) {
            // Log failed login attempt
            await logSecurityEvent(null, 'LOGIN_FAILED', 'auth', {
                email: email,
                reason: 'user_not_found'
            }, req, false, 'Invalid email or password');
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            // Log failed login attempt
            await logSecurityEvent(user.id, 'LOGIN_FAILED', 'auth', {
                email: email,
                reason: 'invalid_password'
            }, req, false, 'Invalid password');
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Generate JWT
        const token = jwt.sign(
            { id: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Log successful login
        await logSecurityEvent(user.id, 'LOGIN_SUCCESS', 'auth', {
            method: 'email_password',
            provider: user.oauth_provider || 'email'
        }, req);
        
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
                email: user.email,
                oauth_provider: user.oauth_provider || null,
                provider: user.oauth_provider || 'email' // alias for mobile app
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
        email: req.user.email,
        provider: 'google',
        oauth_provider: 'google'
    };

    // For mobile apps, return JSON instead of HTML redirect
    if (isMobile) {
        res.json({
            success: true,
            token,
            user: userData
        });
    } else {
        // For web, set authToken cookie AND redirect to success page
        res.cookie('authToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
            sameSite: 'strict'
        });
        res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userData))}`);
    }
};

// Google OAuth mobile deep-link callback — redirects to the app via deep link
const googleMobileCallback = (req, res) => {
    const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
    const userData = {
        id: req.user.id,
        fullName: req.user.full_name,
        email: req.user.email,
        provider: 'google',
        oauth_provider: 'google'
    };
    // Deep link without path to avoid expo-router trying to route it
    // Just query params so the Linking listener can catch it directly
    const IS_PROD = process.env.NODE_ENV === 'production';
    // Derive the Expo dev IP from the request's Referer/Origin or fall back to env/default
    let devIp = '192.168.1.10';
    if (!IS_PROD) {
        // Try to detect from the incoming request (the Custom Tab sends Referer)
        const referer = req.headers.referer || req.headers.origin || '';
        const ipMatch = referer.match(/\/\/([\d.]+):/);
        if (ipMatch) {
            devIp = ipMatch[1];
        } else if (process.env.LOCAL_IP) {
            devIp = process.env.LOCAL_IP;
        }
    }
    const deepLink = IS_PROD
        ? `cvapplyr://oauth-success?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify(userData))}`
        : `exp://${devIp}:8081/?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify(userData))}`;
    console.log('Mobile OAuth: redirecting to deep link:', deepLink.substring(0, 100) + '...');
    res.redirect(deepLink);
};

// Google OAuth API endpoint for mobile (returns JSON)
const googleAuth = async (req, res) => {
    try {
        console.log('\n=== Google OAuth Request ===');
        console.log('Request Body:', JSON.stringify(req.body, null, 2));
        const { accessToken, code, codeVerifier, redirectUri: clientRedirectUri, isMobile, platform } = req.body;
        console.log('Parsed values:', {
            hasAccessToken: !!accessToken,
            hasCode: !!code,
            hasCodeVerifier: !!codeVerifier,
            isMobile,
            platform
        });
        
        let finalAccessToken = accessToken;
        let finalRefreshToken = null; // Store refresh token from OAuth
        
        // If authorization code is provided (mobile flow with PKCE), exchange it for access token
        if (code) {
            console.log('Authorization code provided, exchanging for access token...');
            console.log('Platform:', platform || 'not specified');
            console.log('Using PKCE:', codeVerifier ? 'YES' : 'NO');
            
            const clientId = process.env.GOOGLE_CLIENT_ID;
            
            // Use redirectUri provided by the client (expo-auth-session sets the actual one used).
            // Fall back to platform-based computation only if not provided.
            let redirectUri;
            if (clientRedirectUri) {
                redirectUri = clientRedirectUri;
                console.log('Using client-provided redirect URI:', redirectUri);
            } else if (platform === 'ios') {
                const clientIdPrefix = clientId.split('.apps.googleusercontent.com')[0];
                redirectUri = `com.googleusercontent.apps.${clientIdPrefix}:/oauth2redirect/google`;
            } else if (platform === 'android') {
                redirectUri = 'com.cvapplyr.mobile:/oauth2redirect/google';
            } else {
                redirectUri = process.env.NODE_ENV === 'production'
                    ? 'https://cvapplyr.com/auth/google/callback'
                    : 'http://localhost:3000/auth/google/callback';
            }
            
            console.log('Using redirect URI:', redirectUri);
            
            // Build token exchange params
            const tokenParams = {
                code: code,
                client_id: clientId,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            };
            
            // PKCE: use code_verifier if provided (mobile), otherwise use client_secret (web)
            if (codeVerifier) {
                // Mobile PKCE flow - no client secret needed
                tokenParams.code_verifier = codeVerifier;
                console.log('Using PKCE code_verifier for token exchange');
            } else {
                // Web flow - requires client secret
                const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
                if (!clientSecret) {
                    console.error('Google Client Secret not configured for web flow');
                    return res.status(500).json({ error: 'Server configuration error' });
                }
                tokenParams.client_secret = clientSecret;
                console.log('Using client_secret for token exchange');
            }
            
            // Exchange authorization code for access token
            console.log('Sending token exchange request to Google...');
            console.log('Token params:', {
                grant_type: tokenParams.grant_type,
                client_id: tokenParams.client_id,
                redirect_uri: tokenParams.redirect_uri,
                has_code: !!tokenParams.code,
                has_code_verifier: !!tokenParams.code_verifier,
                has_client_secret: !!tokenParams.client_secret
            });
            
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(tokenParams)
            });
            
            console.log('Google token response status:', tokenResponse.status);
            
            if (!tokenResponse.ok) {
                const errorData = await tokenResponse.json();
                console.error('Google token exchange error:', errorData);
                console.error('Token params used:', tokenParams);
                return res.status(401).json({ error: 'Failed to exchange authorization code', details: errorData });
            }
            
            const tokenData = await tokenResponse.json();
            console.log('Token exchange successful! Response keys:', Object.keys(tokenData));
            console.log('Access token present:', !!tokenData.access_token);
            console.log('Refresh token present:', !!tokenData.refresh_token);
            finalAccessToken = tokenData.access_token;
            finalRefreshToken = tokenData.refresh_token; // Store refresh token
            console.log('Successfully exchanged code for access token');
        }
        
        console.log('Final access token check:', {
            hasFinalAccessToken: !!finalAccessToken,
            finalAccessTokenLength: finalAccessToken?.length || 0,
            hasFinalRefreshToken: !!finalRefreshToken
        });
        
        if (!finalAccessToken) {
            console.error('❌ No access token available after processing');
            console.log('Missing accessToken, code, and codeVerifier in request');
            return res.status(400).json({ error: 'Access token or authorization code is required' });
        }

        console.log('Verifying access token with Google API...');
        // Get user info from Google
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
            headers: { Authorization: `Bearer ${finalAccessToken}` }
        });

        if (!userInfoResponse.ok) {
            console.error('Google API Error:', userInfoResponse.status, userInfoResponse.statusText);
            return res.status(401).json({ error: 'Failed to get user info from Google', googleStatus: userInfoResponse.status });
        }

        const googleUser = await userInfoResponse.json();
        console.log('Google User Info:', { email: googleUser.email, name: googleUser.name });
        
        // Calculate token expiration (Google tokens expire in 1 hour)
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000); // 1 hour from now
        
        // Find or create user in database
        try {
            let user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [googleUser.email]);

            if (!user) {
                // Create new user from Google data (with ENCRYPTED OAuth tokens)
                const hashedPassword = await bcrypt.hash('google-oauth-' + googleUser.id, 10);
                const usedPkce = !!codeVerifier; // true if PKCE (mobile), false if standard OAuth (web)
                const result = await dbConfig.run(
                    `INSERT INTO users (
                        email, full_name, password, oauth_provider, 
                        google_access_token, google_refresh_token, used_pkce,
                        google_token_issued_at, google_token_expires_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                    [
                        googleUser.email, googleUser.name, hashedPassword, 'google', 
                        encryptOAuthToken(finalAccessToken), 
                        encryptOAuthToken(finalRefreshToken), 
                        usedPkce,
                        issuedAt.toISOString(),
                        expiresAt.toISOString()
                    ]
                );

                const newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
                
                // Give 2 free credits to new user
                try {
                    await dbConfig.run(
                        'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)',
                        [newUserId, 2, 2]
                    );
                    
                    await dbConfig.run(
                        `INSERT INTO credit_transactions 
                        (user_id, transaction_type, credits_change, balance_after, description) 
                        VALUES (?, ?, ?, ?, ?)`,
                        [newUserId, 'purchase', 2, 2, 'Welcome bonus - Free credits']
                    );
                } catch (creditErr) {
                    console.error('Failed to add welcome credits:', creditErr);
                }

                // Log new user registration via OAuth
                await logSecurityEvent(newUserId, 'USER_REGISTERED', 'oauth', {
                    provider: 'google',
                    flow: 'mobile_api',
                    used_pkce: usedPkce
                }, req);
                
                // Log OAuth token grant
                await logSecurityEvent(newUserId, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                    provider: 'google',
                    flow: 'mobile_api',
                    has_refresh_token: !!finalRefreshToken,
                    expires_at: expiresAt.toISOString()
                }, req);

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
                        email: googleUser.email,
                        oauth_provider: 'google',
                        provider: 'google' // alias for mobile app
                    }
                });
            } else {
                // User exists, update OAuth tokens (ENCRYPTED for security)
                const usedPkce = !!codeVerifier; // true if PKCE (mobile), false if standard OAuth (web)
                // Only update refresh_token if we received a new one (first-time consent or re-auth)
                if (finalRefreshToken) {
                    await dbConfig.run(
                        `UPDATE users SET 
                            oauth_provider = ?, 
                            google_access_token = ?, 
                            google_refresh_token = ?, 
                            used_pkce = ?,
                            google_token_issued_at = ?,
                            google_token_expires_at = ?
                        WHERE id = ?`,
                        [
                            'google', 
                            encryptOAuthToken(finalAccessToken), 
                            encryptOAuthToken(finalRefreshToken), 
                            usedPkce,
                            issuedAt.toISOString(),
                            expiresAt.toISOString(),
                            user.id
                        ]
                    );
                } else {
                    // Just update access token (refresh token persists)
                    await dbConfig.run(
                        `UPDATE users SET 
                            oauth_provider = ?, 
                            google_access_token = ?, 
                            used_pkce = ?,
                            google_token_issued_at = ?,
                            google_token_expires_at = ?
                        WHERE id = ?`,
                        [
                            'google', 
                            encryptOAuthToken(finalAccessToken), 
                            usedPkce,
                            issuedAt.toISOString(),
                            expiresAt.toISOString(),
                            user.id
                        ]
                    );
                }
                
                // Log OAuth token refresh
                await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                    provider: 'google',
                    flow: 'mobile_api',
                    has_refresh_token: !!finalRefreshToken,
                    expires_at: expiresAt.toISOString()
                }, req);
                
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
                        email: user.email,
                        oauth_provider: 'google',
                        provider: 'google' // alias for mobile app
                    }
                });
            }
        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Database error' });
        }
    } catch (error) {
        console.error('Google OAuth error:', error);
        res.status(500).json({ error: 'Server error', details: error.message });
    }
};

// Microsoft OAuth callback handler
const microsoftCallback = (req, res) => {
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
        email: req.user.email,
        provider: 'microsoft',
        oauth_provider: 'microsoft'
    };

    // For mobile apps, return JSON instead of HTML redirect
    if (isMobile) {
        res.json({
            success: true,
            token,
            user: userData
        });
    } else {
        // For web, set authToken cookie AND redirect to success page
        res.cookie('authToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
            sameSite: 'strict'
        });
        res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userData))}`);
    }
};

// Microsoft OAuth API endpoint for mobile (returns JSON)
const microsoftAuth = async (req, res) => {
    try {
        console.log('Microsoft OAuth Request Body:', req.body);
        const { accessToken } = req.body;
        
        if (!accessToken) {
            console.log('Missing accessToken in request');
            return res.status(400).json({ error: 'Access token is required' });
        }

        console.log('Verifying access token with Microsoft Graph API...');
        
        // Verify the access token with Microsoft Graph API
        const response = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!response.ok) {
            console.log('Microsoft Graph API error:', response.status, response.statusText);
            return res.status(401).json({ error: 'Invalid access token' });
        }

        const microsoftUser = await response.json();
        console.log('Microsoft user profile:', microsoftUser);

        // Calculate token expiration (Microsoft tokens expire in 1 hour)
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000); // 1 hour from now

        // Check if user exists in database
        const user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [microsoftUser.mail || microsoftUser.userPrincipalName]);

        if (!user) {
            // Create new user (with ENCRYPTED Microsoft OAuth token)
            console.log('Creating new user from Microsoft OAuth...');

            const hashedPassword = await bcrypt.hash('microsoft-oauth-' + microsoftUser.id, 10);
            const result = await dbConfig.run(
                `INSERT INTO users (
                    email, full_name, password, oauth_provider, 
                    microsoft_access_token,
                    microsoft_token_issued_at, microsoft_token_expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                [
                    microsoftUser.mail || microsoftUser.userPrincipalName, 
                    microsoftUser.displayName, 
                    hashedPassword, 
                    'microsoft', 
                    encryptOAuthToken(accessToken),
                    issuedAt.toISOString(),
                    expiresAt.toISOString()
                ]
            );

            const newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;

            // Log new user registration via OAuth
            await logSecurityEvent(newUserId, 'USER_REGISTERED', 'oauth', {
                provider: 'microsoft',
                flow: 'mobile_api'
            }, req);
            
            // Log OAuth token grant
            await logSecurityEvent(newUserId, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                provider: 'microsoft',
                flow: 'mobile_api',
                expires_at: expiresAt.toISOString()
            }, req);

            // Generate JWT
            const token = jwt.sign(
                { id: newUserId, email: microsoftUser.mail || microsoftUser.userPrincipalName },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                success: true,
                token,
                user: {
                    id: newUserId,
                    fullName: microsoftUser.displayName,
                    email: microsoftUser.mail || microsoftUser.userPrincipalName,
                    oauth_provider: 'microsoft',
                    provider: 'microsoft' // alias for mobile app
                }
            });
        } else {
            // User exists, update OAuth tokens (ENCRYPTED for security)
            await dbConfig.run(
                `UPDATE users SET 
                    oauth_provider = ?, 
                    microsoft_access_token = ?,
                    microsoft_token_issued_at = ?,
                    microsoft_token_expires_at = ?
                WHERE id = ?`,
                [
                    'microsoft', 
                    encryptOAuthToken(accessToken),
                    issuedAt.toISOString(),
                    expiresAt.toISOString(),
                    user.id
                ]
            );
            
            // Log OAuth token refresh
            await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                provider: 'microsoft',
                flow: 'mobile_api',
                expires_at: expiresAt.toISOString()
            }, req);
            
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
                    email: user.email,
                    oauth_provider: 'microsoft',
                    provider: 'microsoft' // alias for mobile app
                }
            });
        }
    } catch (error) {
        console.error('Microsoft OAuth error:', error);
        return res.status(500).json({ error: 'Authentication failed' });
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

// Apple Sign-In JWKS client for verifying identity tokens
const appleJwksClient = jwksRsa({
    jwksUri: 'https://appleid.apple.com/auth/keys',
    cache: true,
    cacheMaxAge: 86400000, // 24 hours
    rateLimit: true,
});

// Helper: get Apple signing key from kid
function getAppleSigningKey(kid) {
    return new Promise((resolve, reject) => {
        appleJwksClient.getSigningKey(kid, (err, key) => {
            if (err) return reject(err);
            resolve(key.getPublicKey());
        });
    });
}

// Apple Sign-In API endpoint for mobile
const appleAuth = async (req, res) => {
    try {
        console.log('\n=== Apple Sign-In Request ===');
        const { identityToken, fullName, email: appleEmail, authorizationCode } = req.body;

        if (!identityToken) {
            return res.status(400).json({ error: 'Identity token is required' });
        }

        // Decode header to get kid for key lookup
        const tokenParts = identityToken.split('.');
        if (tokenParts.length !== 3) {
            return res.status(400).json({ error: 'Invalid identity token format' });
        }
        const header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString());

        // Get Apple's public key and verify the token
        const signingKey = await getAppleSigningKey(header.kid);
        const decoded = jwt.verify(identityToken, signingKey, {
            algorithms: ['RS256'],
            issuer: 'https://appleid.apple.com',
            audience: 'com.cvapplyr.mobile', // Must match your bundle ID
        });

        console.log('Apple token verified:', { sub: decoded.sub, email: decoded.email });

        // Apple only sends email/name on FIRST sign-in; afterwards decoded.email may still be present
        const email = decoded.email || appleEmail;
        if (!email) {
            return res.status(400).json({ error: 'No email provided by Apple. Please try again or use a different sign-in method.' });
        }

        // Build display name (Apple may hide real name)
        let displayName = 'Apple User';
        if (fullName && (fullName.givenName || fullName.familyName)) {
            displayName = [fullName.givenName, fullName.familyName].filter(Boolean).join(' ');
        }

        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);

        // Find or create user
        let user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);

        if (!user) {
            // Create new user
            const hashedPassword = await bcrypt.hash('apple-oauth-' + decoded.sub, 10);
            const result = await dbConfig.run(
                `INSERT INTO users (
                    email, full_name, password, oauth_provider,
                    apple_user_id, apple_identity_token,
                    apple_token_issued_at, apple_token_expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                [
                    email, displayName, hashedPassword, 'apple',
                    decoded.sub, encryptOAuthToken(identityToken),
                    issuedAt.toISOString(), expiresAt.toISOString()
                ]
            );

            const newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;

            // Give 2 free credits to new user
            try {
                await dbConfig.run(
                    'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)',
                    [newUserId, 2, 2]
                );
                await dbConfig.run(
                    `INSERT INTO credit_transactions 
                    (user_id, transaction_type, credits_change, balance_after, description) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [newUserId, 'purchase', 2, 2, 'Welcome bonus - Free credits']
                );
            } catch (creditErr) {
                console.error('Failed to add welcome credits:', creditErr);
            }

            await logSecurityEvent(newUserId, 'USER_REGISTERED', 'oauth', {
                provider: 'apple',
                flow: 'mobile_native'
            }, req);

            await logSecurityEvent(newUserId, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                provider: 'apple',
                flow: 'mobile_native',
                expires_at: expiresAt.toISOString()
            }, req);

            const token = jwt.sign(
                { id: newUserId, email },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                success: true,
                token,
                user: {
                    id: newUserId,
                    fullName: displayName,
                    email,
                    oauth_provider: 'apple',
                    provider: 'apple'
                }
            });
        } else {
            // Existing user — update Apple tokens
            await dbConfig.run(
                `UPDATE users SET 
                    oauth_provider = ?,
                    apple_user_id = ?,
                    apple_identity_token = ?,
                    apple_token_issued_at = ?,
                    apple_token_expires_at = ?
                WHERE id = ?`,
                [
                    'apple',
                    decoded.sub,
                    encryptOAuthToken(identityToken),
                    issuedAt.toISOString(),
                    expiresAt.toISOString(),
                    user.id
                ]
            );

            // Update name if Apple provided it and current name is generic
            if (displayName !== 'Apple User' && (user.full_name === 'Apple User' || !user.full_name)) {
                await dbConfig.run('UPDATE users SET full_name = ? WHERE id = ?', [displayName, user.id]);
            }

            await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                provider: 'apple',
                flow: 'mobile_native',
                expires_at: expiresAt.toISOString()
            }, req);

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
                    fullName: user.full_name !== 'Apple User' ? user.full_name : displayName,
                    email: user.email,
                    oauth_provider: 'apple',
                    provider: 'apple'
                }
            });
        }
    } catch (error) {
        console.error('Apple Sign-In error:', error);
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid or expired Apple identity token' });
        }
        return res.status(500).json({ error: 'Apple authentication failed' });
    }
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
    googleMobileCallback,
    googleAuth,
    microsoftCallback,
    microsoftAuth,
    appleAuth,
    linkedinCallback,
    changePassword
};
