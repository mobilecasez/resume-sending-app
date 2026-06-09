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

        // Capture registration IP
        const registrationIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || null;

        // Check if user already exists (active or soft-deleted)
        const existingUser = await dbConfig.get('SELECT * FROM users WHERE email = ?', [sanitizedEmail]);

        if (existingUser && !existingUser.deleted_at) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Was this email previously deleted? — don't give free credits again
        const wasPreviouslyDeleted = !!(existingUser?.deleted_at);

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        let userId;
        if (wasPreviouslyDeleted) {
            // Reactivate the soft-deleted account with a fresh password
            await dbConfig.run(
                `UPDATE users SET
                    full_name = ?, password = ?, deleted_at = NULL, deleted_by = NULL,
                    registration_ip = COALESCE(registration_ip, ?), last_login_ip = ?
                WHERE id = ?`,
                [trimmedName, hashedPassword, registrationIp, registrationIp, existingUser.id]
            );
            userId = existingUser.id;
            console.log(`♻️ [REGISTER] Reactivated soft-deleted account for ${sanitizedEmail} (id: ${userId})`);
        } else {
            // Brand new user
            const result = await dbConfig.run(
                'INSERT INTO users (full_name, email, password, registration_ip, last_login_ip) VALUES (?, ?, ?, ?, ?)',
                [trimmedName, sanitizedEmail, hashedPassword, registrationIp, registrationIp]
            );
            userId = result.lastID || result.id;
        }

        // Give 2 free credits ONLY to first-time registrations
        let freeCredits = 0;
        if (!wasPreviouslyDeleted) {
            try {
                await dbConfig.run(
                    'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)',
                    [userId, 2, 2]
                );
                await dbConfig.run(
                    `INSERT INTO credit_transactions
                    (user_id, transaction_type, credits_change, balance_after, description)
                    VALUES (?, ?, ?, ?, ?)`,
                    [userId, 'purchase', 2, 2, 'Welcome bonus - Free credits']
                );
                freeCredits = 2;
            } catch (creditErr) {
                console.error('Failed to add welcome credits:', creditErr);
            }
        } else {
            console.log(`⚠️ [REGISTER] Skipping free credits for previously-deleted account ${sanitizedEmail}`);
        }

        // Log user registration
        await logSecurityEvent(userId, 'USER_REGISTERED', 'auth', {
            method: 'email_password',
            reactivated: wasPreviouslyDeleted,
            free_credits_given: freeCredits
        }, req);

        // Generate JWT token for auto-login after registration
        const token = jwt.sign(
            { id: userId, email: sanitizedEmail },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            message: freeCredits > 0
                ? 'User created successfully! You received 2 free credits.'
                : 'Account reactivated successfully.',
            token,
            user: {
                id: userId,
                fullName: trimmedName,
                email: sanitizedEmail
            },
            freeCredits
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
                photoPath: user.photo_path || null,
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
        photoPath: req.user.photo_path || null,
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
        photoPath: req.user.photo_path || null,
        email: req.user.email,
        provider: 'google',
        oauth_provider: 'google'
    };
    // Deep link without path to avoid expo-router trying to route it
    // Just query params so the Linking listener can catch it directly
    const IS_PROD = process.env.NODE_ENV === 'production';
    // Derive the Expo dev IP from the request's Referer/Origin or fall back to env/default
    let devIp = process.env.LOCAL_IP || '127.0.0.1';
    if (!IS_PROD) {
        const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
        if (hostHeader) {
            const hostMatch = hostHeader.match(/^([^:]+)/);
            if (hostMatch && hostMatch[1] !== 'localhost' && hostMatch[1] !== '127.0.0.1') {
                devIp = hostMatch[1];
            }
        }

        if (devIp === '127.0.0.1') {
            const referer = req.headers.referer || req.headers.origin || '';
            const ipMatch = referer.match(/\/\/([\d.]+):/);
            if (ipMatch) {
                devIp = ipMatch[1];
            }
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
            
            // Use the correct client ID based on platform and redirect URI
            let clientId;
            // Android relay flow uses HTTPS redirect URI with the web client ID
            if (clientRedirectUri && clientRedirectUri.startsWith('https://')) {
                clientId = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
            } else if (platform === 'ios') {
                clientId = process.env.GOOGLE_IOS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
            } else if (platform === 'android') {
                clientId = process.env.GOOGLE_ANDROID_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
            } else {
                clientId = process.env.GOOGLE_CLIENT_ID;
            }
            
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
                tokenParams.code_verifier = codeVerifier;
                console.log('Using PKCE code_verifier for token exchange');
            }
            // Web client type (HTTPS redirect) requires client_secret even with PKCE
            if (!codeVerifier || (clientRedirectUri && clientRedirectUri.startsWith('https://'))) {
                const clientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
                if (clientSecret) {
                    tokenParams.client_secret = clientSecret;
                    console.log('Using client_secret for token exchange');
                } else if (!codeVerifier) {
                    console.error('Google Client Secret not configured for web flow');
                    return res.status(500).json({ error: 'Server configuration error' });
                }
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
        
        // Capture login IP
        const loginIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || null;

        // Find or create user in database
        try {
            let user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [googleUser.email]);

            if (!user || user.deleted_at) {
                // New user OR reactivating a soft-deleted account
                const wasPreviouslyDeleted = !!(user?.deleted_at);
                const hashedPassword = await bcrypt.hash('google-oauth-' + googleUser.id, 10);
                const usedPkce = !!codeVerifier;

                let newUserId;
                if (wasPreviouslyDeleted) {
                    // Reactivate: restore the row and update OAuth tokens
                    await dbConfig.run(
                        `UPDATE users SET
                            full_name = ?, password = ?, oauth_provider = 'google',
                            google_access_token = ?, google_refresh_token = ?, used_pkce = ?,
                            google_token_issued_at = ?, google_token_expires_at = ?,
                            deleted_at = NULL, deleted_by = NULL, last_login_ip = ?
                        WHERE id = ?`,
                        [
                            googleUser.name, hashedPassword,
                            encryptOAuthToken(finalAccessToken), encryptOAuthToken(finalRefreshToken), usedPkce,
                            issuedAt.toISOString(), expiresAt.toISOString(),
                            loginIp, user.id
                        ]
                    );
                    newUserId = user.id;
                    console.log(`♻️ [GOOGLE AUTH] Reactivated soft-deleted account for ${googleUser.email}`);
                } else {
                    const result = await dbConfig.run(
                        `INSERT INTO users (
                            email, full_name, password, oauth_provider,
                            google_access_token, google_refresh_token, used_pkce,
                            google_token_issued_at, google_token_expires_at,
                            registration_ip, last_login_ip
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                        [
                            googleUser.email, googleUser.name, hashedPassword, 'google',
                            encryptOAuthToken(finalAccessToken),
                            encryptOAuthToken(finalRefreshToken),
                            usedPkce,
                            issuedAt.toISOString(),
                            expiresAt.toISOString(),
                            loginIp, loginIp
                        ]
                    );
                    newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
                }

                // Give 2 free credits ONLY to first-time registrations
                if (!wasPreviouslyDeleted) {
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
                } else {
                    console.log(`⚠️ [GOOGLE AUTH] Skipping free credits for previously-deleted account ${googleUser.email}`);
                }

                // Log registration
                await logSecurityEvent(newUserId, 'USER_REGISTERED', 'oauth', {
                    provider: 'google',
                    flow: 'mobile_api',
                    used_pkce: usedPkce,
                    reactivated: wasPreviouslyDeleted
                }, req);

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
                        provider: 'google'
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
                            google_token_expires_at = ?,
                            last_login_ip = ?
                        WHERE id = ?`,
                        [
                            'google',
                            encryptOAuthToken(finalAccessToken),
                            encryptOAuthToken(finalRefreshToken),
                            usedPkce,
                            issuedAt.toISOString(),
                            expiresAt.toISOString(),
                            loginIp,
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
                            google_token_expires_at = ?,
                            last_login_ip = ?
                        WHERE id = ?`,
                        [
                            'google',
                            encryptOAuthToken(finalAccessToken),
                            usedPkce,
                            issuedAt.toISOString(),
                            expiresAt.toISOString(),
                            loginIp,
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
    // Generate JWT token for the user
    const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    const userData = {
        id: req.user.id,
        fullName: req.user.full_name,
        photoPath: req.user.photo_path || null,
        email: req.user.email,
        provider: 'microsoft',
        oauth_provider: 'microsoft'
    };

    // Check if request is from mobile (Android Chrome Custom Tab or iOS Safari)
    const userAgent = req.headers['user-agent'] || '';
    const isMobile = /Android|iPhone|iPad/i.test(userAgent);

    if (isMobile) {
        // Mobile: server-side 302 redirect to deep link
        // Chrome Custom Tabs can intercept 302 redirects to custom schemes,
        // but NOT client-side JavaScript redirects (window.location.href)
        const deepLink = `cvapplyr://oauth-success?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify(userData))}`;
        console.log('Microsoft Mobile OAuth: redirecting to deep link:', deepLink.substring(0, 100) + '...');
        res.redirect(deepLink);
    } else {
        // Web: redirect to auth-success page
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
        const { accessToken, code, codeVerifier, redirectUri: clientRedirectUri } = req.body;
        
        let finalAccessToken = accessToken;
        let finalRefreshToken = null;
        
        // If authorization code provided, exchange for tokens (mobile PKCE flow)
        if (code) {
            console.log('Authorization code provided, exchanging for tokens...');
            const redirectUri = clientRedirectUri || 'msauth://com.cvapplyr.app/callback';
            
            const tokenParams = new URLSearchParams({
                client_id: process.env.MICROSOFT_CLIENT_ID,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
                scope: 'user.read Mail.Read Mail.Send offline_access',
            });
            if (codeVerifier) {
                tokenParams.append('code_verifier', codeVerifier);
            } else {
                tokenParams.append('client_secret', process.env.MICROSOFT_CLIENT_SECRET);
            }
            
            const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenParams
            });
            
            if (!tokenResponse.ok) {
                const errorData = await tokenResponse.json();
                console.error('Microsoft token exchange error:', errorData);
                return res.status(401).json({ error: 'Failed to exchange authorization code', details: errorData });
            }
            
            const tokenData = await tokenResponse.json();
            console.log('Token exchange successful! Keys:', Object.keys(tokenData));
            console.log('Refresh token present:', !!tokenData.refresh_token);
            finalAccessToken = tokenData.access_token;
            finalRefreshToken = tokenData.refresh_token;
        }
        
        if (!finalAccessToken) {
            console.log('Missing accessToken and code in request');
            return res.status(400).json({ error: 'Access token or authorization code is required' });
        }

        console.log('Verifying access token with Microsoft Graph API...');
        
        // Verify the access token with Microsoft Graph API
        const response = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: {
                'Authorization': `Bearer ${finalAccessToken}`
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

        // Capture login IP
        const msLoginIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || null;
        const msEmail = microsoftUser.mail || microsoftUser.userPrincipalName;

        // Check if user exists (including soft-deleted)
        const user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [msEmail]);
        const wasPreviouslyDeleted = !!(user?.deleted_at);

        if (!user || wasPreviouslyDeleted) {
            // Create new user OR reactivate soft-deleted account
            console.log(wasPreviouslyDeleted
                ? `♻️ Reactivating soft-deleted Microsoft account for ${msEmail}`
                : `Creating new user from Microsoft OAuth...`
            );

            const hashedPassword = await bcrypt.hash('microsoft-oauth-' + microsoftUser.id, 10);
            let newUserId;

            if (wasPreviouslyDeleted) {
                await dbConfig.run(
                    `UPDATE users SET
                        full_name = ?, password = ?, oauth_provider = 'microsoft',
                        microsoft_access_token = ?, microsoft_refresh_token = ?,
                        microsoft_token_issued_at = ?, microsoft_token_expires_at = ?,
                        deleted_at = NULL, deleted_by = NULL, last_login_ip = ?
                    WHERE id = ?`,
                    [
                        microsoftUser.displayName, hashedPassword,
                        encryptOAuthToken(finalAccessToken),
                        finalRefreshToken ? encryptOAuthToken(finalRefreshToken) : null,
                        issuedAt.toISOString(), expiresAt.toISOString(),
                        msLoginIp, user.id
                    ]
                );
                newUserId = user.id;
            } else {
                const result = await dbConfig.run(
                    `INSERT INTO users (
                        email, full_name, password, oauth_provider,
                        microsoft_access_token, microsoft_refresh_token,
                        microsoft_token_issued_at, microsoft_token_expires_at,
                        registration_ip, last_login_ip
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                    [
                        msEmail, microsoftUser.displayName, hashedPassword, 'microsoft',
                        encryptOAuthToken(finalAccessToken),
                        finalRefreshToken ? encryptOAuthToken(finalRefreshToken) : null,
                        issuedAt.toISOString(), expiresAt.toISOString(),
                        msLoginIp, msLoginIp
                    ]
                );
                newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
            }

            // Give 2 free credits ONLY to first-time registrations
            if (!wasPreviouslyDeleted) {
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
                    console.log(`🎁 Gave 2 free welcome credits to new Microsoft user ${msEmail}`);
                } catch (creditErr) {
                    console.error('Failed to add welcome credits:', creditErr);
                }
            } else {
                console.log(`⚠️ Skipping free credits for previously-deleted Microsoft account ${msEmail}`);
            }

            // Log registration
            await logSecurityEvent(newUserId, 'USER_REGISTERED', 'oauth', {
                provider: 'microsoft',
                flow: 'mobile_api',
                reactivated: wasPreviouslyDeleted,
                free_credits_given: wasPreviouslyDeleted ? 0 : 2
            }, req);

            await logSecurityEvent(newUserId, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                provider: 'microsoft',
                flow: 'mobile_api',
                expires_at: expiresAt.toISOString()
            }, req);

            // Generate JWT
            const token = jwt.sign(
                { id: newUserId, email: msEmail },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                success: true,
                token,
                user: {
                    id: newUserId,
                    fullName: microsoftUser.displayName,
                    email: msEmail,
                    oauth_provider: 'microsoft',
                    provider: 'microsoft'
                }
            });
        } else {
            // User exists, update OAuth tokens (ENCRYPTED for security)
            const updateFields = [
                'oauth_provider = ?',
                'microsoft_access_token = ?',
                'microsoft_token_issued_at = ?',
                'microsoft_token_expires_at = ?',
                'last_login_ip = ?'
            ];
            const updateParams = [
                'microsoft',
                encryptOAuthToken(finalAccessToken),
                issuedAt.toISOString(),
                expiresAt.toISOString(),
                msLoginIp
            ];

            if (finalRefreshToken) {
                updateFields.push('microsoft_refresh_token = ?');
                updateParams.push(encryptOAuthToken(finalRefreshToken));
            }

            updateParams.push(user.id);
            await dbConfig.run(
                `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
                updateParams
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
        photoPath: req.user.photo_path || null,
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

        console.log('Identity token length:', identityToken.length);
        console.log('Identity token preview:', identityToken.substring(0, 50) + '...');

        // Decode header to get kid for key lookup
        const tokenParts = identityToken.split('.');
        if (tokenParts.length !== 3) {
            console.error('Token has', tokenParts.length, 'parts instead of 3');
            return res.status(400).json({ error: 'Invalid identity token format' });
        }
        
        // Try both base64url and standard base64 decoding
        let header;
        try {
            header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString());
        } catch (e) {
            console.log('base64url decode failed, trying base64...');
            header = JSON.parse(Buffer.from(tokenParts[0], 'base64').toString());
        }
        console.log('Token header:', JSON.stringify(header));
        
        // Decode payload to inspect claims before verification
        let payload;
        try {
            payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());
        } catch (e) {
            payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        }
        console.log('Token payload (pre-verify):', JSON.stringify({
            iss: payload.iss,
            aud: payload.aud,
            sub: payload.sub,
            email: payload.email,
            exp: payload.exp,
            iat: payload.iat,
            exp_date: new Date(payload.exp * 1000).toISOString(),
            now: new Date().toISOString(),
            expired: Date.now() > payload.exp * 1000
        }));

        // Get Apple's public key and verify the token
        console.log('Fetching Apple signing key for kid:', header.kid);
        const signingKey = await getAppleSigningKey(header.kid);
        console.log('Got signing key, verifying token...');
        
        const decoded = jwt.verify(identityToken, signingKey, {
            algorithms: ['RS256'],
            issuer: 'https://appleid.apple.com',
            audience: payload.aud, // Use the actual audience from the token (handles dev vs prod bundle ID)
            clockTolerance: 120, // Allow 2 minutes of clock skew
        });

        console.log('Apple token verified:', { sub: decoded.sub, email: decoded.email });

        // Apple only sends email/name on FIRST sign-in; afterwards decoded.email may still be present
        const email = appleEmail || decoded.email;
        if (!email) {
            return res.status(400).json({ error: 'No email provided by Apple. Please try again or use a different sign-in method.' });
        }

        // Check if this is a private relay email
        const isPrivateRelay = email.includes('privaterelay.appleid.com');

        // Build display name (Apple may hide real name)
        let displayName = 'Apple User';
        if (fullName && (fullName.givenName || fullName.familyName)) {
            displayName = [fullName.givenName, fullName.familyName].filter(Boolean).join(' ');
        }

        // Also try to find user by apple_user_id (sub) first — more reliable than email for Apple users
        let user = await dbConfig.get('SELECT * FROM users WHERE apple_user_id = ?', [decoded.sub]);
        if (!user) {
            user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);
        }
        // Also check if there's a user with the private relay email for this Apple sub
        if (!user) {
            user = await dbConfig.get('SELECT * FROM users WHERE email LIKE ? AND oauth_provider = ?', ['%privaterelay.appleid.com', 'apple']);
        }

        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);

        // Capture login IP
        const appleLoginIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || null;

        // Check soft-deleted state before branching
        const wasPreviouslyDeletedApple = !!(user?.deleted_at);

        if (!user || wasPreviouslyDeletedApple) {
            // Create new user OR reactivate soft-deleted account
            let newUserId;
            try {
                const hashedPassword = await bcrypt.hash('apple-oauth-' + decoded.sub, 10);
                if (wasPreviouslyDeletedApple) {
                    // Reactivate
                    await dbConfig.run(
                        `UPDATE users SET
                            full_name = ?, password = ?, oauth_provider = 'apple',
                            apple_user_id = ?, apple_identity_token = ?,
                            apple_token_issued_at = ?, apple_token_expires_at = ?,
                            deleted_at = NULL, deleted_by = NULL, last_login_ip = ?
                        WHERE id = ?`,
                        [
                            displayName, hashedPassword, decoded.sub, encryptOAuthToken(identityToken),
                            issuedAt.toISOString(), expiresAt.toISOString(),
                            appleLoginIp, user.id
                        ]
                    );
                    newUserId = user.id;
                    console.log(`♻️ [APPLE AUTH] Reactivated soft-deleted account for ${email}`);
                } else {
                    const result = await dbConfig.run(
                        `INSERT INTO users (
                            email, full_name, password, oauth_provider,
                            apple_user_id, apple_identity_token,
                            apple_token_issued_at, apple_token_expires_at,
                            registration_ip, last_login_ip
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                        [
                            email, displayName, hashedPassword, 'apple',
                            decoded.sub, encryptOAuthToken(identityToken),
                            issuedAt.toISOString(), expiresAt.toISOString(),
                            appleLoginIp, appleLoginIp
                        ]
                    );
                    newUserId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
                }
            } catch (insertErr) {
                // Duplicate email — link Apple to existing account instead
                if (insertErr.code === '23505' || (insertErr.message && insertErr.message.includes('duplicate key'))) {
                    user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);
                    if (user) {
                        // Link Apple to this existing account — fall through to existing user path below
                        console.log(`Linking Apple account to existing user ${user.id} (${user.email})`);
                    } else {
                        throw insertErr;
                    }
                } else {
                    throw insertErr;
                }
            }

            // If we successfully created/reactivated a user (no duplicate)
            if (newUserId && !user) {

            // Give 2 free credits ONLY to first-time registrations
            if (!wasPreviouslyDeletedApple) {
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
            } else {
                console.log(`⚠️ [APPLE AUTH] Skipping free credits for previously-deleted account ${email}`);
            }

            await logSecurityEvent(newUserId, 'USER_REGISTERED', 'oauth', {
                provider: 'apple',
                flow: 'mobile_native',
                reactivated: wasPreviouslyDeletedApple
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
                    provider: 'apple',
                    needsEmailConnect: true
                }
            });
            } // end if (newUserId && !user)
        }
        
        // Existing user (found by lookup OR linked via duplicate email) — update Apple tokens
        if (user) {
            // Only change oauth_provider to 'apple' if user doesn't already have Google/Microsoft
            // (those providers are needed for sending emails via Gmail/Outlook APIs)
            const preserveProvider = user.oauth_provider === 'google' || user.oauth_provider === 'microsoft';
            
            await dbConfig.run(
                `UPDATE users SET 
                    ${preserveProvider ? '' : 'oauth_provider = ?,'}
                    apple_user_id = ?,
                    apple_identity_token = ?,
                    apple_token_issued_at = ?,
                    apple_token_expires_at = ?
                WHERE id = ?`,
                preserveProvider
                    ? [decoded.sub, encryptOAuthToken(identityToken), issuedAt.toISOString(), expiresAt.toISOString(), user.id]
                    : ['apple', decoded.sub, encryptOAuthToken(identityToken), issuedAt.toISOString(), expiresAt.toISOString(), user.id]
            );

            // Update email if Apple provided a real one and DB still has private relay
            if (email && !email.includes('privaterelay.appleid.com') && user.email.includes('privaterelay.appleid.com')) {
                await dbConfig.run('UPDATE users SET email = ? WHERE id = ?', [email, user.id]);
                user.email = email;
            }

            // Update name if Apple provided it and current name is generic
            if (displayName !== 'Apple User' && (user.full_name === 'Apple User' || !user.full_name)) {
                await dbConfig.run('UPDATE users SET full_name = ? WHERE id = ?', [displayName, user.id]);
                user.full_name = displayName;
            }

            await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                provider: 'apple',
                flow: 'mobile_native',
                expires_at: expiresAt.toISOString()
            }, req);

            const currentEmail = user.email;
            const currentName = user.full_name || displayName;

            const token = jwt.sign(
                { id: user.id, email: currentEmail },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    fullName: currentName !== 'Apple User' ? currentName : displayName,
                    email: currentEmail,
                    oauth_provider: user.oauth_provider || 'apple',
                    provider: 'apple',
                    isPrivateRelay: currentEmail.includes('privaterelay.appleid.com'),
                    needsProfileUpdate: currentName === 'Apple User' || currentEmail.includes('privaterelay.appleid.com'),
                    needsEmailConnect: !user.google_access_token && !user.microsoft_access_token
                }
            });
        }
    } catch (error) {
        console.error('Apple Sign-In error:', error.name, error.message);
        console.error('Full error:', error);
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid or expired Apple identity token', details: error.message });
        }
        if (error.name === 'SigningKeyNotFoundError') {
            return res.status(401).json({ error: 'Apple signing key not found. Please try again.', details: error.message });
        }
        return res.status(500).json({ error: 'Apple authentication failed', details: error.message });
    }
};

// Apple Sign-In Web: redirect to Apple authorization URL
const appleWebRedirect = (req, res) => {
    const APPLE_SERVICE_ID = process.env.APPLE_SERVICE_ID;
    if (!APPLE_SERVICE_ID) {
        return res.status(500).send('Apple Sign-In is not configured. APPLE_SERVICE_ID env var is missing.');
    }
    const redirectUri = process.env.NODE_ENV === 'production'
        ? 'https://cvapplyr.com/auth/apple/callback'
        : 'http://localhost:3000/auth/apple/callback';

    const state = require('crypto').randomBytes(16).toString('hex');
    req.session.appleState = state;

    const params = new URLSearchParams({
        client_id: APPLE_SERVICE_ID,
        redirect_uri: redirectUri,
        response_type: 'code id_token',
        scope: 'name email',
        response_mode: 'form_post',
        state: state,
    });

    res.redirect(`https://appleid.apple.com/auth/authorize?${params.toString()}`);
};

// Apple Sign-In Web: handle POST callback from Apple
const appleWebCallback = async (req, res) => {
    try {
        const { id_token, user: userJson, state } = req.body;

        if (!id_token) {
            return res.redirect('/login?error=apple_no_token');
        }

        // Verify state to prevent CSRF
        if (!state || state !== req.session?.appleState) {
            console.warn('Apple web callback: state mismatch');
            return res.redirect('/login?error=apple_state_mismatch');
        }
        delete req.session.appleState;

        // Decode header to get kid
        const tokenParts = id_token.split('.');
        if (tokenParts.length !== 3) {
            return res.redirect('/login?error=apple_invalid_token');
        }

        let header;
        try {
            header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString());
        } catch (e) {
            header = JSON.parse(Buffer.from(tokenParts[0], 'base64').toString());
        }

        let payload;
        try {
            payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());
        } catch (e) {
            payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        }

        // Verify the token
        const signingKey = await getAppleSigningKey(header.kid);
        const decoded = jwt.verify(id_token, signingKey, {
            algorithms: ['RS256'],
            issuer: 'https://appleid.apple.com',
            audience: process.env.APPLE_SERVICE_ID,
            clockTolerance: 120,
        });

        // Apple sends user info (name) only on first authorization, as a JSON string
        let fullName = null;
        if (userJson) {
            try {
                const userData = typeof userJson === 'string' ? JSON.parse(userJson) : userJson;
                if (userData.name) {
                    fullName = [userData.name.firstName, userData.name.lastName].filter(Boolean).join(' ');
                }
            } catch (e) {
                console.log('Could not parse Apple user data:', e.message);
            }
        }

        const email = decoded.email;
        if (!email) {
            return res.redirect('/login?error=apple_no_email');
        }

        const displayName = fullName || 'Apple User';
        const isPrivateRelay = email.includes('privaterelay.appleid.com');

        // Find or create user (same logic as mobile appleAuth)
        let existingUser = await dbConfig.get('SELECT * FROM users WHERE apple_user_id = ?', [decoded.sub]);
        if (!existingUser) {
            existingUser = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);
        }
        if (!existingUser) {
            existingUser = await dbConfig.get('SELECT * FROM users WHERE email LIKE ? AND oauth_provider = ?', ['%privaterelay.appleid.com', 'apple']);
        }

        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);

        const webLoginIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || null;
        const wasPreviouslyDeletedWeb = !!(existingUser?.deleted_at);

        let userId, userEmail, userName;

        if (!existingUser || wasPreviouslyDeletedWeb) {
            // Create new user OR reactivate soft-deleted account
            const hashedPassword = await bcrypt.hash('apple-oauth-' + decoded.sub, 10);
            if (wasPreviouslyDeletedWeb) {
                await dbConfig.run(
                    `UPDATE users SET
                        full_name = ?, password = ?, oauth_provider = 'apple',
                        apple_user_id = ?, apple_identity_token = ?,
                        apple_token_issued_at = ?, apple_token_expires_at = ?,
                        deleted_at = NULL, deleted_by = NULL, last_login_ip = ?
                    WHERE id = ?`,
                    [displayName, hashedPassword, decoded.sub, encryptOAuthToken(id_token),
                     issuedAt.toISOString(), expiresAt.toISOString(), webLoginIp, existingUser.id]
                );
                userId = existingUser.id;
                console.log(`♻️ [APPLE WEB] Reactivated soft-deleted account for ${email}`);
            } else {
                const result = await dbConfig.run(
                    `INSERT INTO users (
                        email, full_name, password, oauth_provider,
                        apple_user_id, apple_identity_token,
                        apple_token_issued_at, apple_token_expires_at,
                        registration_ip, last_login_ip
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                    [email, displayName, hashedPassword, 'apple',
                     decoded.sub, encryptOAuthToken(id_token),
                     issuedAt.toISOString(), expiresAt.toISOString(),
                     webLoginIp, webLoginIp]
                );
                userId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
            }
            userEmail = email;
            userName = displayName;

            // Give 2 free credits ONLY to first-time registrations
            if (!wasPreviouslyDeletedWeb) {
                try {
                    await dbConfig.run('INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)', [userId, 2, 2]);
                    await dbConfig.run(
                        `INSERT INTO credit_transactions (user_id, transaction_type, credits_change, balance_after, description) VALUES (?, ?, ?, ?, ?)`,
                        [userId, 'purchase', 2, 2, 'Welcome bonus - Free credits']
                    );
                } catch (creditErr) {
                    console.error('Failed to add welcome credits:', creditErr);
                }
            } else {
                console.log(`⚠️ [APPLE WEB] Skipping free credits for previously-deleted account ${email}`);
            }
        } else {
            // Update existing user's Apple tokens
            const preserveProvider = existingUser.oauth_provider === 'google' || existingUser.oauth_provider === 'microsoft';
            await dbConfig.run(
                `UPDATE users SET 
                    ${preserveProvider ? '' : 'oauth_provider = ?,'}
                    apple_user_id = ?,
                    apple_identity_token = ?,
                    apple_token_issued_at = ?,
                    apple_token_expires_at = ?
                WHERE id = ?`,
                preserveProvider
                    ? [decoded.sub, encryptOAuthToken(id_token), issuedAt.toISOString(), expiresAt.toISOString(), existingUser.id]
                    : ['apple', decoded.sub, encryptOAuthToken(id_token), issuedAt.toISOString(), expiresAt.toISOString(), existingUser.id]
            );
            userId = existingUser.id;
            userEmail = existingUser.email;
            userName = existingUser.full_name || displayName;
        }

        // Generate JWT and redirect same as Google/Microsoft
        const token = jwt.sign({ id: userId, email: userEmail }, JWT_SECRET, { expiresIn: '24h' });

        const userDataObj = {
            id: userId,
            fullName: userName,
            email: userEmail,
            provider: 'apple',
            oauth_provider: 'apple'
        };

        res.cookie('authToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: 'strict'
        });
        res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userDataObj))}`);
    } catch (error) {
        console.error('Apple Web Sign-In error:', error.name, error.message);
        res.redirect('/login?error=apple_auth_failed');
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

// Link Google account to existing user (for users who signed in via Apple)
// Same token exchange as googleAuth but links to the authenticated user instead of creating/switching accounts
const linkGoogle = async (req, res) => {
    try {
        const userId = req.user.id;
        const { code, codeVerifier, redirectUri: clientRedirectUri, platform } = req.body;

        if (!code) {
            return res.status(400).json({ error: 'Authorization code is required' });
        }

        // Exchange authorization code for tokens (same logic as googleAuth)
        // Use the correct client ID based on platform — iOS auth codes require the iOS client ID
        let clientId;
        if (platform === 'ios') {
            clientId = process.env.GOOGLE_IOS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
        } else if (platform === 'android') {
            clientId = process.env.GOOGLE_ANDROID_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
        } else {
            clientId = process.env.GOOGLE_CLIENT_ID;
        }
        let redirectUri = clientRedirectUri;
        if (!redirectUri) {
            if (platform === 'ios') {
                const clientIdPrefix = clientId.split('.apps.googleusercontent.com')[0];
                redirectUri = `com.googleusercontent.apps.${clientIdPrefix}:/oauth2redirect/google`;
            } else {
                redirectUri = 'com.cvapplyr.mobile:/oauth2redirect/google';
            }
        }

        const tokenParams = {
            code,
            client_id: clientId,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        };

        if (codeVerifier) {
            tokenParams.code_verifier = codeVerifier;
        } else {
            tokenParams.client_secret = process.env.GOOGLE_CLIENT_SECRET;
        }

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(tokenParams)
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Google token exchange error (link):', errorData);
            return res.status(401).json({ error: 'Failed to exchange authorization code', details: errorData });
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;

        // Verify the Google account
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            return res.status(401).json({ error: 'Failed to verify Google account' });
        }

        const googleUser = await userInfoResponse.json();
        console.log(`Linking Google account (${googleUser.email}) to user ${userId}`);

        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);

        // Update user with Google tokens — preserve apple fields, set oauth_provider to google for email sending
        const updateFields = [
            'oauth_provider = ?',
            'google_access_token = ?',
            'used_pkce = ?',
            'google_token_issued_at = ?',
            'google_token_expires_at = ?'
        ];
        const updateParams = [
            'google',
            encryptOAuthToken(accessToken),
            !!codeVerifier,
            issuedAt.toISOString(),
            expiresAt.toISOString()
        ];

        if (refreshToken) {
            updateFields.push('google_refresh_token = ?');
            updateParams.push(encryptOAuthToken(refreshToken));
        }

        updateParams.push(userId);
        await dbConfig.run(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
            updateParams
        );

        await logSecurityEvent(userId, 'OAUTH_ACCOUNT_LINKED', 'oauth', {
            provider: 'google',
            linked_email: googleUser.email,
            flow: 'account_link'
        }, req);

        return res.json({
            success: true,
            linkedEmail: googleUser.email,
            provider: 'google',
            message: `Google account (${googleUser.email}) connected successfully. Emails will now be sent from your Gmail.`
        });
    } catch (error) {
        console.error('Link Google error:', error);
        return res.status(500).json({ error: 'Failed to link Google account', details: error.message });
    }
};

/**
 * Link Microsoft/Outlook account for Apple Sign-In users (email sending)
 * Accepts an access token obtained via the mobile Microsoft OAuth flow
 */
const linkMicrosoft = async (req, res) => {
    try {
        const userId = req.user.id;
        const { accessToken, code, codeVerifier, redirectUri: clientRedirectUri } = req.body;

        let finalAccessToken = accessToken;
        let finalRefreshToken = null;
        
        // If authorization code provided, exchange for tokens (PKCE flow)
        if (code) {
            const redirectUri = clientRedirectUri || 'msauth://com.cvapplyr.app/callback';
            
            const tokenParams = new URLSearchParams({
                client_id: process.env.MICROSOFT_CLIENT_ID,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
                scope: 'user.read Mail.Read Mail.Send offline_access',
            });
            if (codeVerifier) {
                tokenParams.append('code_verifier', codeVerifier);
            } else {
                tokenParams.append('client_secret', process.env.MICROSOFT_CLIENT_SECRET);
            }
            
            const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenParams
            });
            
            if (!tokenResponse.ok) {
                const errorData = await tokenResponse.json();
                console.error('Microsoft token exchange error (link):', errorData);
                return res.status(401).json({ error: 'Failed to exchange authorization code', details: errorData });
            }
            
            const tokenData = await tokenResponse.json();
            finalAccessToken = tokenData.access_token;
            finalRefreshToken = tokenData.refresh_token;
        }
        
        if (!finalAccessToken) {
            return res.status(400).json({ error: 'Access token or authorization code is required' });
        }

        // Verify the access token with Microsoft Graph API
        const response = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { 'Authorization': `Bearer ${finalAccessToken}` }
        });

        if (!response.ok) {
            return res.status(401).json({ error: 'Invalid Microsoft access token' });
        }

        const microsoftUser = await response.json();
        const msEmail = microsoftUser.mail || microsoftUser.userPrincipalName;
        console.log(`Linking Microsoft account (${msEmail}) to user ${userId}`);

        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);

        const updateFields = [
            'oauth_provider = ?',
            'microsoft_access_token = ?',
            'microsoft_token_issued_at = ?',
            'microsoft_token_expires_at = ?'
        ];
        const updateParams = [
            'microsoft',
            encryptOAuthToken(finalAccessToken),
            issuedAt.toISOString(),
            expiresAt.toISOString()
        ];
        
        if (finalRefreshToken) {
            updateFields.push('microsoft_refresh_token = ?');
            updateParams.push(encryptOAuthToken(finalRefreshToken));
        }
        
        updateParams.push(userId);
        await dbConfig.run(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
            updateParams
        );

        await logSecurityEvent(userId, 'OAUTH_ACCOUNT_LINKED', 'oauth', {
            provider: 'microsoft',
            linked_email: msEmail,
            flow: 'account_link'
        }, req);

        return res.json({
            success: true,
            linkedEmail: msEmail,
            provider: 'microsoft',
            message: `Microsoft account (${msEmail}) connected successfully. Emails will now be sent from your Outlook.`
        });
    } catch (error) {
        console.error('Link Microsoft error:', error);
        return res.status(500).json({ error: 'Failed to link Microsoft account', details: error.message });
    }
};

/**
 * Revoke linked email provider (Google/Microsoft) — clears tokens, resets oauth_provider
 * User remains signed in via Apple (or local account)
 */
const revokeEmailProvider = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get current user to log what's being revoked
        const user = await dbConfig.get('SELECT oauth_provider, email FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const previousProvider = user.oauth_provider;
        if (!previousProvider || (previousProvider !== 'google' && previousProvider !== 'microsoft')) {
            return res.status(400).json({ error: 'No email provider connected to revoke' });
        }

        // Clear all email-sending tokens and reset provider
        await dbConfig.run(
            `UPDATE users SET 
                oauth_provider = NULL,
                google_access_token = NULL,
                google_refresh_token = NULL,
                google_token_issued_at = NULL,
                google_token_expires_at = NULL,
                microsoft_access_token = NULL,
                microsoft_refresh_token = NULL,
                microsoft_token_issued_at = NULL,
                microsoft_token_expires_at = NULL,
                used_pkce = false
            WHERE id = ?`,
            [userId]
        );

        await logSecurityEvent(userId, 'OAUTH_PROVIDER_REVOKED', 'oauth', {
            previous_provider: previousProvider,
            flow: 'manual_revoke'
        }, req);

        const providerName = previousProvider === 'google' ? 'Gmail' : 'Outlook';
        return res.json({
            success: true,
            message: `${providerName} access has been revoked. Emails will now be sent from our system address.`
        });
    } catch (error) {
        console.error('Revoke email provider error:', error);
        return res.status(500).json({ error: 'Failed to revoke email provider', details: error.message });
    }
};

// Android OAuth relay — receives authorization code from provider via HTTPS callback,
// then redirects to deep link so the app can extract the code and exchange it via API.
const googleAndroidRelay = (req, res) => {
    const code = req.query.code;
    const error = req.query.error;
    if (error) {
        console.log('Google Android relay error:', error);
        return res.redirect(`cvapplyr://oauth-error?error=${encodeURIComponent(error)}&provider=google`);
    }
    if (!code) {
        return res.redirect('cvapplyr://oauth-error?error=no_code&provider=google');
    }
    console.log('Google Android relay: forwarding code to app via deep link');
    res.redirect(`cvapplyr://oauth-callback?code=${encodeURIComponent(code)}&provider=google`);
};

const microsoftAndroidRelay = (req, res) => {
    const code = req.query.code;
    const error = req.query.error;
    if (error) {
        console.log('Microsoft Android relay error:', error);
        return res.redirect(`cvapplyr://oauth-error?error=${encodeURIComponent(error)}&provider=microsoft`);
    }
    if (!code) {
        return res.redirect('cvapplyr://oauth-error?error=no_code&provider=microsoft');
    }
    console.log('Microsoft Android relay: forwarding code to app via deep link');
    res.redirect(`cvapplyr://oauth-callback?code=${encodeURIComponent(code)}&provider=microsoft`);
};

module.exports = {
    register,
    login,
    logout,
    googleCallback,
    googleMobileCallback,
    googleAuth,
    googleAndroidRelay,
    microsoftCallback,
    microsoftAuth,
    microsoftAndroidRelay,
    appleAuth,
    appleWebRedirect,
    appleWebCallback,
    linkedinCallback,
    changePassword,
    linkGoogle,
    linkMicrosoft,
    revokeEmailProvider
};
