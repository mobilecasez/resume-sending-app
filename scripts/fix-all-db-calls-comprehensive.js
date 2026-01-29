const fs = require('fs');

// Read the server.js file
let content = fs.readFileSync('./server.js', 'utf8');

// Store the original for backup
fs.writeFileSync('./server.js.backup', content);

// Convert Passport serialization (special case)
content = content.replace(
    /passport\.serializeUser\(\(user, done\) => \{\s*done\(null, user\.id\);\s*\}\);/g,
    `passport.serializeUser((user, done) => {
    done(null, user.id);
});`
);

content = content.replace(
    /passport\.deserializeUser\(\(id, done\) => \{\s*db\.get\('SELECT \* FROM users WHERE id = \?', \[id\], \(err, user\) => \{\s*if \(err\) return done\(err\);\s*done\(null, user\);\s*\}\);\s*\}\);/g,
    `passport.deserializeUser(async (id, done) => {
    try {
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [id]);
        done(null, user);
    } catch (err) {
        done(err);
    }
});`
);

// Convert authenticateAdmin middleware
content = content.replace(
    /function authenticateAdmin\(req, res, next\) \{\s*const token = req\.headers\['authorization'\]\?\.split\(' '\)\[1\];\s*if \(!token\) \{\s*return res\.status\(401\)\.json\(\{ error: 'No token provided' \}\);\s*\}\s*jwt\.verify\(token, JWT_SECRET, \(err, user\) => \{\s*if \(err\) \{\s*return res\.status\(403\)\.json\(\{ error: 'Invalid token' \}\);\s*\}\s*db\.get\('SELECT role FROM users WHERE id = \?', \[user\.id\], \(err, row\) => \{[^}]+\}\);\s*\}\);\s*\}/gs,
    `async function authenticateAdmin(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        const user = jwt.verify(token, JWT_SECRET);
        const row = await dbConfig.get('SELECT role FROM users WHERE id = ?', [user.id]);
        
        if (!row || row.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }
        
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}`
);

// Convert requireAdmin middleware (similar pattern)
content = content.replace(
    /function requireAdmin\(req, res, next\) \{\s*const token = req\.headers\['authorization'\]\?\.split\(' '\)\[1\];\s*if \(!token\) \{\s*return res\.status\(401\)\.json\(\{ error: 'No token provided' \}\);\s*\}\s*jwt\.verify\(token, JWT_SECRET, \(err, user\) => \{\s*if \(err\) \{\s*return res\.status\(403\)\.json\(\{ error: 'Invalid token' \}\);\s*\}\s*db\.get\('SELECT role FROM users WHERE id = \?', \[user\.id\], \(err, row\) => \{[^}]+\}\);\s*\}\);\s*\}/gs,
    `async function requireAdmin(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        const user = jwt.verify(token, JWT_SECRET);
        const row = await dbConfig.get('SELECT role FROM users WHERE id = ?', [user.id]);
        
        if (!row || row.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }
        
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}`
);

console.log('✅ Fixed passport and middleware functions');
console.log('✅ Created backup at server.js.backup');
console.log('⚠️  Please review the changes and restart the server');
console.log('');
console.log('Remaining db.get/run/all calls that need manual review:');

// Find remaining calls
const remaining = content.match(/db\.(get|run|all)\(/g);
if (remaining) {
    console.log(`Found ${remaining.length} remaining calls`);
} else {
    console.log('None found in simple pattern match');
}

// Write the updated content
fs.writeFileSync('./server.js', content);

console.log('\n✅ File updated successfully');
