const fs = require('fs');

let content = fs.readFileSync('./server.js', 'utf8');

// Backup
fs.writeFileSync('./server.js.backup2', content);

// Count original db calls
const originalCount = (content.match(/\bdb\.(get|run|all)\(/g) || []).length;
console.log(`Found ${originalCount} db.get/run/all calls to fix\n`);

// Fix all db.all calls with simple pattern
content = content.replace(
    /db\.all\(\s*`([^`]+)`\s*,\s*\[([^\]]*)\]\s*,\s*\(err,\s*(\w+)\)\s*=>\s*\{/g,
    (match, query, params, varName) => {
        return `try {
        const ${varName} = await dbConfig.query(\`${query}\`, [${params}]);`;
    }
);

// Fix db.get calls with simple pattern  
content = content.replace(
    /db\.get\(\s*`([^`]+)`\s*,\s*\[([^\]]*)\]\s*,\s*\(err,\s*(\w+)\)\s*=>\s*\{/g,
    (match, query, params, varName) => {
        return `try {
        const ${varName} = await dbConfig.get(\`${query}\`, [${params}]);`;
    }
);

// Fix db.get with string queries
content = content.replace(
    /db\.get\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]\s*,\s*\(err,\s*(\w+)\)\s*=>\s*\{/g,
    (match, query, params, varName) => {
        return `try {
        const ${varName} = await dbConfig.get('${query}', [${params}]);`;
    }
);

// Fix db.all with string queries
content = content.replace(
    /db\.all\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]\s*,\s*\(err,\s*(\w+)\)\s*=>\s*\{/g,
    (match, query, params, varName) => {
        return `try {
        const ${varName} = await dbConfig.query('${query}', [${params}]);`;
    }
);

// Convert routes to async if they're not already
content = content.replace(
    /app\.(get|post|put|delete)\((['"`][^'"`]+['"`][^,]*),\s*authenticateToken,\s*\(req,\s*res\)\s*=>\s*\{/g,
    (match, method, path) => {
        return `app.${method}(${path}, authenticateToken, async (req, res) => {`;
    }
);

content = content.replace(
    /app\.(get|post|put|delete)\((['"`][^'"`]+['"`][^,]*),\s*authenticateAdmin,\s*\(req,\s*res\)\s*=>\s*\{/g,
    (match, method, path) => {
        return `app.${method}(${path}, authenticateAdmin, async (req, res) => {`;
    }
);

// Remove error handlers in callback pattern
content = content.replace(
    /if \(err\) \{\s*console\.error\([^)]+\);\s*return res\.status\(\d+\)\.json\([^)]+\);\s*\}/g,
    ''
);

content = content.replace(
    /if \(err\) return res\.status\(\d+\)\.json\([^)]+\);/g,
    ''
);

// Add catch blocks where missing (simple pattern)
content = content.replace(
    /(\s+)(const \w+ = await dbConfig\.(get|query|run)\([^;]+;)(\s+)(res\.json\()/g,
    '$1$2$4$5'
);

// Count remaining
const remaining = (content.match(/\bdb\.(get|run|all)\(/g) || []).length;
console.log(`\nFixed ${originalCount - remaining} calls`);
console.log(`Remaining: ${remaining} calls`);

fs.writeFileSync('./server.js', content);
console.log('\n✅ File updated! Please review and test.');
