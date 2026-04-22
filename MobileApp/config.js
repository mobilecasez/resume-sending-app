import Constants from 'expo-constants';
import { Platform } from 'react-native';

const PRODUCTION_API_URL = 'https://cvapplyr.com/api';

function extractHostFromExpo() {
	const hostCandidates = [
		Constants.expoConfig?.hostUri,
		Constants.manifest2?.extra?.expoClient?.hostUri,
		Constants.manifest?.debuggerHost,
	];

	for (const candidate of hostCandidates) {
		if (!candidate || typeof candidate !== 'string') continue;
		const host = candidate.split(':')[0];
		if (host) return host;
	}

	return null;
}

function getLocalApiUrl() {
	// Manual override if needed: EXPO_PUBLIC_API_BASE_URL=http://192.168.x.x:3000/api
	if (process.env.EXPO_PUBLIC_API_BASE_URL) {
		return process.env.EXPO_PUBLIC_API_BASE_URL;
	}

	const expoHost = extractHostFromExpo();
	if (expoHost) {
		return `http://${expoHost}:3000/api`;
	}

	// Simulator/emulator fallback when host cannot be derived
	if (Platform.OS === 'android') {
		return 'http://10.0.2.2:3000/api';
	}
	return 'http://localhost:3000/api';
}

const LOCAL_API_URL = getLocalApiUrl();
const API_BASE = __DEV__ ? LOCAL_API_URL : PRODUCTION_API_URL;

export default { API_BASE_URL: API_BASE };
export { API_BASE, LOCAL_API_URL, PRODUCTION_API_URL };
