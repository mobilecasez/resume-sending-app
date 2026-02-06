const jwt = require('jsonwebtoken');
const dbConfig = require('../../db-config');

/**
 * Authentication middleware
 * Verifies JWT token from Authorization header
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified;
        next();
    } catch (error) {
        res.status(403).json({ error: 'Invalid or expired token' });
    }
}

/**
 * Admin authentication middleware
 * Verifies JWT token and checks if user has admin role
 */
async function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        
        // Check if user is admin
        const row = await dbConfig.get('SELECT role FROM users WHERE id = ?', [user.id]);
        
        if (!row || row.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
        }
        req.user = user;
        next();
    } catch (error) {
        console.error('Admin auth error:', error);
        res.status(403).json({ error: 'Invalid or expired token' });
    }
}

module.exports = { authenticateToken, authenticateAdmin };
