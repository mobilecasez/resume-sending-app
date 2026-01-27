// API Configuration
// This should match your backend server IP and port
// Use your local IP address (check with ipconfig getifaddr en0 on Mac)

// For local development, use your local IP address
// For production, use your Railway URL
const IS_PRODUCTION = false; // Set to true when deploying

const LOCAL_API_URL = 'http://192.168.1.15:3000';
const PRODUCTION_API_URL = 'https://cvapplyr-website-production.up.railway.app';

const API_BASE_URL = IS_PRODUCTION ? PRODUCTION_API_URL : LOCAL_API_URL;

export const API_BASE = `${API_BASE_URL}/api`;

export default {
  API_BASE_URL,
  API_BASE,
};
