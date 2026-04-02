const fs = require('fs');

// Read server.js
let content = fs.readFileSync('server.js', 'utf8');

// Track conversions
let conversions = 0;

// Pattern 1: Convert db.get with callback to async/await
// db.get('SQL', [params], (err, row) => { ... })
const dbGetPattern = /db\.get\(([^,]+),\s*(\[[^\]]*\]),\s*(?:async\s*)?\((?:err,\s*)?(\w+)\)\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;

content = content.replace(dbGetPattern, (match, sql, params, varName, body) => {
    conversions++;
    // Remove error handling from body
    let newBody = body.replace(/if\s*\(err\)\s*\{[^}]*\}/g, '');
    newBody = newBody.replace(/if\s*\(![\w]+\)\s*\{[^}]*return[^;]*;\s*\}/g, '');
    
    return `const ${varName} = await dbConfig.get(${sql}, ${params});${newBody}`;
});

// Pattern 2: Convert db.all with callback
const dbAllPattern = /db\.all\(([^,]+),\s*(\[[^\]]*\]),\s*(?:async\s*)?\((?:err,\s*)?(\w+)\)\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;

content = content.replace(dbAllPattern, (match, sql, params, varName, body) => {
    conversions++;
    let newBody = body.replace(/if\s*\(err\)\s*\{[^}]*\}/g, '');
    
    return `const ${varName} = await dbConfig.query(${sql}, ${params});${newBody}`;
});

// Pattern 3: Convert db.run with callback
const dbRunPattern = /db\.run\(([^,]+),\s*(\[[^\]]*\]),\s*(?:function\s*)?\((?:err)?\)\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;

content = content.replace(dbRunPattern, (match, sql, params, body) => {
    conversions++;
    let newBody = body.replace(/if\s*\(err\)\s*\{[^}]*\}/g, '');
    
    return `await dbConfig.run(${sql}, ${params});${newBody}`;
});

console.log(`Total conversions made: ${conversions}`);

// Write back
fs.writeFileSync('server.js.converted', content);
console.log('Converted file saved as server.js.converted');
console.log('Review the file and rename it to server.js if correct');
