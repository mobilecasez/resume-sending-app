// Auto-generated config - DO NOT EDIT MANUALLY
// This file is updated automatically by start-all.sh

const LOCAL_API_URL = 'http://192.168.1.44:3000/api';
const PRODUCTION_API_URL = 'https://cvapplyr.com/api';

const API_BASE = __DEV__ ? LOCAL_API_URL : PRODUCTION_API_URL;

/**
 * Safe JSON fetch — wraps the native fetch so that if the server ever
 * returns an HTML error page (e.g. proxy down, wrong URL) the app gets
 * a proper Error instead of a cryptic "JSON Parse error: Unexpected <".
 */
async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(
      `Server returned non-JSON response (${response.status}) for ${url}.\n` +
      `First 200 chars: ${text.slice(0, 200)}`
    );
  }
  return response;
}

export default { API_BASE_URL: API_BASE };
export { API_BASE, LOCAL_API_URL, PRODUCTION_API_URL, apiFetch };
