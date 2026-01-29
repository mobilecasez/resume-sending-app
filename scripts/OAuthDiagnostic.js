import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

// DIAGNOSTIC TEST COMPONENT
// Use this to test the OAuth flow step-by-step

const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
const API_BASE = 'http://192.168.1.14:3000/api';

WebBrowser.maybeCompleteAuthSession();

export default function OAuthDiagnostic() {
  const [output, setOutput] = useState('Ready for testing...\n');
  const [logs, setLogs] = useState([]);

  // Intercept console.log to show in UI
  const addLog = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    setLogs(prev => [...prev, logEntry]);
    setOutput(prev => prev + logEntry + '\n');
  };

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: GOOGLE_CLIENT_ID,
  });

  // Monitor response
  useEffect(() => {
    if (response?.type === 'success') {
      addLog('✅ OAuth response received successfully!');
      const token = response.authentication?.accessToken;
      addLog(`Token length: ${token?.length || 0}`);
      addLog(`Token: ${token?.substring(0, 50)}...`);
      testToken(token);
    } else if (response?.type === 'error') {
      addLog('❌ OAuth error: ' + response.error?.message);
    } else if (response?.type === 'dismiss') {
      addLog('⚠️ OAuth cancelled by user');
    }
  }, [response]);

  const testToken = async (token) => {
    if (!token) {
      addLog('❌ ERROR: No token available!');
      return;
    }

    addLog('Starting token test...');
    addLog(`API Base: ${API_BASE}`);

    try {
      addLog('Sending POST request to /api/auth/google...');
      const fetchResponse = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token })
      });

      addLog(`Response status: ${fetchResponse.status}`);
      const data = await fetchResponse.json();
      addLog('Response body: ' + JSON.stringify(data, null, 2));

      if (fetchResponse.ok) {
        addLog('✅ SUCCESS! User authenticated');
        addLog(`User: ${data.user?.fullName} (${data.user?.email})`);
      } else {
        addLog(`❌ Server error: ${data.error}`);
      }
    } catch (err) {
      addLog(`❌ Network error: ${err.message}`);
    }
  };

  const testEndpoint = async () => {
    addLog('\n--- Manual Endpoint Test ---');
    addLog('Sending empty request (should get 400)...');

    try {
      const res = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      addLog(`Status: ${res.status}`);
      addLog(`Response: ${JSON.stringify(data)}`);
    } catch (err) {
      addLog(`Error: ${err.message}`);
    }
  };

  const testWithFakeToken = async () => {
    addLog('\n--- Fake Token Test ---');
    addLog('Sending fake token (should get 401)...');

    try {
      const res = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: 'fake_token_test_12345' })
      });
      const data = await res.json();
      addLog(`Status: ${res.status}`);
      addLog(`Response: ${JSON.stringify(data)}`);
    } catch (err) {
      addLog(`Error: ${err.message}`);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Google OAuth Diagnostic</Text>
        <Text style={styles.subtitle}>Test the OAuth flow step by step</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Configuration Check</Text>
        <View style={styles.config}>
          <Text style={styles.configItem}>
            Client ID: {GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com' ? '❌ Placeholder' : '✅ Set'}
          </Text>
          <Text style={styles.configItem}>
            API Base: {API_BASE}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Test Actions</Text>
        
        <TouchableOpacity 
          style={styles.button}
          onPress={() => promptAsync()}
          disabled={!request}
        >
          <Text style={styles.buttonText}>1. Test Real Google OAuth</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={styles.button}
          onPress={testEndpoint}
        >
          <Text style={styles.buttonText}>2. Test Empty Request (400)</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={styles.button}
          onPress={testWithFakeToken}
        >
          <Text style={styles.buttonText}>3. Test Fake Token (401)</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.button, styles.dangerButton]}
          onPress={() => {
            setLogs([]);
            setOutput('Ready for testing...\n');
            addLog('Logs cleared');
          }}
        >
          <Text style={styles.buttonText}>Clear Logs</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Diagnostic Output</Text>
        <View style={styles.logBox}>
          <ScrollView>
            {logs.map((log, i) => (
              <Text key={i} style={styles.logText}>{log}</Text>
            ))}
          </ScrollView>
        </View>
      </View>

      <View style={styles.instructions}>
        <Text style={styles.instructionTitle}>How to Use:</Text>
        <Text style={styles.instructionText}>
          1. Make sure GOOGLE_CLIENT_ID is set (not placeholder){'\n'}
          2. Make sure backend is running on port 3000{'\n'}
          3. Click "Test Real Google OAuth" to try full flow{'\n'}
          4. Or test individual steps with other buttons{'\n'}
          5. Check logs to see what's happening
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 16,
  },
  header: {
    marginBottom: 24,
    marginTop: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 12,
  },
  config: {
    backgroundColor: '#f9f9f9',
    borderRadius: 6,
    padding: 12,
  },
  configItem: {
    fontSize: 13,
    color: '#333',
    marginBottom: 8,
    fontFamily: 'Courier New',
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  dangerButton: {
    backgroundColor: '#FF3B30',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  logBox: {
    backgroundColor: '#f5f5f5',
    borderRadius: 6,
    padding: 12,
    maxHeight: 300,
    borderColor: '#ddd',
    borderWidth: 1,
  },
  logText: {
    fontSize: 12,
    fontFamily: 'Courier New',
    color: '#333',
    marginBottom: 4,
  },
  instructions: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
    borderLeftWidth: 4,
    borderLeftColor: '#FFA500',
  },
  instructionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  instructionText: {
    fontSize: 13,
    color: '#666',
    lineHeight: 20,
  },
});
