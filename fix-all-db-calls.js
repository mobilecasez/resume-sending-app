const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');

// Track which lines have db.get/run/all calls that need async parent
const routesNeedingAsync = new Set();

// Find all route definitions that contain db calls
lines.forEach((line, i) => {
    if (line.match(/app\.(get|post|put|delete|patch)\(/)) {
        // Check if this route contains db calls
        const routeStart = i;
        let braceCount = 0;
        let foundDbCall = false;
        
        for (let j = i; j < lines.length && (braceCount > 0 || j === i); j++) {
            const currentLine = lines[j];
            braceCount += (currentLine.match(/\{/g) || []).length;
            braceCount -= (currentLine.match(/\}/g) || []).length;
            
            if (currentLine.match(/db\.(get|run|all)\(/)) {
                foundDbCall = true;
            }
            
            if (braceCount === 0 && j > i) {
                if (foundDbCall) {
                    routesNeedingAsync.add(routeStart);
                }
                break;
            }
        }
    }
});

console.log(`Found ${routesNeedingAsync.size} routes needing async conversion`);

// Convert routes to async if not already
routesNeedingAsync.forEach(lineNum => {
    const line = lines[lineNum];
    if (!line.includes('async') && line.match(/app\.(get|post|put|delete|patch)\([^,]+,\s*authenticateToken,\s*\(/)) {
        lines[lineNum] = line.replace(/(authenticateToken,\s*)\(/, '$1async (');
        console.log(`Made route async at line ${lineNum + 1}`);
    } else if (!line.includes('async') && line.match(/app\.(get|post|put|delete|patch)\([^,]+,\s*\(/)) {
        lines[lineNum] = line.replace(/,\s*\(/, ', async (');
        console.log(`Made route async at line ${lineNum + 1}`);
    }
});

content = lines.join('\n');

// Now do the replacements
let replacements = 0;

// Pattern 1: db.get with callback
content = content.replace(/db\.get\(([^)]+)\),\s*\[([^\]]*)\],\s*(?:async\s*)?\(err,\s*(\w+)\)\s*=>\s*\{/g, (match, sql, params, varName) => {
    replacements++;
    return `const ${varName} = await dbConfig.get(${sql}), [${params}]);\nif (${varName}) {`;
});

// Pattern 2: db.get simpler
content = content.replace(/db\.get\('([^']+)',\s*\[([^\]]*)\],\s*(?:async\s*)?\(err,\s*(\w+)\)\s*=>\s*\{/g, (match, sql, params, varName) => {
    replacements++;
    return `const ${varName} = await dbConfig.get('${sql}', [${params}]);\nif (${varName}) {`;
});

// Pattern 3: db.all
content = content.replace(/db\.all\('([^']+)',\s*\[([^\]]*)\],\s*(?:async\s*)?\(err,\s*(\w+)\)\s*=>\s*\{/g, (match, sql, params, varName) => {
    replacements++;
    return `const ${varName} = await dbConfig.query('${sql}', [${params}]);\n{`;
});

// Pattern 4: db.run
content = content.replace(/db\.run\('([^']+)',\s*\[([^\]]*)\],\s*(?:function\s*)?\(err\)\s*=>\s*\{/g, (match, sql, params) => {
    replacements++;
    return `await dbConfig.run('${sql}', [${params}]);\n{`;
});

console.log(`Made ${replacements} db call replacements`);

fs.writeFileSync('server.js.autofix', content);
console.log('Saved to server.js.autofix - please review before using');
