// Auto-generated config - DO NOT EDIT MANUALLY
// This file is updated automatically by start-all.sh

const LOCAL_API_URL = 'http://192.168.1.2:3000/api';
const PRODUCTION_API_URL = 'https://your-production-domain.com/api';

const API_BASE = __DEV__ ? LOCAL_API_URL : PRODUCTION_API_URL;

export default { API_BASE_URL: API_BASE };
export { API_BASE, LOCAL_API_URL, PRODUCTION_API_URL };
