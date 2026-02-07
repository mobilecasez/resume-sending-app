const dbConfig = require('./db-config');

async function checkOAuth() {
    const user = await dbConfig.get('SELECT id, email, oauth_provider, google_access_token, google_refresh_token FROM users WHERE id = 1');
    console.log('User OAuth Status:');
    console.log('  Email:', user.email);
    console.log('  Provider:', user.oauth_provider);
    console.log('  Has Access Token:', !!user.google_access_token);
    console.log('  Access Token Length:', user.google_access_token?.length || 0);
    console.log('  Has Refresh Token:', !!user.google_refresh_token);
    console.log('  Refresh Token Length:', user.google_refresh_token?.length || 0);
    process.exit(0);
}

checkOAuth().catch(console.error);
