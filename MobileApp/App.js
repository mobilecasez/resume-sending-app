import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Dimensions, StatusBar, Image, ImageBackground, SafeAreaView, Animated, Modal, ActivityIndicator, KeyboardAvoidingView, Platform, TouchableWithoutFeedback, Keyboard, Linking, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView as SafeAreaViewContext, SafeAreaProvider } from 'react-native-safe-area-context';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { downloadAsync, cacheDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { API_BASE, PRODUCTION_API_URL } from './config';
import { router as expoRouter } from 'expo-router'; // AI Hub navigation
import { registerForPushNotificationsAsync } from './services/pushNotificationService'; // AI Hub — push notifications
import SplashScreen from './components/SplashScreen';
import DateTimePicker from '@react-native-community/datetimepicker';
import HomeScreen, { clearHomeScreenCache } from './components/HomeScreen';
import FloatingTabBar from './components/FloatingTabBar';
import ReviewScreen from './components/ReviewScreen';
import RateAppModal from './components/RateAppModal'; // AI Hub — dedicated "Rate this App" entry
import { regionFromCountry, bestRegion, employerAddress } from './regionUtils';

// Apple IAP Product IDs - must match App Store Connect products
const IAP_PRODUCT_IDS = [
  'com.cvapplyr.mobile.starter',
  'com.cvapplyr.mobile.professional',
  'com.cvapplyr.mobile.premium',
  'com.cvapplyr.mobile.enterprise',
];

// Map Apple product IDs to plan IDs (from database)
const APPLE_PRODUCT_TO_PLAN = {
  'com.cvapplyr.mobile.starter': 1,
  'com.cvapplyr.mobile.professional': 2,
  'com.cvapplyr.mobile.premium': 3,
  'com.cvapplyr.mobile.enterprise': 4,
};

const GOOGLE_CLIENT_ID_IOS = '151384459549-3rm4atu5eu3ekh9h4rhds6gbd9ecgeb6.apps.googleusercontent.com';
const GOOGLE_CLIENT_ID_ANDROID = '151384459549-ro8tqemri24dc3n2lh7ak5t3fjr365nl.apps.googleusercontent.com';
const GOOGLE_CLIENT_ID_WEB = '151384459549-ujnpfbck9e0q2jkmt2q4l0lv1s41lp04.apps.googleusercontent.com';

// Microsoft OAuth Client ID from Azure Portal
const MICROSOFT_CLIENT_ID = '9205782b-1a57-4c2f-bbfd-8136b5378e96';

// Generate PKCE code verifier + challenge for Microsoft OAuth
async function generatePKCE() {
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  const verifier = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  const challenge = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

const { width, height} = Dimensions.get('window');
const AUTH_SERVER_URL = __DEV__ ? API_BASE.replace(/\/api$/, '') : PRODUCTION_API_URL;

WebBrowser.maybeCompleteAuthSession();

const isExpoGo = Constants.appOwnership === 'expo';
const createNoopSubscription = () => ({ remove: () => {} });

let RazorpayCheckout = null;
let nativeIapAvailable = false;

// Fallbacks for Expo Go / missing native module scenarios
let initConnection = async () => false;
let fetchProducts = async () => [];
let requestPurchase = async () => null;
let finishTransaction = async () => {};
let purchaseUpdatedListener = () => createNoopSubscription();

// Load native payment modules in real builds (dev build / TestFlight / App Store / Play Store)
// These modules are NOT available in Expo Go — guard with try/catch so the app doesn't crash
if (!isExpoGo) {
  try {
    const iap = require('react-native-iap');
    initConnection       = iap.initConnection;
    fetchProducts        = iap.getProducts;
    requestPurchase      = iap.requestPurchase;
    finishTransaction    = iap.finishTransaction;
    purchaseUpdatedListener = iap.purchaseUpdatedListener;
    nativeIapAvailable   = true;
    console.log('✅ react-native-iap loaded');
  } catch (e) {
    console.warn('⚠️ react-native-iap not available:', e.message);
  }

  try {
    RazorpayCheckout = require('react-native-razorpay').default;
    console.log('✅ react-native-razorpay loaded');
  } catch (e) {
    console.warn('⚠️ react-native-razorpay not available:', e.message);
  }
}

const normalizeHTML = (html) => {
  if (!html) return '';
  let result = html
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '</p><p>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  if (!result.startsWith('<p>')) result = '<p>' + result + '</p>';
  return result.replace(/<p><\/p>/gi, '');
};

const RichTextEditorWebView = ({ initialHtml, onContentChange }) => {
  const webViewRef = useRef(null);

  // Normalize the HTML to have proper paragraph structure
  const normalizedHtml = normalizeHTML(initialHtml);

  const editorHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
          padding: 2px;
          background: white;
        }
        .toolbar {
          position: sticky;
          top: 0;
          background: #f3f4f6;
          padding: 8px;
          border-bottom: 1px solid #d1d5db;
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          z-index: 10;
        }
        .toolbar button {
          padding: 6px 12px;
          border: 1px solid #9ca3af;
          background: white;
          border-radius: 4px;
          font-size: 14px;
          cursor: pointer;
          font-weight: 500;
        }
        .toolbar button:active {
          background: #e5e7eb;
        }
        .editor {
          min-height: ${height - 60}px;
          padding: 6px;
          outline: none;
          line-height: 1.7;
          font-size: 15px;
          color: #333;
          overflow-y: auto;
        }
        .editor p {
          display: block;
          margin: 0 0 16px 0;
          line-height: 1.7;
        }
        .editor p:last-child {
          margin-bottom: 0;
        }
        .editor strong {
          font-weight: 700;
          color: #1e40af;
        }
        .editor br {
          display: block;
          content: "";
        }
        /* Style consecutive br tags as paragraph breaks */
        .editor br + br {
          display: block;
          margin-bottom: 12px;
          content: "";
        }
        .editor ul, .editor ol {
          margin: 12px 0;
          padding-left: 24px;
        }
        .editor li {
          margin: 6px 0;
        }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <button onclick="document.execCommand('bold')"><strong>B</strong></button>
        <button onclick="document.execCommand('italic')"><em>I</em></button>
        <button onclick="document.execCommand('underline')"><u>U</u></button>
        <button onclick="document.execCommand('insertUnorderedList')">• List</button>
        <button onclick="document.execCommand('insertOrderedList')">1. List</button>
      </div>
      <div class="editor" contenteditable="true" id="editor"></div>
      
      <script>
        const editor = document.getElementById('editor');
        
        // Set initial content - PRESERVE EXACT HTML (normalized to proper paragraphs)
        editor.innerHTML = ${JSON.stringify(normalizedHtml || '<p>Start typing...</p>')};
        
        // Send content changes to React Native
        let debounceTimer;
        editor.addEventListener('input', function() {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const html = editor.innerHTML;
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'contentChange',
              html: html
            }));
          }, 300);
        });
        
        // Focus editor on load
        editor.focus();
      </script>
    </body>
    </html>
  `;

  return (
    <WebView
      ref={webViewRef}
      source={{ html: editorHTML }}
      onMessage={(event) => {
        try {
          const data = JSON.parse(event.nativeEvent.data);
          if (data.type === 'contentChange' && onContentChange) {
            onContentChange(data.html);
          }
        } catch (e) {
          console.error('Error parsing WebView message:', e);
        }
      }}
      style={{ height, borderRadius: 6, borderWidth: 1, borderColor: '#17a2b8' }}
      bounces={false}
      scrollEnabled={true}
      originWhitelist={['*']}
      javaScriptEnabled={true}
    />
  );
};

// Simple HTML Preview Component (for fallback)
const FormattedCoverLetterPreview = ({ htmlContent, style }) => {
  if (!htmlContent) {
    return <Text style={style}>No content</Text>;
  }

  // Replace <br> with newlines, then split to create paragraphs
  let content = String(htmlContent);
  const lines = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/g, '')
    .replace(/<\/p>/g, '\n')
    .replace(/<strong>/g, '')
    .replace(/<\/strong>/g, '')
    .replace(/<[^>]*>/g, '')
    .split('\n');

  return (
    <View>
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return <View key={`empty-${idx}`} style={{ height: 8 }} />;
        
        return (
          <Text 
            key={`line-${idx}`}
            style={style}
          >
            {trimmed}
          </Text>
        );
      })}
    </View>
  );
};

const HTMLContentViewer = ({ htmlContent, style }) => {
  const styledHtml = `
    <!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
             font-size: 15px; line-height: 1.7; color: #1a1a2e;
             padding: 12px 16px; margin: 0; background: transparent; }
      p { margin: 0 0 14px 0; }
      strong { font-weight: 700; color: #1e40af; }
      ul, ol { margin: 10px 0; padding-left: 22px; }
      li { margin: 5px 0; }
    </style></head>
    <body>${htmlContent || ''}</body></html>`;
  return (
    <WebView
      source={{ html: styledHtml }}
      style={[{ flex: 1, backgroundColor: 'transparent' }, style]}
      scrollEnabled={true}
      originWhitelist={['*']}
      javaScriptEnabled={false}
    />
  );
};

/**
 * Safe JSON parser for fetch responses.
 * If the server returns HTML (error page, 502, etc.) instead of JSON,
 * this returns a structured error object instead of throwing a parse error.
 */
async function safeResponseJson(response) {
  const text = await response.text();
  if (!text || text.trim() === '') {
    return { error: `Server returned empty response (HTTP ${response.status})` };
  }
  const firstChar = text.trim()[0];
  if (firstChar === '<') {
    // HTML page — server error, gateway timeout, 502, etc.
    const statusHint = response.status >= 500
      ? `Server error (${response.status}). Please try again in a moment.`
      : response.status === 404
      ? `API endpoint not found (${response.status}).`
      : `Unexpected response from server (${response.status}).`;
    console.warn('[safeResponseJson] Server returned HTML instead of JSON:', text.substring(0, 200));
    return { error: statusHint };
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn('[safeResponseJson] JSON parse failed:', e.message, '| Body:', text.substring(0, 200));
    return { error: `Invalid response from server. Please try again.` };
  }
}

function AppContent() {
  const [showSplash, setShowSplash] = useState(true);
  const [screen, setScreen] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);
  const heroAnim = useRef(new Animated.Value(0)).current;
  const [proTipText, setProTipText] = useState('');
  const proTipTimerRef = useRef(null);
  const userRef = useRef(null);
  const sessionRestoredRef = useRef(false);
  // Keep ref in sync so link handlers always have the latest token
  useEffect(() => { userRef.current = user; }, [user]);

  // Slow zoom + drift animation for login/register hero
  useEffect(() => {
    if (screen === 'login' || screen === 'register') {
      heroAnim.setValue(0);
      Animated.loop(
        Animated.sequence([
          Animated.timing(heroAnim, { toValue: 1, duration: 9000, useNativeDriver: true }),
          Animated.timing(heroAnim, { toValue: 0, duration: 9000, useNativeDriver: true }),
        ])
      ).start();
    }
  }, [screen]);

  // Rotating pro tips with typing animation
  const PRO_TIPS = [
    'Upload your resume once, send 100s of tailored applications.',
    'AI drafts each cover letter uniquely — never copy-paste.',
    'Credits never expire — apply at your own pace.',
    'Bulk-send to dozens of recruiters in a single click.',
    'Track every application from one clean dashboard.',
    'Powered by Google Gemini for recruiter-ready letters.',
  ];
  useEffect(() => {
    if (screen !== 'login' && screen !== 'register') return;
    let tipIdx = 0;
    let charIdx = 0;
    let isDeleting = false;
    const tick = () => {
      const full = PRO_TIPS[tipIdx];
      if (!isDeleting) {
        charIdx++;
        setProTipText(full.slice(0, charIdx));
        if (charIdx === full.length) {
          isDeleting = true;
          proTipTimerRef.current = setTimeout(tick, 2200);
        } else {
          proTipTimerRef.current = setTimeout(tick, 45);
        }
      } else {
        charIdx--;
        setProTipText(full.slice(0, charIdx));
        if (charIdx === 0) {
          isDeleting = false;
          tipIdx = (tipIdx + 1) % PRO_TIPS.length;
          proTipTimerRef.current = setTimeout(tick, 400);
        } else {
          proTipTimerRef.current = setTimeout(tick, 22);
        }
      }
    };
    proTipTimerRef.current = setTimeout(tick, 600);
    return () => clearTimeout(proTipTimerRef.current);
  }, [screen]);

  // Save user session to SecureStore whenever user changes
  useEffect(() => {
    if (user?.token && user?.id) {
      SecureStore.setItemAsync('userSession', JSON.stringify(user)).catch(err => 
        console.log('Failed to save session:', err)
      );
    }
  }, [user]);

  // AI Hub — push notifications. Once the user is logged in, register this
  // device's Expo push token so the backend can notify them when their slow
  // employer job search finishes. Best-effort: the helper swallows all errors.
  useEffect(() => {
    if (user?.token) {
      registerForPushNotificationsAsync();
    }
  }, [user?.token]);

  // Restore saved session on app start
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const stored = await SecureStore.getItemAsync('userSession');
        if (!stored) return;
        
        const savedUser = JSON.parse(stored);
        if (!savedUser?.token) return;
        
        // Validate token with server
        const response = await fetch(`${API_BASE}/users/profile`, {
          headers: {
            'Authorization': `Bearer ${savedUser.token}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (response.ok) {
          const profileData = await safeResponseJson(response);
          if (profileData.error) throw new Error(profileData.error);
          // Merge server profile data with saved session (server data is more up-to-date)
          const restoredUser = {
            ...savedUser,
            fullName: profileData.fullName || savedUser.fullName,
            email: profileData.email || savedUser.email,
            oauth_provider: profileData.oauth_provider || savedUser.oauth_provider,
          };
          setUser(restoredUser);
          sessionRestoredRef.current = true;
          setScreen('dashboard');
          console.log('✅ Session restored for:', restoredUser.email);
        } else {
          // Token expired or invalid — clear stored session
          await SecureStore.deleteItemAsync('userSession');
          console.log('🔑 Stored session expired, showing login');
        }
      } catch (err) {
        console.log('Session restore error:', err);
      }
    };
    restoreSession();
  }, []);
  
  // Track app background/foreground state
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const wasBackground = appStateRef.current.match(/inactive|background/);
      appStateRef.current = nextAppState;
      
      // When returning to foreground with an active job, polling auto-resumes
      // (pollJobStatus checks appStateRef.current === 'active')
      if (wasBackground && nextAppState === 'active' && activeJobRef.current) {
        console.log('📱 App foregrounded with active job:', activeJobRef.current.jobId);
      }
    });
    return () => subscription?.remove();
  }, []);

  // AI Hub bridge — "Edit Cover Letter" from job-detail page.
  // Fires in AppContent after expo-router stack is dismissed.
  // Fixes: (1) no HomeScreen flash, (2) CL loads on card, (3) no duplicate cards.
  useEffect(() => {
    let handling = false;
    const iv = setInterval(async () => {
      if (handling) return;
      try {
        const raw = await AsyncStorage.getItem('aiHub_add_recipient_with_cl');
        if (!raw) return;
        handling = true;
        await AsyncStorage.removeItem('aiHub_add_recipient_with_cl');
        // NOTE: do NOT remove aiHub_navigate_home here — the (ai-hub)/index relay
        // useFocusEffect must consume it to call router.back() and dismiss expo-router.
        // If we remove it here first, the relay finds nothing and the stack stays open.

        const { website, position, coverLetterHtml, companyName, companyAddress, companyLocations, recipientEmail } = JSON.parse(raw);
        const websiteClean   = (website || '').trim();
        const positionClean  = (position || '').trim();
        const contactEmail   = (recipientEmail || '').trim();
        const companyClean   = (companyName || '').trim();

        // UNIQUE per-card link key. NOT the email (it may be the shared user placeholder) and
        // NOT just the website (it can be empty). companyName disambiguates different employers
        // even when the website didn't resolve — so vertigis and icmag never collide.
        const companyKey = (companyClean || websiteClean || 'company').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 30);
        const clKey = contactEmail || `${companyKey}_${positionClean.toLowerCase().replace(/[^a-z0-9]/g, '')}`.substring(0, 48);

        // When no real hiring email was found, default the recipient to the USER'S OWN email
        // (an obvious, editable placeholder — never a fabricated address). We warn them to update
        // it before sending. The recipient↔cover-letter link is the unique clKey, never the email.
        const userEmail = (userRef?.current?.email || '').trim();
        const usedUserEmailFallback = !contactEmail && !!userEmail;
        const recipientEmailFinal = contactEmail || userEmail; // '' only if the user truly has no email

        // Subject — same formula as emailController: "Application for {position} - {fullName}"
        const fullName = userRef?.current?.fullName || userRef?.current?.full_name || '';
        const subject  = `Application for ${positionClean}${fullName ? ` - ${fullName}` : ''}`;

        // Build the cover letter entry — keyed by the unique clKey (also stored on the recipient).
        const clEntry = {
          coverLetterHtml: coverLetterHtml || '',
          companyName: companyName || '',
          address: companyAddress || '',          // ReviewScreen reads activeCL.address
          subject,                                // ReviewScreen reads activeCL.subject
          locations: Array.isArray(companyLocations) && companyLocations.length > 0
            ? companyLocations
            : undefined,                          // ReviewScreen uses this for address dropdown
          generated: true,
          sent: false,
          storedRecipientEmail: clKey,
          storedRecipientWebsite: websiteClean,
          storedRecipientPosition: positionClean,
          storedRecipientClKey: clKey,            // authoritative unique link to the recipient
          date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        };

        // Deduplicate by the unique clKey (same job re-applied = same clKey = update in place).
        let tabIndex = 0;
        setRecipients(prev => {
          const existingIdx = prev.findIndex(
            r => r.clKey ? r.clKey === clKey : (r.website === websiteClean && r.position === positionClean)
          );
          if (existingIdx >= 0) {
            tabIndex = existingIdx;
            return prev.map((r, i) =>
              i === existingIdx ? { ...r, email: recipientEmailFinal, clKey } : r
            );
          }
          tabIndex = 0;
          const newId = Math.max(...prev.map(r => r.id), -1) + 1;
          return [
            { id: newId, email: recipientEmailFinal, website: websiteClean, position: positionClean, clKey, error: '' },
            ...prev,
          ];
        });

        // Batch all setters — React 18 merges into one render → no HomeScreen flash
        setReviewCoverLetters(prev => ({ ...prev, [clKey]: clEntry }));
        setCurrentReviewTab(tabIndex);
        setScreen('review');

        // Tell the user we used their own email as a placeholder for the hiring manager.
        if (usedUserEmailFallback) {
          setTimeout(() => Alert.alert(
            'Add the hiring email',
            'We couldn\'t find a hiring manager email for this job, so we\'ve filled in your own email as a placeholder. Please update it with the real recipient before sending.'
          ), 400);
        }

      } catch (e) {
        console.warn('[aiHub bridge] error:', e);
      } finally {
        handling = false;
      }
    }, 400);
    return () => clearInterval(iv);
  }, []);

  const [recipients, setRecipients] = useState([
    { id: 0, email: '', website: '', position: '', error: '' }
  ]);
  const [showSettings, setShowSettings] = useState(false);
  
  // Animation for side menu - slides from right
  const slideAnim = useRef(new Animated.Value(300)).current; // Start off-screen (300px to the right)
  
  // iOS only: Handle Google OAuth response from expo-auth-session hook (fallback/unused — iOS now uses direct WebBrowser flow)
  // Kept for safety but the main iOS flow handles responses directly in handleGoogleLoginIOS
  useEffect(() => {
    if (!googleResponse || Platform.OS !== 'ios') return;
    if (googleResponse.type === 'success') {
      const { code } = googleResponse.params;
      handleGoogleAuthResponse(code, googleRequest?.codeVerifier, googleRequest?.redirectUri);
    } else if (googleResponse.type === 'error') {
      console.error('Google auth error:', googleResponse.error);
      setError('Google login failed: ' + (googleResponse.error?.message || 'Unknown error'));
    }
  }, [googleResponse]);

  // Android only: handle deep link from backend mobile OAuth flow (fallback for edge cases)
  // Dev: exp://192.168.1.10:8081/?token=JWT&user=...
  // Prod: cvapplyr://oauth-success?token=JWT&user=...
  useEffect(() => {
    const handleDeepLink = (event) => {
      const url = event.url || event;
      console.log('Deep link received:', url);
      if (!url) return;
      // Quick check: must contain 'token=' to be our OAuth callback
      if (!url.includes('token=')) return;
      try {
        const urlObj = new URL(url);
        const token = urlObj.searchParams.get('token');
        const userStr = urlObj.searchParams.get('user');
        if (token && userStr) {
          const userData = JSON.parse(decodeURIComponent(userStr));
          console.log('✅ Google mobile auth complete via deep link');
          console.log('User:', userData.email);
          setUser({ ...userData, token });
          setScreen('dashboard');
          setLoading(false);
          Alert.alert('Success', `Welcome ${userData.fullName}!`);
        }
      } catch (e) {
        console.error('Deep link parse error:', e);
      }
    };

    // Check if app was opened via deep link
    Linking.getInitialURL().then((url) => { if (url) handleDeepLink({ url }); });
    const sub = Linking.addEventListener('url', handleDeepLink);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (showSettings) {
      // Opening: animate from 300 to 0
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 8,
        tension: 40,
        useNativeDriver: true,
      }).start();
    } else {
      // Closing: animate from current position to 300
      Animated.timing(slideAnim, {
        toValue: 300,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [showSettings]);
  
  const [profileData, setProfileData] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    dateOfBirth: '',
    gender: '',
    profileImage: null,
    resume: null,
    signature: null,
    createdAt: new Date(),
  });
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [showSignatureGenerator, setShowSignatureGenerator] = useState(false);
  const [signatureGenerating, setSignatureGenerating] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDobDate, setTempDobDate] = useState(new Date());
  const tempDobDateRef = useRef(new Date());
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCompleteProfileModal, setShowCompleteProfileModal] = useState(false);
  const [completeProfileEmail, setCompleteProfileEmail] = useState('');
  const [completeProfileName, setCompleteProfileName] = useState('');
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  const [privacySettings, setPrivacySettings] = useState({
    emailNotifications: true,
    smsNotifications: false,
    profilePublic: false,
  });
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  // AI Hub — dedicated "Rate this App" modal (opened from the Account Actions menu).
  const [showRateApp, setShowRateApp] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [reviewCoverLetters, setReviewCoverLetters] = useState({});
  const [applicationHistory, setApplicationHistory] = useState([]);
  const [totalGenerated, setTotalGenerated] = useState(0);
  const [totalSent, setTotalSent] = useState(0);
  const [totalReplied, setTotalReplied] = useState(0);
  const [countersLoaded, setCountersLoaded] = useState(false);
  const [creditBalance, setCreditBalance] = useState(0);
  const [expiringCredits, setExpiringCredits] = useState(0);
  const [creditExpiryDate, setCreditExpiryDate] = useState(null);
  const [usageData, setUsageData] = useState(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [currentReviewTab, setCurrentReviewTab] = useState(0);
  const [reviewGeneratingIndex, setReviewGeneratingIndex] = useState(null);
  const [reviewGeneratingAll, setReviewGeneratingAll] = useState(false);
  const [reviewSendingAll, setReviewSendingAll] = useState(false);
  const [reviewGeneratingAndSendingAll, setReviewGeneratingAndSendingAll] = useState(false);
  const [progressiveLoadingMessage, setProgressiveLoadingMessage] = useState('');
  const [progressiveLoadingProgress, setProgressiveLoadingProgress] = useState(0);
  const progressAnimValue = useRef(new Animated.Value(0)).current;
  const progressIntervalRef = useRef(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState('');
  // expo-auth-session Google hook builds the auth URL + PKCE code verifier.
  // iOS uses this for direct PKCE flow. Android uses backend-mediated flow instead.
  const iosRedirectUri = `com.googleusercontent.apps.${GOOGLE_CLIENT_ID_IOS.split('.apps.googleusercontent.com')[0]}:/oauth2redirect/google`;
  const [googleRequest, googleResponse, googlePromptAsync] = Google.useAuthRequest({
    iosClientId: GOOGLE_CLIENT_ID_IOS,
    androidClientId: GOOGLE_CLIENT_ID_ANDROID,
    webClientId: GOOGLE_CLIENT_ID_WEB,
    redirectUri: Platform.OS === 'ios' ? iosRedirectUri : undefined,
    scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'], // gmail.readonly removed — re-enable after CASA
    extraParams: { access_type: 'offline', prompt: 'consent' }, // Request refresh token for persistent access
  });
  const [selectedCoverLetterIndex, setSelectedCoverLetterIndex] = useState(null);
  const [showCoverLetterPreview, setShowCoverLetterPreview] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [reviewDownloading, setReviewDownloading] = useState(false);
  const [editingReviewIndex, setEditingReviewIndex] = useState(null);
  const [adminPackages, setAdminPackages] = useState([]);
  const [loadingAdminPackages, setLoadingAdminPackages] = useState(false);
  const [editingPackage, setEditingPackage] = useState(null);
  const [showPackageForm, setShowPackageForm] = useState(false);
  const [packageFormData, setPackageFormData] = useState({
    name: '',
    amount: '',
    credits: '',
    validity_days: '',
    display_order: '',
    description: '',
    is_popular: false
  });
  const [editedCoverLetterData, setEditedCoverLetterData] = useState({});
  const [showAddressDropdown, setShowAddressDropdown] = useState(false);
  const [showReviewDatePicker, setShowReviewDatePicker] = useState(false);
  const [showReplyDetailsModal, setShowReplyDetailsModal] = useState(false);
  const [selectedReplyDetails, setSelectedReplyDetails] = useState(null);
  const abortControllerRef = useRef(null);
  const isCancelledRef = useRef(false);
  
  // Background state tracking
  const appStateRef = useRef(AppState.currentState);
  const requestInProgressRef = useRef(false);
  const activeJobRef = useRef(null); // tracks {jobId, type, recipientIndex} for polling

  /**
   * Poll server for async job completion. Pauses when app is backgrounded,
   * resumes when foregrounded. Returns the job result data.
   */
  const pollJobStatus = (jobId) => {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      let lastServerProgress = 0;
      let displayProgress = 1;
      let driftInterval = null;
      let ceiling = 30; // start higher so early bar feels fast
      let lastMessagePct = -1;
      
      // Detailed message steps for each batch type
      const batchMessages = {
        generate: [
          { at: 1,  msg: '🔍 Fetching your profile details...' },
          { at: 10, msg: '🌐 Researching employer details...' },
          { at: 24, msg: '🏢 Analyzing company culture & requirements...' },
          { at: 40, msg: '🤝 Fetching skills & matching requirements...' },
          { at: 60, msg: '✍️ Crafting your personalized cover letter...' },
          { at: 80, msg: '🎨 Formatting and adding final touches...' },
          { at: 90, msg: '📄 Generating PDF document...' },
          { at: 95, msg: '✨ Almost done, finalizing content...' },
        ],
        send: [
          { at: 1,  msg: '🚀 Preparing to send...' },
          { at: 30, msg: '🔒 Setting up secure email delivery...' },
          { at: 60, msg: '📧 Sending application to employer...' },
          { at: 85, msg: '✅ Confirming delivery status...' },
          { at: 95, msg: '✨ Finalizing and saving records...' },
        ],
        pdf: [
          { at: 1,  msg: '📄 Gathering cover letter data...' },
          { at: 30, msg: '🎨 Formatting PDF layout...' },
          { at: 60, msg: '🖨️ Generating PDF document...' },
          { at: 90, msg: '💾 Finalizing download...' },
        ],
        batch_generate_and_send: [
          { at: 1,  msg: '🚀 Starting auto process...' },
          { at: 4,  msg: '🔍 Fetching your profile details...' },
          { at: 8,  msg: '📋 Loading recipient information...' },
          { at: 12, msg: '🌐 Researching employer details...' },
          { at: 18, msg: '🏢 Analyzing company culture & requirements...' },
          { at: 25, msg: '🤝 Matching your skills with job requirements...' },
          { at: 35, msg: '✍️ Crafting personalized cover letters...' },
          { at: 48, msg: '📝 Tailoring content for each recipient...' },
          { at: 58, msg: '🎨 Formatting and adding final touches...' },
          { at: 68, msg: '📄 Generating PDF documents...' },
          { at: 78, msg: '✅ Reviewing generated cover letters...' },
          { at: 88, msg: '🔒 Preparing secure email delivery...' },
          { at: 92, msg: '📧 Sending applications to employers...' },
          { at: 96, msg: '✨ Finalizing and saving records...' },
        ],
        batch_generate: [
          { at: 1,  msg: '🚀 Starting generation...' },
          { at: 5,  msg: '🔍 Fetching your profile details...' },
          { at: 10, msg: '📋 Loading recipient information...' },
          { at: 18, msg: '🌐 Researching employer details...' },
          { at: 28, msg: '🏢 Analyzing company culture & requirements...' },
          { at: 38, msg: '🤝 Matching your skills with job requirements...' },
          { at: 50, msg: '✍️ Crafting personalized cover letters...' },
          { at: 65, msg: '📝 Tailoring content for each recipient...' },
          { at: 78, msg: '🎨 Formatting and adding final touches...' },
          { at: 88, msg: '📄 Generating PDF documents...' },
          { at: 95, msg: '✨ Almost done, finalizing...' },
        ],
        batch_send: [
          { at: 1,  msg: '🚀 Preparing to send...' },
          { at: 10, msg: '🔒 Setting up secure email delivery...' },
          { at: 25, msg: '📧 Sending applications to employers...' },
          { at: 55, msg: '📬 Delivering to remaining recipients...' },
          { at: 80, msg: '✅ Confirming delivery status...' },
          { at: 95, msg: '✨ Finalizing and saving records...' },
        ],
      };
      
      // Update message based on current display progress
      const updateMessage = (pct) => {
        const jobType = activeJobRef.current?.type;
        const steps = batchMessages[jobType];
        if (!steps) return;
        
        // Find the latest message whose threshold we've passed
        let msg = null;
        for (let i = steps.length - 1; i >= 0; i--) {
          if (pct >= steps[i].at) {
            msg = steps[i].msg;
            break;
          }
        }
        if (msg && pct !== lastMessagePct) {
          lastMessagePct = pct;
          setProgressiveLoadingMessage(msg);
        }
      };
      
      // Continuous drift — always keeps the bar moving, decelerating as it nears the ceiling
      const startDrift = () => {
        if (driftInterval) return; // already running
        driftInterval = setInterval(() => {
          // Slowly raise the ceiling over time if it's stuck below 95%
          if (ceiling < 95) {
             ceiling = Math.min(ceiling + 0.5, 95);
          }
          
          const remaining = ceiling - displayProgress;
          if (remaining <= 0.2) return; // close enough, just wait for next ceiling bump
          // Move ~4% of the remaining gap each tick → fast at first, decelerates smoothly
          const step = Math.max(0.3, remaining * 0.04);
          displayProgress = Math.min(displayProgress + step, ceiling);
          const rounded = Math.floor(displayProgress);
          setProgressiveLoadingProgress(rounded);
          Animated.timing(progressAnimValue, {
            toValue: rounded,
            duration: 80,
            useNativeDriver: false
          }).start();
          // Update message as display progress moves
          updateMessage(rounded);
        }, 100);
      };
      
      // When server reports new progress, raise the ceiling so the drift speeds up toward it
      const nudgeCeiling = (serverPct) => {
        // Set ceiling slightly ahead of server value to keep bar always moving
        // Don't lower the ceiling if it has already drifted past this point
        const newCeiling = Math.min(serverPct + 5, 95);
        if (newCeiling > ceiling) {
          ceiling = newCeiling;
        }
        
        // If display is already past the new server value, just keep going
        if (displayProgress < serverPct) {
          // Boost a little so the user sees a visible acceleration
          const boost = Math.max(0.5, (serverPct - displayProgress) * 0.15);
          displayProgress += boost;
        }
      };
      
      const cleanup = () => {
        if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
      };
      
      // Start drifting immediately so the bar moves from the very first moment
      startDrift();
      
      // STOP the simulated progressive loading interval if it's running
      // This prevents two intervals from fighting over the same progress state
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      
      const poll = async () => {
        if (cancelled || isCancelledRef.current) {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        
        // Pause polling when app is backgrounded
        if (appStateRef.current !== 'active') {
          setTimeout(poll, 1000);
          return;
        }
        
        try {
          const response = await fetch(`${API_BASE}/job-status/${jobId}`, {
            headers: { 'Authorization': `Bearer ${user.token}` }
          });
          
          if (!response.ok) {
            cleanup();
            reject(new Error(`Job status check failed: ${response.status}`));
            return;
          }
          
          const job = await response.json();
          
          if (job.status === 'completed') {
            cleanup();
            activeJobRef.current = null;
            // Quick smooth finish to 100 %
            displayProgress = 100;
            setProgressiveLoadingProgress(100);
            setProgressiveLoadingMessage('🎉 All done!');
            Animated.timing(progressAnimValue, {
              toValue: 100,
              duration: 300,
              useNativeDriver: false
            }).start();
            resolve(job.data);
          } else if (job.status === 'failed') {
            cleanup();
            activeJobRef.current = null;
            reject(new Error(job.error || 'Job failed'));
          } else {
            // Raise ceiling when server reports real progress
            if (job.progress != null && job.progress > lastServerProgress) {
              lastServerProgress = job.progress;
              nudgeCeiling(lastServerProgress);
            }
            setTimeout(poll, 3000);
          }
        } catch (error) {
          // Network error during polling — retry, don't fail
          if (!cancelled && !isCancelledRef.current) {
            setTimeout(poll, 3000);
          }
        }
      };
      
      poll();
    });
  };

  // Packages screen state
  const [userPackages, setUserPackages] = useState([]);
  const [loadingUserPackages, setLoadingUserPackages] = useState(false);
  
  // Apple IAP state
  const [iapProducts, setIapProducts] = useState([]);
  const [iapConnected, setIapConnected] = useState(false);
  const [restoringPurchases, setRestoringPurchases] = useState(false);
  const purchaseUpdateSubscription = useRef(null);
  const purchaseErrorSubscription = useRef(null);
  const userTokenRef = useRef(null);
  const processedTransactionsRef = useRef(new Set());

  // Keep userTokenRef in sync with current token
  useEffect(() => {
    userTokenRef.current = user?.token || null;
  }, [user?.token]);

  // Shared Apple IAP verification function — called from both listener and requestPurchase result
  const verifyAndCreditApplePurchase = async (purchase) => {
    const txId = purchase.transactionId || purchase.id;
    if (!txId) {
      console.warn('🍎 No transaction ID on purchase, skipping');
      return;
    }

    // Guard against duplicate processing (listener + requestPurchase return may both fire)
    if (processedTransactionsRef.current.has(txId)) {
      console.log('🍎 Transaction already processed:', txId);
      return;
    }
    processedTransactionsRef.current.add(txId);

    console.log('🍎 Processing purchase:', JSON.stringify({
      productId: purchase.productId,
      transactionId: txId,
      hasPurchaseToken: !!purchase.purchaseToken,
      purchaseState: purchase.purchaseState,
    }));

    // v15 StoreKit 2: purchaseToken is the only receipt field (no transactionReceipt)
    let receipt = purchase.purchaseToken || null;
    if (!receipt) {
      try {
        console.log('🍎 No purchaseToken, trying getReceiptIOS()...');
        receipt = await getReceiptIOS();
        console.log('🍎 getReceiptIOS length:', receipt?.length || 0);
      } catch (e) {
        console.warn('🍎 getReceiptIOS failed:', e.message);
      }
    }

    const token = userTokenRef.current;
    if (!token) {
      console.error('🍎 No user token for verification — user may not be logged in');
      Alert.alert('Error', 'Please log in and try again.');
      processedTransactionsRef.current.delete(txId);
      return;
    }

    try {
      console.log('🍎 Sending verification to server...');
      const verifyResponse = await fetch(`${API_BASE}/payment/verify-apple`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiptData: receipt || '',
          productId: purchase.productId,
          transactionId: txId,
        }),
      });

      const verifyData = await verifyResponse.json();
      console.log('🍎 Server verification response:', verifyData);

      if (verifyData.success) {
        try {
          await finishTransaction({ purchase, isConsumable: true });
          console.log('🍎 Transaction finished with Apple');
        } catch (finishErr) {
          console.warn('🍎 finishTransaction error (non-fatal):', finishErr.message);
        }

        // Reload credit balance
        try {
          const creditsResponse = await fetch(`${API_BASE}/user/credits`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (creditsResponse.ok) {
            const creditsData = await creditsResponse.json();
            if (creditsData.success) {
              setCreditBalance(creditsData.balance || 0);
            }
          }
        } catch (e) {
          console.log('🍎 Failed to reload credits (non-fatal)');
        }

        setScreen('');
        setTimeout(() => {
          Alert.alert(
            '🎉 Purchase Successful!',
            `${verifyData.creditsAdded} credits have been added to your account!\n\nNew Balance: ${verifyData.credits} credits`,
            [{ text: 'Awesome!', onPress: () => setScreen('dashboard') }]
          );
        }, 100);
      } else {
        try {
          await finishTransaction({ purchase, isConsumable: true });
        } catch (e) { /* ignore */ }
        Alert.alert('Purchase Error', verifyData.error || 'Failed to verify purchase. Please contact support.');
      }
    } catch (error) {
      console.error('🍎 Server verification network error:', error);
      Alert.alert(
        'Verification Pending',
        'Purchase received! Credits will be added shortly.',
        [{ text: 'OK', onPress: () => setScreen('dashboard') }]
      );
    }
  };

  // Initialize Apple IAP connection (iOS only)
  useEffect(() => {
    if (Platform.OS !== 'ios' || isExpoGo || !nativeIapAvailable) return;

    let mounted = true;

    const initIAP = async () => {
      try {
        console.log('🍎 Initializing Apple IAP connection...');
        const result = await initConnection();
        console.log('🍎 IAP connection result:', result);
        if (mounted) setIapConnected(true);

        // Register listeners AFTER initConnection() so Nitro runtime is ready
        console.log('🍎 Registering purchase listeners...');
        purchaseUpdateSubscription.current = purchaseUpdatedListener(async (purchase) => {
          console.log('🍎 purchaseUpdatedListener fired:', purchase.productId, purchase.transactionId || purchase.id);
          await verifyAndCreditApplePurchase(purchase);
        });

        purchaseErrorSubscription.current = purchaseErrorListener((error) => {
          console.warn('🍎 Purchase error:', error);
          if (error.code !== 'E_USER_CANCELLED') {
            Alert.alert('Purchase Error', error.message || 'Something went wrong with the purchase.');
          }
        });
        console.log('🍎 Purchase listeners registered successfully');

        // Fetch products from App Store
        const products = await fetchProducts({ skus: IAP_PRODUCT_IDS });
        console.log('🍎 IAP products fetched:', products.length, products.map(p => p.id));
        if (mounted) setIapProducts(products);

        // Process any unfinished purchases from previous sessions
        try {
          const available = await getAvailablePurchases({ alsoPublishToEventListenerIOS: false });
          console.log('🍎 Unfinished purchases found:', available?.length || 0);
          if (available && available.length > 0) {
            for (const p of available) {
              await verifyAndCreditApplePurchase(p);
            }
          }
        } catch (e) {
          console.log('🍎 getAvailablePurchases error (non-fatal):', e.message);
        }
      } catch (error) {
        console.warn('🍎 IAP init error:', error.message);
      }
    };

    initIAP();

    return () => {
      mounted = false;
      if (purchaseUpdateSubscription.current) {
        purchaseUpdateSubscription.current.remove();
        purchaseUpdateSubscription.current = null;
      }
      if (purchaseErrorSubscription.current) {
        purchaseErrorSubscription.current.remove();
        purchaseErrorSubscription.current = null;
      }
      // Do NOT call endConnection() — keep IAP connection alive to avoid race conditions
      // (matches react-native-iap v15 useIAP hook pattern)
    };
  }, [user?.token]);
  
  // Stat tile flip animation state
  const flipAnimSent = useRef(new Animated.Value(0)).current;
  const flipAnimGenerated = useRef(new Animated.Value(0)).current;
  const flipAnimPending = useRef(new Animated.Value(0)).current;
  const flipAnimReply = useRef(new Animated.Value(0)).current;
  
  // Recipient card flip animation state (one for each recipient)
  const recipientFlipAnims = useRef({}).current;
  
  // Initialize flip animations for each recipient
  const getRecipientFlipAnim = (index) => {
    if (!recipientFlipAnims[index]) {
      recipientFlipAnims[index] = new Animated.Value(0);
    }
    return recipientFlipAnims[index];
  };
  
  // Reply date picker state
  const [showReplyDatePicker, setShowReplyDatePicker] = useState(false);
  const [selectedReplyDate, setSelectedReplyDate] = useState(new Date());
  const selectedReplyDateRef = useRef(new Date());
  const [replyAppId, setReplyAppId] = useState(null);
  const [isCheckingReplies, setIsCheckingReplies] = useState(false);
  
  // Review date picker state
  const [selectedReviewDate, setSelectedReviewDate] = useState(new Date());
  const selectedReviewDateRef = useRef(new Date());
  
  // Notification state
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsTotalCount, setNotificationsTotalCount] = useState(0);
  const [notificationsReadCount, setNotificationsReadCount] = useState(0);
  const [notificationsHasMore, setNotificationsHasMore] = useState(false);
  const [notificationsLoadingMore, setNotificationsLoadingMore] = useState(false);
  const notificationsPageRef = useRef(0); // current loaded offset (in items)
  const NOTIF_PAGE_SIZE = 50;
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [notificationFilter, setNotificationFilter] = useState('all'); // all, unread, read
  const lastNotificationUpdateRef = useRef(null); // Track when notifications were last modified locally
  
  // Validation functions
  const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const isValidURL = (url) => {
    try {
      // Auto-accept domain-like strings (e.g. "xyz.com", "abc.co.uk")
      const urlToTest = url.match(/^https?:\/\//) ? url : `https://${url}`;
      new URL(urlToTest);
      return true;
    } catch {
      return false;
    }
  };

  // Flip tile animation handler
  const handleTileFlip = (animValue) => {
    // Check current value and toggle
    const currentValue = animValue._value;
    const toValue = currentValue >= 90 ? 0 : 180;
    
    Animated.spring(animValue, {
      toValue,
      friction: 8,
      tension: 10,
      useNativeDriver: true,
    }).start();
  };
  
  // Flip recipient card handler
  const handleRecipientFlip = (index) => {
    const flipAnim = getRecipientFlipAnim(index);
    const currentValue = flipAnim._value;
    const toValue = currentValue >= 90 ? 0 : 180;
    
    Animated.spring(flipAnim, {
      toValue,
      friction: 8,
      tension: 10,
      useNativeDriver: true,
    }).start();
  };

  // Reset all flipped tiles back to front
  const resetAllFlips = () => {
    [flipAnimSent, flipAnimGenerated, flipAnimPending, flipAnimReply].forEach(animValue => {
      if (animValue._value > 0) {
        Animated.spring(animValue, {
          toValue: 0,
          friction: 8,
          tension: 10,
          useNativeDriver: true,
        }).start();
      }
    });
  };

  const addRecipient = () => {
    const newId = Math.max(...recipients.map(r => r.id), -1) + 1;
    setRecipients([{ id: newId, email: '', website: '', position: '', error: '' }, ...recipients]);
  };

  const removeRecipient = (id) => {
    if (recipients.length > 1) {
      setRecipients(recipients.filter(r => r.id !== id));
    }
  };

  const updateRecipient = (id, field, value) => {
    setRecipients(recipients.map(r => {
      if (r.id === id) {
        let error = '';
        
        if (field === 'email' && value && !isValidEmail(value)) {
          error = 'Invalid email format';
        } else if (field === 'website' && value && !isValidURL(value)) {
          error = 'Invalid URL (e.g. example.com)';
        }
        
        return { ...r, [field]: value, error };
      }
      return r;
    }));
  };

  const validateAllRecipients = () => {
    let allValid = true;
    const updatedRecipients = recipients.map(r => {
      let error = '';
      if (!r.email) error = 'Email is required';
      else if (!isValidEmail(r.email)) error = 'Invalid email';
      else if (!r.website) error = 'Website is required';
      else if (!isValidURL(r.website)) error = 'Invalid URL';
      
      if (error) allValid = false;
      return { ...r, error };
    });
    setRecipients(updatedRecipients);
    return allValid;
  };

  const handleSendNow = () => {
    if (validateAllRecipients()) {
      Alert.alert('Success', 'Applications sent! (Demo mode)');
    }
  };

  const handleReview = (tabIndex = 0) => {
    // Navigate to Letters page without hard validation —
    // cards with missing fields will show inline errors there.
    // (validateAllRecipients was blocking navigation when any card was incomplete,
    //  e.g. a card added from the Job Hub bridge with only website+position.)
    setCurrentReviewTab(typeof tabIndex === 'number' ? tabIndex : 0);
    setScreen('review');
  };

  // Restore purchases handler (Apple IAP)
  const handleRestorePurchases = async () => {
    if (Platform.OS !== 'ios') return;
    setRestoringPurchases(true);
    try {
      const available = await getAvailablePurchases({ alsoPublishToEventListenerIOS: false });
      console.log('🍎 Restore: found purchases:', available?.length || 0);
      if (available && available.length > 0) {
        let restored = 0;
        for (const p of available) {
          const result = await verifyAndCreditApplePurchase(p);
          if (result) restored++;
        }
        Alert.alert('Restore Complete', restored > 0 ? `Successfully restored ${restored} purchase(s). Your credits have been updated.` : 'All purchases were already applied to your account.');
      } else {
        Alert.alert('No Purchases Found', 'There are no previous purchases to restore.');
      }
    } catch (error) {
      console.log('🍎 Restore error:', error.message);
      Alert.alert('Restore Failed', 'Unable to restore purchases. Please try again later.');
    } finally {
      setRestoringPurchases(false);
    }
  };

  // Handle package purchase - routes to Apple IAP on iOS, Razorpay on Android
  const handleBuyPackage = async (pkg) => {
    console.log('💳 Buy package clicked:', pkg);

    if (Platform.OS === 'ios') {
      // ===== APPLE IN-APP PURCHASE (iOS) =====
      return handleBuyPackageApple(pkg);
    } else {
      // ===== RAZORPAY (Android) =====
      return handleBuyPackageRazorpay(pkg);
    }
  };

  // Apple IAP purchase handler (iOS only)
  const handleBuyPackageApple = async (pkg) => {
    if (isExpoGo || !nativeIapAvailable) {
      Alert.alert(
        'Not Available in Expo Go',
        'Apple In-App Purchases require a development or production build. Please use TestFlight or a dev client build.'
      );
      return;
    }

    try {
      // Map plan name to Apple product ID
      const nameToProductId = {
        'Starter': 'com.cvapplyr.mobile.starter',
        'Professional': 'com.cvapplyr.mobile.professional',
        'Premium': 'com.cvapplyr.mobile.premium',
        'Enterprise': 'com.cvapplyr.mobile.enterprise',
      };

      const productId = nameToProductId[pkg.name];
      if (!productId) {
        Alert.alert('Error', 'This package is not available for purchase on iOS.');
        return;
      }

      if (!iapConnected) {
        Alert.alert('Store Unavailable', 'Unable to connect to the App Store. Please try again.');
        return;
      }

      console.log('🍎 Requesting Apple IAP purchase for:', productId);
      // v15 API: requestPurchase may return the Purchase directly (StoreKit 2)
      // The listener also fires — processedTransactionsRef guards against double-processing
      const purchaseResult = await requestPurchase({ request: { apple: { sku: productId } }, type: 'in-app' });
      console.log('🍎 requestPurchase returned:', purchaseResult ? 'purchase object' : 'null/undefined');

      // Handle purchase returned directly from requestPurchase (v15 StoreKit 2 path)
      if (purchaseResult) {
        const purchases = Array.isArray(purchaseResult) ? purchaseResult : [purchaseResult];
        for (const purchase of purchases) {
          if (purchase && purchase.productId) {
            await verifyAndCreditApplePurchase(purchase);
          }
        }
      }
    } catch (error) {
      console.error('🍎 IAP purchase error:', error);
      if (error.code === 'E_USER_CANCELLED') {
        console.log('Purchase cancelled by user');
        return;
      }
      Alert.alert(
        'Purchase Error',
        error.message || 'Failed to initiate purchase. Please try again.',
        [{ text: 'OK' }]
      );
    }
  };

  // Razorpay payment handler (Android only, kept for reference)
  /* --- RAZORPAY COMMENTED OUT FOR iOS (Apple IAP used instead) ---
  const handleBuyPackageRazorpay_iOS = async (pkg) => {
    // This was the original Razorpay flow for iOS - now replaced by Apple IAP
    // Keeping for reference in case needed for Android
  };
  --- END RAZORPAY iOS COMMENT --- */
  
  const handleBuyPackageRazorpay = async (pkg) => {
    if (!RazorpayCheckout || typeof RazorpayCheckout.open !== 'function') {
      Alert.alert(
        'Not Available in Expo Go',
        'Razorpay native checkout requires a development or production build. Please use Android build or TestFlight/production app.'
      );
      return;
    }

    try {
      // Create Razorpay order
      console.log('📞 Calling create-order API...');
      const orderResponse = await fetch(`${API_BASE}/payment/create-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user?.token || ''}`
        },
        body: JSON.stringify({
          packageId: pkg.id,
          amount: parseFloat(pkg.amount)
        })
      });

      console.log('📦 Order response status:', orderResponse.status);
      const orderData = await orderResponse.json();
      console.log('📦 Order data:', orderData);

      if (!orderResponse.ok) {
        throw new Error(orderData.error || 'Failed to create order');
      }

      // Use prefill data from backend (fetched from database)
      const prefillData = orderData.prefill || {};
      console.log('👤 Prefill data from backend:', prefillData);

      // Open Razorpay native checkout
      const options = {
        description: pkg.name || 'Credit Package',
        currency: orderData.currency,
        key: orderData.keyId,
        amount: orderData.amount, // Already in paise from server
        name: 'CVApplyr',
        order_id: orderData.orderId,
        prefill: {
          email: prefillData.email || '',
          contact: prefillData.contact || '',
          name: prefillData.name || ''
        },
        theme: { color: '#667eea' }
      };

      console.log('📲 Opening Razorpay native checkout, amount (paise):', orderData.amount);
      
      const paymentData = await RazorpayCheckout.open(options);
      console.log('✅ Payment successful:', paymentData);

      // Verify payment with backend
      try {
        const verifyResponse = await fetch(`${API_BASE}/payment/verify`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            razorpay_order_id: paymentData.razorpay_order_id,
            razorpay_payment_id: paymentData.razorpay_payment_id,
            razorpay_signature: paymentData.razorpay_signature
          })
        });

        const verifyData = await verifyResponse.json();
        console.log('✅ Payment verification response:', verifyData);

        if (verifyData.success) {
          // Reload credits
          try {
            const creditsResponse = await fetch(`${API_BASE}/user/credits`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${user.token}`,
                'Content-Type': 'application/json',
              }
            });
            if (creditsResponse.ok) {
              const creditsData = await creditsResponse.json();
              if (creditsData.success) {
                setCreditBalance(creditsData.balance || 0);
              }
            }
          } catch (reloadError) {
            console.log('Failed to reload credits, using verification response');
            setCreditBalance(verifyData.credits);
          }

          setScreen('');
          setTimeout(() => {
            Alert.alert(
              '🎉 Payment Successful!',
              `${verifyData.creditsAdded} credits have been added to your account!\n\nNew Balance: ${verifyData.credits} credits`,
              [{ text: 'Awesome!', onPress: () => setScreen('dashboard') }]
            );
          }, 100);
        } else {
          throw new Error(verifyData.error || 'Verification failed');
        }
      } catch (verifyError) {
        console.error('❌ Payment verification error:', verifyError);
        Alert.alert(
          'Verification Pending',
          'Payment received! Credits will be added shortly. Please check your balance in a few minutes.',
          [{ text: 'OK', onPress: () => setScreen('dashboard') }]
        );
      }
    } catch (error) {
      console.error('❌ Payment error:', error);
      // Razorpay returns error code 0 when user cancels
      if (error.code === 0 || error.description === 'Payment cancelled') {
        console.log('Payment cancelled by user');
        return;
      }
      Alert.alert(
        'Payment Error',
        error.description || error.message || 'Failed to initiate payment. Please try again.',
        [{ text: 'OK' }]
      );
    }
  };

  // Fetch profile data from backend
  const fetchProfileData = async () => {
    try {
      if (user?.id || user?.email) {
        const response = await fetch(`${API_BASE}/users/profile`, {
          headers: {
            'Authorization': `Bearer ${user?.token || ''}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          setProfileData({
            fullName: data.fullName || user?.fullName || user?.name || '',
            email: data.email || user?.email || '',
            phone: data.phone || '',
            address: data.address || '',
            dateOfBirth: data.dateOfBirth || '',
            gender: data.gender || '',
            profileImage: data.profileImage || user?.profileImage || null,
            resume: data.resume || null,
            signature: data.signature || null,
            createdAt: new Date(data.createdAt || user?.createdAt || Date.now()),
          });
        }
      }
    } catch (error) {
      console.log('Error fetching profile:', error);
    }
  };

  // Save profile changes to database
  const saveProfileChanges = async () => {
    try {
      if (!user?.token) {
        Alert.alert('Error', 'No authentication token available');
        return;
      }

      const response = await fetch(`${API_BASE}/users/profile/update`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fullName: profileData.fullName,
          email: profileData.email,
          phone: profileData.phone,
          address: profileData.address,
          dateOfBirth: profileData.dateOfBirth,
          gender: profileData.gender,
        })
      });

      console.log('Save profile response status:', response.status);
      const responseText = await response.text();
      console.log('Save profile response:', responseText);

      if (response.ok) {
        Alert.alert('Success', 'Profile saved successfully');
        setIsEditingProfile(false);
      } else {
        Alert.alert('Error', `Failed to save profile: ${response.status}`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to save profile: ${error.message}`);
      console.log('Save error:', error);
    }
  };

  // Pick and upload profile image
  const pickProfileImage = async () => {
    Alert.alert(
      'Choose Profile Image',
      'Select an option',
      [
        {
          text: 'Cancel',
          style: 'cancel'
        },
        {
          text: 'Choose from Files',
          onPress: async () => {
            try {
              const result = await DocumentPicker.getDocumentAsync({
                type: 'image/*',
              });

              if (result.assets && result.assets.length > 0) {
                await uploadProfileImage(result.assets[0]);
              }
            } catch (error) {
              console.log('Error:', error);
            }
          }
        },
        {
          text: 'Choose from Photos',
          onPress: async () => {
            try {
              const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.8,
              });

              if (!result.canceled) {
                await uploadProfileImage(result.assets[0]);
              }
            } catch (error) {
              console.log('Error:', error);
            }
          }
        }
      ]
    );
  };

  // Upload profile image
  const uploadProfileImage = async (file) => {
    try {
      if (!user?.token) {
        Alert.alert('Error', 'No authentication token available');
        console.log('User token missing:', user);
        return;
      }

      const formData = new FormData();
      formData.append('profileImage', {
        uri: file.uri,
        type: 'image/jpeg',
        name: file.name || 'profile.jpg',
      });

      console.log('Uploading profile image with token:', user.token.substring(0, 20) + '...');

      const response = await fetch(`${API_BASE}/users/profile/image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
        },
        body: formData,
      });

      console.log('Upload response status:', response.status);
      const responseText = await response.text();
      console.log('Upload response:', responseText);

      if (response.ok) {
        Alert.alert('Success', 'Profile image uploaded successfully');
        setProfileData({ ...profileData, profileImage: file.uri });
      } else {
        Alert.alert('Error', `Failed to upload profile image: ${response.status}`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to upload profile image: ${error.message}`);
      console.log('Upload error:', error);
    }
  };

  // Pick and upload resume
  const pickResume = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
      });

      if (result.assets && result.assets.length > 0) {
        await uploadResume(result.assets[0]);
      }
    } catch (error) {
      console.log('Error picking resume:', error);
      if (error.message !== 'User cancelled document picker') {
        Alert.alert('Error', 'Failed to pick resume. Please try again.');
      }
    }
  };

  // Upload resume
  const uploadResume = async (file) => {
    try {
      if (!user?.token) {
        Alert.alert('Error', 'No authentication token available');
        return;
      }

      const formData = new FormData();
      formData.append('resume', {
        uri: file.uri,
        type: 'application/pdf',
        name: file.name,
      });

      console.log('Uploading resume with token:', user.token.substring(0, 20) + '...');

      const response = await fetch(`${API_BASE}/users/profile/resume`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
        },
        body: formData,
      });

      console.log('Resume upload response status:', response.status);
      const responseText = await response.text();
      console.log('Resume upload response:', responseText);

      if (response.ok) {
        Alert.alert('Success', 'Resume uploaded successfully');
        setProfileData({ ...profileData, resume: file.name });
      } else {
        Alert.alert('Error', `Failed to upload resume: ${response.status}`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to upload resume: ${error.message}`);
      console.log('Error:', error);
    }
  };

  // Pick and upload signature
  const pickSignature = async () => {
    Alert.alert(
      'Choose Signature',
      'Select an option',
      [
        {
          text: 'Cancel',
          style: 'cancel'
        },
        {
          text: 'Choose from Files',
          onPress: async () => {
            try {
              const result = await DocumentPicker.getDocumentAsync({
                type: 'image/*',
              });

              if (result.assets && result.assets.length > 0) {
                await uploadSignature(result.assets[0]);
              }
            } catch (error) {
              console.log('Error:', error);
            }
          }
        },
        {
          text: 'Choose from Photos',
          onPress: async () => {
            try {
              const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                quality: 0.8,
              });

              if (!result.canceled) {
                await uploadSignature(result.assets[0]);
              }
            } catch (error) {
              console.log('Error:', error);
            }
          }
        }
      ]
    );
  };

  // Upload signature
  const uploadSignature = async (file) => {
    try {
      if (!user?.token) {
        Alert.alert('Error', 'No authentication token available');
        return;
      }

      const formData = new FormData();
      formData.append('signature', {
        uri: file.uri,
        type: 'image/png',
        name: file.name || 'signature.png',
      });

      console.log('Uploading signature with token:', user.token.substring(0, 20) + '...');

      const response = await fetch(`${API_BASE}/users/profile/signature`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
        },
        body: formData,
      });

      console.log('Signature upload response status:', response.status);
      const responseText = await response.text();
      console.log('Signature upload response:', responseText);

      if (response.ok) {
        Alert.alert('Success', 'Signature uploaded successfully');
        setProfileData({ ...profileData, signature: file.uri });
      } else {
        Alert.alert('Error', `Failed to upload signature: ${response.status}`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to upload signature: ${error.message}`);
      console.log('Error:', error);
    }
  };

  // ── Signature Generator ──────────────────────────────────────────────────────
  // Builds the WebView HTML that lets the user pick a cursive style and export PNG
  const buildSignatureGeneratorHTML = (name) => {
    const safeName = name.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const jsonName = JSON.stringify(name);
    return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Dancing+Script:wght@700&family=Pacifico&family=Satisfy&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
  body{background:#E5EAF3;font-family:-apple-system,sans-serif;padding:16px;min-height:100vh;}
  h3{font-size:11px;font-weight:700;color:#8896B0;letter-spacing:1.2px;text-align:center;margin-bottom:14px;text-transform:uppercase;}
  .styles{display:flex;flex-direction:column;gap:10px;}
  .opt{background:#fff;border:2px solid rgba(11,15,34,0.08);border-radius:16px;padding:14px 20px;cursor:pointer;display:flex;align-items:center;justify-content:center;min-height:72px;transition:border-color .15s,background .15s;}
  .opt.sel{border-color:#4F8DFF;background:#F0F7FF;}
  .sig{color:#0B0F22;line-height:1.1;display:block;text-align:center;}
  .s0{font-family:'Great Vibes',cursive;font-size:46px;}
  .s1{font-family:'Dancing Script',cursive;font-size:40px;font-weight:700;}
  .s2{font-family:'Satisfy',cursive;font-size:38px;}
  .s3{font-family:'Pacifico',cursive;font-size:34px;}
  .note{font-size:11px;color:#8896B0;text-align:center;margin-top:6px;}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#4F8DFF,#7C6BFF);color:#fff;border:none;border-radius:14px;padding:15px;font-size:15px;font-weight:700;cursor:pointer;width:100%;margin-top:16px;letter-spacing:0.3px;}
  .btn:active{opacity:0.85;}
  .spinner{display:none;text-align:center;padding:12px;color:#5B6B8A;font-size:13px;}
  canvas{display:none;}
</style>
</head>
<body>
<h3>Choose your signature style</h3>
<div class="styles">
  <div class="opt sel" id="o0" onclick="pick(0)"><span class="sig s0">${safeName}</span></div>
  <div class="opt"     id="o1" onclick="pick(1)"><span class="sig s1">${safeName}</span></div>
  <div class="opt"     id="o2" onclick="pick(2)"><span class="sig s2">${safeName}</span></div>
  <div class="opt"     id="o3" onclick="pick(3)"><span class="sig s3">${safeName}</span></div>
</div>
<p class="note">Tap a style, then hit Use This Signature</p>
<canvas id="c"></canvas>
<button class="btn" onclick="exportSig()">✓ &nbsp;Use This Signature</button>
<div class="spinner" id="sp">Generating…</div>

<script>
var sel=0;
var fonts=['Great Vibes','Dancing Script','Satisfy','Pacifico'];
var sizes=[92,80,76,68];
var weights=['normal','bold','normal','normal'];

function pick(i){
  for(var j=0;j<4;j++) document.getElementById('o'+j).className='opt'+(j===i?' sel':'');
  sel=i;
}

function exportSig(){
  document.getElementById('sp').style.display='block';
  document.fonts.ready.then(function(){
    var name=${jsonName};
    var f=fonts[sel], sz=sizes[sel], w=weights[sel];
    var cvs=document.getElementById('c');
    var ctx=cvs.getContext('2d');
    var scale=2; // retina
    ctx.font=w+' '+sz+'px "'+f+'"';
    var tw=ctx.measureText(name).width;
    var pw=Math.ceil(tw+80), ph=Math.ceil(sz*1.6+20);
    cvs.width=pw*scale; cvs.height=ph*scale;
    ctx.scale(scale,scale);
    ctx.clearRect(0,0,pw,ph);
    ctx.font=w+' '+sz+'px "'+f+'"';
    ctx.fillStyle='#0B0F22';
    ctx.textBaseline='middle';
    ctx.fillText(name,40,ph/2);
    var dataURL=cvs.toDataURL('image/png');
    document.getElementById('sp').style.display='none';
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'sig',data:dataURL}));
  });
}
</script>
</body>
</html>`;
  };

  // Called when the WebView posts back the base64 PNG of the chosen signature
  const handleSignatureWebViewMessage = async (event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type !== 'sig' || !msg.data) return;

      setSignatureGenerating(true);
      setShowSignatureGenerator(false);

      // Strip the data: URL prefix and write to a temp file
      const base64 = msg.data.replace(/^data:image\/png;base64,/, '');
      const tempPath = `${cacheDirectory}generated_sig_${Date.now()}.png`;
      await writeAsStringAsync(tempPath, base64, { encoding: EncodingType.Base64 });

      // Reuse the existing uploadSignature flow
      await uploadSignature({ uri: tempPath, type: 'image/png', name: 'signature.png' });
    } catch (err) {
      Alert.alert('Error', 'Could not generate signature: ' + err.message);
    } finally {
      setSignatureGenerating(false);
    }
  };

  // Fetch profile when screen changes to profile OR when user is set (session restore)
  useEffect(() => {
    if (screen === 'profile' || (user?.token && screen === 'dashboard')) {
      fetchProfileData();
    }
  }, [screen, user?.token]);

  // Handle password change
  const isOAuthUser = user?.oauth_provider === 'google' || user?.oauth_provider === 'microsoft' || user?.oauth_provider === 'apple';
  const handleChangePassword = async () => {
    if ((!isOAuthUser && !currentPassword) || !newPassword || !confirmPassword) {
      Alert.alert('Error', 'Please fill in all password fields');
      return;
    }

    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      Alert.alert('Error', 'New password must be at least 6 characters');
      return;
    }

    try {
      const response = await fetch(`${API_BASE.replace('/api', '')}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(isOAuthUser ? {} : { currentPassword }),
          newPassword,
        })
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert('Error', data.error || 'Failed to change password');
        return;
      }

      Alert.alert('Success', 'Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowChangePassword(false);
    } catch (error) {
      Alert.alert('Error', error.message);
    }
  };

  // Handle privacy settings update
  const handleUpdatePrivacySettings = async () => {
    try {
      const response = await fetch(`${API_BASE.replace('/api', '')}/api/users/privacy-settings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(privacySettings)
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert('Error', data.error || 'Failed to update privacy settings');
        return;
      }

      Alert.alert('Success', 'Privacy settings updated successfully');
      setShowPrivacySettings(false);
    } catch (error) {
      Alert.alert('Error', error.message);
    }
  };

  // Handle delete account
  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') {
      Alert.alert('Error', 'Please type DELETE to confirm account deletion');
      return;
    }

    try {
      const response = await fetch(`${API_BASE.replace('/api', '')}/api/account/delete`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmText: deleteConfirmText
        })
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert('Error', data.error || 'Failed to delete account');
        return;
      }

      Alert.alert('Account Deleted', 'Your account has been permanently deleted', [
        {
          text: 'OK',
          onPress: async () => {
            // Clear all local data
            await AsyncStorage.clear();
            await SecureStore.deleteItemAsync('userSession').catch(() => {});
            setUser(null);
            setShowDeleteAccount(false);
            setDeleteConfirmText('');
            setScreen('login');
          }
        }
      ]);
    } catch (error) {
      Alert.alert('Error', error.message);
    }
  };

  // Cancel ongoing operation
  const cancelOperation = () => {
    console.log('🛑 Cancel button pressed');
    
    // Set cancellation flag
    isCancelledRef.current = true;
    
    // Abort ongoing fetch requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      console.log('🛑 Fetch request aborted');
    }
    
    // Reset all loading states
    setReviewGeneratingAll(false);
    setReviewSendingAll(false);
    setReviewGeneratingAndSendingAll(false);
    setReviewLoading(false);
    setReviewDownloading(false);
    setReviewGeneratingIndex(null);
    
    Alert.alert('Cancelled', 'Operation has been cancelled');
  };

  // ADMIN PANEL FUNCTIONS
  const fetchAdminPackages = async () => {
    try {
      setLoadingAdminPackages(true);
      const response = await fetch(`${API_BASE}/admin/packages`, {
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });
      const data = await response.json();
      if (data.packages) {
        setAdminPackages(data.packages);
      }
    } catch (error) {
      console.error('Error fetching admin packages:', error);
      Alert.alert('Error', 'Failed to load packages');
    } finally {
      setLoadingAdminPackages(false);
    }
  };

  const createPackage = async () => {
    if (!packageFormData.name || !packageFormData.amount || !packageFormData.credits || !packageFormData.validity_days) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/admin/packages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: packageFormData.name,
          amount: parseFloat(packageFormData.amount),
          credits: parseInt(packageFormData.credits),
          validity_days: parseInt(packageFormData.validity_days),
          description: packageFormData.description,
          is_popular: packageFormData.is_popular ? 1 : 0,
          display_order: parseInt(packageFormData.display_order || 0)
        })
      });

      const data = await response.json();
      if (response.ok) {
        Alert.alert('Success', 'Package created successfully');
        setShowPackageForm(false);
        fetchAdminPackages();
      } else {
        Alert.alert('Error', data.error || 'Failed to create package');
      }
    } catch (error) {
      console.error('Error creating package:', error);
      Alert.alert('Error', 'Failed to create package');
    }
  };

  const updatePackage = async () => {
    if (!packageFormData.name || !packageFormData.amount || !packageFormData.credits || !packageFormData.validity_days) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/admin/packages/${editingPackage.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: packageFormData.name,
          amount: parseFloat(packageFormData.amount),
          credits: parseInt(packageFormData.credits),
          validity_days: parseInt(packageFormData.validity_days),
          description: packageFormData.description,
          is_popular: packageFormData.is_popular ? 1 : 0,
          display_order: parseInt(packageFormData.display_order || 0)
        })
      });

      const data = await response.json();
      if (response.ok) {
        Alert.alert('Success', 'Package updated successfully');
        setShowPackageForm(false);
        fetchAdminPackages();
      } else {
        Alert.alert('Error', data.error || 'Failed to update package');
      }
    } catch (error) {
      console.error('Error updating package:', error);
      Alert.alert('Error', 'Failed to update package');
    }
  };

  const deletePackage = async (packageId) => {
    Alert.alert(
      'Confirm Delete',
      'Are you sure you want to delete this package?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await fetch(`${API_BASE}/admin/packages/${packageId}`, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${user.token}`
                }
              });

              if (response.ok) {
                Alert.alert('Success', 'Package deleted successfully');
                fetchAdminPackages();
              } else {
                const data = await response.json();
                Alert.alert('Error', data.error || 'Failed to delete package');
              }
            } catch (error) {
              console.error('Error deleting package:', error);
              Alert.alert('Error', 'Failed to delete package');
            }
          }
        }
      ]
    );
  };

  const togglePackageStatus = async (packageId, currentStatus) => {
    try {
      const response = await fetch(`${API_BASE}/admin/packages/${packageId}/toggle-active`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });

      if (response.ok) {
        Alert.alert('Success', `Package ${currentStatus === 1 ? 'deactivated' : 'activated'} successfully`);
        fetchAdminPackages();
      } else {
        const data = await response.json();
        Alert.alert('Error', data.error || 'Failed to toggle package status');
      }
    } catch (error) {
      console.error('Error toggling package status:', error);
      Alert.alert('Error', 'Failed to toggle package status');
    }
  };

  // Load admin packages when admin screen is accessed
  useEffect(() => {
    if (screen === 'admin' && isAdmin) {
      fetchAdminPackages();
    }
  }, [screen]);

  // REVIEW SCREEN HANDLERS
  // Progressive loading functions
  const startProgressiveLoading = (companyUrl) => {
    let companyName = 'the company';
    try {
      const urlStr = companyUrl && companyUrl.match(/^https?:\/\//) ? companyUrl : `https://${companyUrl}`;
      const hostname = new URL(urlStr).hostname.replace('www.', '');
      const hostParts = hostname.split('.');
      const genericSubs = ['career', 'careers', 'jobs', 'job', 'hiring', 'recruit', 'talent', 'join', 'work', 'apply', 'portal', 'app', 'hr', 'people', 'team'];
      let name = hostParts[0];
      if (genericSubs.includes(name) && hostParts.length >= 3) {
        name = hostParts[1];
      }
      companyName = name.charAt(0).toUpperCase() + name.slice(1);
    } catch { }
    const steps = [
      { time: 0, message: '🔍 Fetching your profile details...', progress: 0 },
      { time: 3000, message: `🌐 Researching about ${companyName}...`, progress: 15 },
      { time: 8000, message: '🏢 Analyzing company culture and requirements...', progress: 30 },
      { time: 15000, message: '🤝 Matching your skills with job requirements...', progress: 50 },
      { time: 22000, message: '✍️ Crafting your personalized cover letter...', progress: 70 },
      { time: 30000, message: '✨ Adding final touches and formatting...', progress: 85 },
      { time: 40000, message: '⏳ Almost done, finalizing content...', progress: 95 }
    ];

    // Clear any existing interval
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
    }

    // Reset animation value
    progressAnimValue.setValue(0);

    // Set initial message and progress
    setProgressiveLoadingMessage(steps[0].message);
    setProgressiveLoadingProgress(0);
    console.log('📊', steps[0].message);

    let currentStepIndex = 0;
    const startTime = Date.now();

    progressIntervalRef.current = setInterval(() => {
      if (isCancelledRef.current) {
        clearInterval(progressIntervalRef.current);
        return;
      }

      const elapsedTime = Date.now() - startTime;
      
      // Find the current step based on elapsed time
      let newStepIndex = 0;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (elapsedTime >= steps[i].time) {
          newStepIndex = i;
          break;
        }
      }

      // Update message only when we enter a new step (prevents flickering)
      if (newStepIndex !== currentStepIndex) {
        currentStepIndex = newStepIndex;
        setProgressiveLoadingMessage(steps[currentStepIndex].message);
        console.log('📊', steps[currentStepIndex].message);
      }

      // Calculate smooth progress within current step
      const currentStep = steps[currentStepIndex];
      const nextStep = steps[currentStepIndex + 1];
      
      if (nextStep) {
        // We're in a step that has a next step - smoothly transition
        const stepStartTime = currentStep.time;
        const stepEndTime = nextStep.time;
        const stepDuration = stepEndTime - stepStartTime;
        const timeIntoStep = elapsedTime - stepStartTime;
        const stepProgress = Math.min(timeIntoStep / stepDuration, 1);
        
        // Interpolate between current and next progress
        const startProgress = currentStep.progress;
        const endProgress = nextStep.progress;
        const progressRange = endProgress - startProgress;
        const smoothProgress = startProgress + (progressRange * stepProgress);
        
        setProgressiveLoadingProgress(Math.floor(smoothProgress));
        
        // Animate to the smooth progress value
        Animated.timing(progressAnimValue, {
          toValue: smoothProgress,
          duration: 100,
          useNativeDriver: false
        }).start();
      } else {
        // We're at the final step - stay at its progress
        setProgressiveLoadingProgress(currentStep.progress);
        Animated.timing(progressAnimValue, {
          toValue: currentStep.progress,
          duration: 100,
          useNativeDriver: false
        }).start();
      }
    }, 100); // Update every 100ms for smooth animation
  };

  const stopProgressiveLoading = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setProgressiveLoadingMessage('');
    setProgressiveLoadingProgress(0);
    progressAnimValue.setValue(0);
  };

  // Validate mandatory profile items before generating/sending
  const validateProfileForGeneration = () => {
    const missing = [];
    if (!profileData?.resume) missing.push('Resume');
    // Photo is OPTIONAL for cover letters — the renderer falls back to initials
    // when none is set, so we no longer block generation on a missing photo.
    if (!profileData?.signature) missing.push('Signature');
    if (!profileData?.fullName) missing.push('Full Name');
    if (!profileData?.email) missing.push('Email');

    if (missing.length > 0) {
      Alert.alert(
        'Profile Incomplete',
        `Please add the following before generating cover letters:\n\n${missing.map(item => `• ${item}`).join('\n')}\n\nGo to your Profile to upload these.`,
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Go to Profile', onPress: () => setScreen('profile') }
        ]
      );
      return false;
    }
    return true;
  };

  const generateCoverLetterForReview = async (recipientIndex, retryCount = 0) => {
    const recipient = recipients[recipientIndex];
    if (!recipient.email || !recipient.website) {
      Alert.alert('Missing Information', 'Email and website are required');
      return;
    }

    // Validate profile on first attempt only (not retries, not bulk calls)
    if (retryCount === 0 && !reviewGeneratingAll && !reviewGeneratingAndSendingAll) {
      if (!validateProfileForGeneration()) return;
    }

    const requestId = `REQ_${Date.now()}_${recipientIndex}`;
    try {
      // Reset cancellation flag for single operations
      if (!reviewGeneratingAll && !reviewGeneratingAndSendingAll) {
        isCancelledRef.current = false;
      }
      
      // Track active request
      requestInProgressRef.current = true;
      
      setReviewGeneratingIndex(recipientIndex);
      
      // Start progressive loading
      startProgressiveLoading(recipient.website);
      
      // Keep the app awake during the request (prevents background suspension)
      await activateKeepAwakeAsync();
      console.log('🔒 Keep-awake activated - app will stay active during request');
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🚀 [${requestId}] Starting cover letter generation for index: ${recipientIndex}`);
      console.log(`   Recipient: ${recipient.email}`);
      
      // Use longer timeout for Gemini AI which can take 30-60 seconds
      const TIMEOUT_MS = 180000; // 3 minutes
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => {
          console.log(`⏱️  [${requestId}] Timeout triggered after ${TIMEOUT_MS / 1000} seconds`);
          reject(new Error(`Request timeout - ${TIMEOUT_MS / 1000} seconds exceeded`));
        }, TIMEOUT_MS)
      );

      // Create new AbortController for this request
      abortControllerRef.current = new AbortController();
      
      console.log(`📤 [${requestId}] Initiating fetch request...`);
      const fetchPromise = fetch(`${API_BASE}/generate-cover-letter-details`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          recipientEmail: recipient.email,
          websiteUrl: recipient.website.match(/^https?:\/\//) ? recipient.website : `https://${recipient.website}`,
          position: recipient.position
        })
      });

      console.log(`⏳ [${requestId}] Waiting for response (may take 30-90 seconds)...`);
      const startTime = Date.now();
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      const elapsedTime = Date.now() - startTime;
      
      console.log(`✅ [${requestId}] Response received in ${elapsedTime}ms`);
      console.log(`   Status: ${response.status}, Ok: ${response.ok}`);
      
      let data;
      
      // ASYNC MODE: Server returned 202 with jobId — switch to polling
      if (response.status === 202) {
        const { jobId } = await response.json();
        console.log(`🔄 [${requestId}] Async job started: ${jobId} — switching to polling`);
        activeJobRef.current = { jobId, type: 'generate', recipientIndex };
        
        data = await pollJobStatus(jobId);
        console.log(`✅ [${requestId}] Async job completed, processing result...`);
        
        // Check if cancelled during polling
        if (isCancelledRef.current) {
          console.log(`🛑 [${requestId}] Operation cancelled during polling`);
          return;
        }
      } else {
      // Check for insufficient credits (402 status)
      if (response.status === 402) {
        console.log(`💳 [${requestId}] Insufficient credits error`);
        const errorData = await response.json();
        Alert.alert(
          'Insufficient Credits',
          errorData.message || `You need credits to generate cover letters. Current balance: ${creditBalance}. Visit the Usage & Credits screen to purchase more.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'View Usage', onPress: () => setScreen('usage') }
          ]
        );
        return;
      }
      
      if (!response.ok) {
        console.log(`❌ [${requestId}] Response not OK: ${response.status}`);
        throw new Error(`Failed with status ${response.status}`);
      }
      
      console.log(`📖 [${requestId}] Reading response body...`);
      const responseText = await response.text();
      console.log(`✅ [${requestId}] Response body read, length: ${responseText.length} bytes`);
      
      console.log(`🔄 [${requestId}] Parsing JSON...`);
      try {
        data = JSON.parse(responseText);
        console.log(`✅ [${requestId}] JSON parsed successfully`);
        console.log(`   Keys in response: ${Object.keys(data).join(', ')}`);
        console.log(`   Cover letter HTML length: ${data.coverLetterHtml?.length || 0} chars`);
      } catch (parseError) {
        console.log(`❌ [${requestId}] JSON parse failed: ${parseError.message}`);
        console.log(`   Response text (first 500 chars): ${responseText.substring(0, 500)}`);
        throw parseError;
      }
      
      // Check if operation was cancelled while waiting for response
      if (isCancelledRef.current) {
        console.log(`🛑 [${requestId}] Operation cancelled - not updating state`);
        return;
      }
      } // end else (sync path)
      
      // Get headquarter address as default - construct properly without duplicates
      const headquarterLocation = data.locations?.find(loc => loc.isHeadquarters) || data.locations?.[0];
      let defaultAddress = '';
      if (headquarterLocation) {
        let address = headquarterLocation.address || '';
        const city = headquarterLocation.city || '';
        const country = headquarterLocation.country || '';
        
        // Check if address is empty or placeholder
        if (!address || address === 'Address not available online') {
          // Construct from city and country if available
          const parts = [];
          if (city && city !== 'Not specified') parts.push(city);
          if (country && country !== 'Not specified') parts.push(country);
          defaultAddress = parts.join(', ') || '';
        } else {
          // Address exists - check if we need to append city/country
          const addressLower = address.toLowerCase();
          const cityLower = city.toLowerCase();
          const countryLower = country.toLowerCase();
          
          // Only add city if it's not already in the address
          const cityInAddress = cityLower && addressLower.includes(cityLower);
          // Only add country if it's not already in the address
          const countryInAddress = countryLower && addressLower.includes(countryLower);
          
          // Start with the address
          defaultAddress = address;
          
          // Append city if valid and not already present
          if (city && city !== 'Not specified' && !cityInAddress) {
            defaultAddress += `, ${city}`;
          }
          
          // Append country if valid and not already present
          if (country && country !== 'Not specified' && !countryInAddress) {
            defaultAddress += `, ${country}`;
          }
        }
      }
      
      console.log(`💾 [${requestId}] Storing in state with address: ${defaultAddress}...`);
      
      // Use functional setState to avoid race conditions when generating in parallel
      // KEY: use recipient.email (stable) — never the array index which shifts when
      // new recipients are prepended and would silently overwrite existing entries.
      let updatedCoverLetters = {};
      setReviewCoverLetters(prev => {
        updatedCoverLetters = {
          ...prev,
          [recipient.email]: {
            ...data,
            coverLetterHtml: data.coverLetterHtml,
            address: defaultAddress,
            date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
            generated: true,
            sent: false,
            storedRecipientEmail: recipient.email,
            storedRecipientWebsite: recipient.website
          }
        };
        return updatedCoverLetters;
      });
      console.log(`   State update callback triggered`);

      // Immediately persist to AsyncStorage so the data survives even if the
      // backend save fails or the app is closed before the next load cycle.
      try {
        const cacheKey = `reviewCoverLetters_${user.email}`;
        const existing = await AsyncStorage.getItem(cacheKey);
        const existingData = existing ? JSON.parse(existing) : {};
        const updatedCache = { ...existingData, [recipient.email]: updatedCoverLetters[recipient.email] };
        await AsyncStorage.setItem(cacheKey, JSON.stringify(updatedCache));
        console.log(`💾 AsyncStorage updated for ${recipient.email}`);
      } catch (cacheErr) {
        console.log('⚠️ AsyncStorage write failed (non-fatal):', cacheErr.message);
      }

      // Save to backend database (sync with web) - wait a bit for state to settle
      setTimeout(() => {
        setReviewCoverLetters(current => {
          saveReviewCoverLettersToBackend(current);
          return current;
        });
      }, 100);
      
      // Increment total generated counter
      setTotalGenerated(prev => prev + 1);
      
      // Reload credit balance after successful generation
      try {
        const creditsResponse = await fetch(`${API_BASE}/user/credits`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (creditsResponse.ok) {
          const creditsData = await creditsResponse.json();
          if (creditsData.success) {
            setCreditBalance(creditsData.balance || 0);
            console.log('💳 Updated credits after generation:', creditsData.balance);
          }
        }
      } catch (creditsError) {
        console.log('Failed to reload credits:', creditsError);
      }
      
      setEditingReviewIndex(null);
      
      setEditedCoverLetterData({
        hiringManager: data.hiringManager,
        companyName: data.companyName,
        email: recipient.email,
        address: defaultAddress,
        date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        position: recipient.position,
        subject: data.subject,
        coverLetterHtml: data.coverLetterHtml
      });
      
      const totalTime = Date.now() - startTime;
      console.log(`✅ [${requestId}] COMPLETE - Cover letter ready! Total time: ${totalTime}ms`);
      console.log(`${'='.repeat(60)}\n`);
      
      // Don't show alert if it's a bulk operation, only for single clicks
      if (!reviewGeneratingAll && !reviewGeneratingAndSendingAll) {
        Alert.alert('Success', 'Cover Letter Generated Successfully');
      }
      
    } catch (error) {
      const errorTime = Date.now();
      console.log(`\n❌ [${requestId}] ERROR CAUGHT at ${errorTime}`);
      console.log(`   Type: ${error.name}`);
      console.log(`   Message: ${error.message}`);
      console.log(`   Stack: ${error.stack?.split('\n')[0]}`);
      console.log(`   Retry count: ${retryCount}`);

      // Handle user cancellation (user explicitly pressed Cancel)
      if (error.name === 'AbortError' && isCancelledRef.current) {
        console.log(`🛑 [${requestId}] Request cancelled by user`);
        return;
      }
      
      if (error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('Network request failed')) {
        if (retryCount < 2) {
          console.log(`🔄 [${requestId}] Retrying attempt ${retryCount + 1}...`);
          Alert.alert('Network Issue', 'Retrying automatically...');
          // Don't let finally block clean up — retry will take over
          requestInProgressRef.current = 'retrying';
          setTimeout(() => generateCoverLetterForReview(recipientIndex, retryCount + 1), 1500);
          return;
        } else {
          console.log(`❌ [${requestId}] Max retries exceeded`);
          Alert.alert('Network Error', 'Failed to generate cover letter after retries. Please check your connection and try again.');
        }
      } else {
        console.log(`❌ [${requestId}] Non-timeout error`);
        Alert.alert('Error', error.message || 'Failed to generate cover letter');
      }
      console.log(`${'='.repeat(60)}\n`);
      
    } finally {
      // Don't clean up if a retry is pending — the retry will handle cleanup
      if (requestInProgressRef.current === 'retrying') {
        requestInProgressRef.current = true; // reset flag for the retry
        return;
      }
      // Always deactivate keep-awake when done
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      console.log('🔓 Keep-awake deactivated - app can sleep normally');
      stopProgressiveLoading();
      setReviewGeneratingIndex(null);
    }
  };

  const generateAllCoverLettersForReview = async () => {
    // Validate profile before generating
    if (!validateProfileForGeneration()) return;

    // Check credits before generating
    if (creditBalance <= 0) {
      Alert.alert(
        'Insufficient Credits',
        'Remaining credits are 0. Please recharge to continue generating cover letters.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: '💎 Recharge Now', onPress: () => setScreen('packages') }
        ]
      );
      return;
    }
    
    try {
      isCancelledRef.current = false;
      setReviewGeneratingAll(true);
      requestInProgressRef.current = true;
      await activateKeepAwakeAsync();
      setProgressiveLoadingProgress(1);
      setProgressiveLoadingMessage('🔍 Starting batch generation...');
      progressAnimValue.setValue(1);
      
      // Build recipients payload
      const validRecipients = recipients.map((r, i) => ({
        email: r.email, website: r.website, position: r.position
      }));
      
      // Send batch request to server
      const response = await fetch(`${API_BASE}/batch-process`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ recipients: validRecipients, mode: 'generate' })
      });
      
      if (response.status === 202) {
        const { jobId } = await response.json();
        console.log(`🔄 Batch generate job started: ${jobId}`);
        activeJobRef.current = { jobId, type: 'batch_generate' };
        
        const batchResult = await pollJobStatus(jobId);
        console.log('✅ Batch generate completed:', batchResult);
        
        if (isCancelledRef.current) return;
        
        // Process results — update state for each recipient
        if (batchResult.results) {
          for (const [indexStr, result] of Object.entries(batchResult.results)) {
            const index = parseInt(indexStr);
            if (result.generated && result.generationData) {
              const data = result.generationData;
              const recipient = recipients[index];
              
              // Build address from locations
              const headquarterLocation = data.locations?.find(loc => loc.isHeadquarters) || data.locations?.[0];
              let defaultAddress = '';
              if (headquarterLocation) {
                let address = headquarterLocation.address || '';
                const city = headquarterLocation.city || '';
                const country = headquarterLocation.country || '';
                if (!address || address === 'Address not available online') {
                  const parts = [];
                  if (city && city !== 'Not specified') parts.push(city);
                  if (country && country !== 'Not specified') parts.push(country);
                  defaultAddress = parts.join(', ') || '';
                } else {
                  defaultAddress = address;
                  if (city && city !== 'Not specified' && !address.toLowerCase().includes(city.toLowerCase())) {
                    defaultAddress += `, ${city}`;
                  }
                  if (country && country !== 'Not specified' && !address.toLowerCase().includes(country.toLowerCase())) {
                    defaultAddress += `, ${country}`;
                  }
                }
              }
              
              const newEntry = {
                ...data,
                coverLetterHtml: data.coverLetterHtml,
                address: defaultAddress,
                date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                generated: true,
                sent: false,
                storedRecipientEmail: recipient?.email,
                storedRecipientWebsite: recipient?.website
              };
              setReviewCoverLetters(prev => ({ ...prev, [recipient.email]: newEntry }));
              // Immediate AsyncStorage write so data survives even if backend save fails
              AsyncStorage.getItem(`reviewCoverLetters_${user?.email}`).then(raw => {
                const existing = raw ? JSON.parse(raw) : {};
                return AsyncStorage.setItem(`reviewCoverLetters_${user?.email}`, JSON.stringify({ ...existing, [recipient.email]: newEntry }));
              }).catch(() => {});
              setTotalGenerated(prev => prev + 1);
            }
          }

          // Save to backend
          setTimeout(() => {
            setReviewCoverLetters(current => {
              saveReviewCoverLettersToBackend(current);
              return current;
            });
          }, 500);
          
          // Reload credits
          try {
            const creditsResponse = await fetch(`${API_BASE}/user/credits`, {
              headers: { 'Authorization': `Bearer ${user.token}` }
            });
            if (creditsResponse.ok) {
              const creditsData = await creditsResponse.json();
              if (creditsData.success) setCreditBalance(creditsData.balance || 0);
            }
          } catch (e) { console.log('Failed to reload credits:', e); }
        }
        
        if (!isCancelledRef.current) {
          const genCount = batchResult.generatedCount || 0;
          Alert.alert('Success', `Generated ${genCount} cover letter${genCount !== 1 ? 's' : ''}`);
        }
      } else {
        // Fallback: non-202 means async not enabled — use old parallel approach
        const errorText = await response.text();
        throw new Error(`Batch request failed: ${response.status} ${errorText}`);
      }
    } catch (error) {
      if (!isCancelledRef.current) {
        Alert.alert('Error', error.message);
      }
    } finally {
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      stopProgressiveLoading();
      setReviewGeneratingAll(false);
    }
  };

  const sendAllApplicationsFromReview = async () => {
    // Check credits before sending
    if (creditBalance <= 0) {
      Alert.alert(
        'Insufficient Credits',
        'Remaining credits are 0. Please recharge to continue sending applications.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: '💎 Recharge Now', onPress: () => setScreen('packages') }
        ]
      );
      return;
    }
    
    try {
      // Validate that all cover letters are generated
      const recipientsWithoutCoverLetters = recipients.filter((recipient, index) => {
        const coverLetter = getCoverLetter(index);
        return recipient.email && recipient.website && !coverLetter;
      });

      if (recipientsWithoutCoverLetters.length > 0) {
        Alert.alert(
          'Generate Cover Letters First',
          'Please generate cover letters for all recipients before sending.'
        );
        return;
      }

      isCancelledRef.current = false;
      setReviewSendingAll(true);
      requestInProgressRef.current = true;
      await activateKeepAwakeAsync();
      setProgressiveLoadingProgress(1);
      setProgressiveLoadingMessage('📧 Preparing to send applications...');
      progressAnimValue.setValue(1);
      
      // Build payloads
      const validRecipients = recipients.map((r, i) => ({
        email: r.email, website: r.website, position: r.position
      }));
      
      // Build coverLetters map for the server
      const coverLettersPayload = {};
      recipients.forEach((r, i) => {
        const cl = getCoverLetter(i);
        if (cl) {
          coverLettersPayload[String(i)] = {
            coverLetterHtml: cl.coverLetterHtml,
            companyName: cl.companyName,
            address: cl.address || '',
            companyAddress: cl.address || '',
            // Pass the explicit saved region (or null); the server auto-detects from the
            // employer address when null, so it uses the same address it builds for sending.
            coverLetterRegion: cl.coverLetterRegion || null,
            resumeRegion:      cl.resumeRegion      || null
          };
        }
      });
      
      const response = await fetch(`${API_BASE}/batch-process`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ recipients: validRecipients, mode: 'send', coverLetters: coverLettersPayload })
      });
      
      if (response.status === 202) {
        const { jobId } = await response.json();
        console.log(`🔄 Batch send job started: ${jobId}`);
        activeJobRef.current = { jobId, type: 'batch_send' };
        
        const batchResult = await pollJobStatus(jobId);
        console.log('✅ Batch send completed:', batchResult);
        
        if (isCancelledRef.current) return;
        
        // Mark sent recipients in state
        if (batchResult.results) {
          for (const [indexStr, result] of Object.entries(batchResult.results)) {
            const index = parseInt(indexStr);
            if (result.sent) {
              const sentRecipient = recipients[index];
              const emailKey = sentRecipient?.email;
              if (emailKey) {
                setReviewCoverLetters(prev => ({
                  ...prev,
                  [emailKey]: { ...prev[emailKey], sent: true, sentDate: new Date().toISOString() }
                }));
              }
              
              const recipient = recipients[index];
              const coverLetter = getCoverLetter(index);
              const historyEntry = {
                id: Date.now() + index,
                companyName: coverLetter?.companyName || '',
                position: recipient?.position || 'N/A',
                recipientEmail: recipient?.email,
                sentDate: new Date().toISOString(),
                replyReceived: false,
                replyDate: null
              };
              setApplicationHistory(prev => [historyEntry, ...prev].slice(0, 10));
              setTotalSent(prev => prev + 1);
            }
          }
        }
        
        if (!isCancelledRef.current) {
          const sentCount = batchResult.sentCount || 0;
          Alert.alert('Success', `Sent ${sentCount} application${sentCount !== 1 ? 's' : ''}`);
        }
      } else {
        const errorText = await response.text();
        throw new Error(`Batch request failed: ${response.status} ${errorText}`);
      }
    } catch (error) {
      if (!isCancelledRef.current) {
        Alert.alert('Error', error.message);
      }
    } finally {
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      stopProgressiveLoading();
      setReviewSendingAll(false);
    }
  };

  const generateAndSendAllApplications = async () => {
    // Validate profile before generating and sending
    if (!validateProfileForGeneration()) return;

    // Check credits before generating and sending
    if (creditBalance <= 0) {
      Alert.alert(
        'Insufficient Credits',
        'Remaining credits are 0. Please recharge to continue generating and sending applications.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: '💎 Recharge Now', onPress: () => setScreen('packages') }
        ]
      );
      return;
    }
    
    try {
      isCancelledRef.current = false;
      setReviewGeneratingAndSendingAll(true);
      requestInProgressRef.current = true;
      await activateKeepAwakeAsync();
      setProgressiveLoadingProgress(1);
      setProgressiveLoadingMessage('🚀 Starting auto process...');
      progressAnimValue.setValue(1);
      
      console.log('🚀 Starting Auto Process (server-side batch)...');
      
      // Build recipients payload
      const validRecipients = recipients.map((r, i) => ({
        email: r.email, website: r.website, position: r.position
      }));
      
      const response = await fetch(`${API_BASE}/batch-process`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ recipients: validRecipients, mode: 'generate-and-send' })
      });
      
      if (response.status === 202) {
        const { jobId } = await response.json();
        console.log(`🔄 Batch generate-and-send job started: ${jobId}`);
        activeJobRef.current = { jobId, type: 'batch_generate_and_send' };
        
        const batchResult = await pollJobStatus(jobId);
        console.log('✅ Batch generate-and-send completed:', batchResult);
        
        if (isCancelledRef.current) return;
        
        // Process results — update state for each recipient
        if (batchResult.results) {
          for (const [indexStr, result] of Object.entries(batchResult.results)) {
            const index = parseInt(indexStr);
            const recipient = recipients[index];
            
            // Update cover letter state if generated
            if (result.generated && result.generationData) {
              const data = result.generationData;
              
              // Build address
              const headquarterLocation = data.locations?.find(loc => loc.isHeadquarters) || data.locations?.[0];
              let defaultAddress = '';
              if (headquarterLocation) {
                let address = headquarterLocation.address || '';
                const city = headquarterLocation.city || '';
                const country = headquarterLocation.country || '';
                if (!address || address === 'Address not available online') {
                  const parts = [];
                  if (city && city !== 'Not specified') parts.push(city);
                  if (country && country !== 'Not specified') parts.push(country);
                  defaultAddress = parts.join(', ') || '';
                } else {
                  defaultAddress = address;
                  if (city && city !== 'Not specified' && !address.toLowerCase().includes(city.toLowerCase())) {
                    defaultAddress += `, ${city}`;
                  }
                  if (country && country !== 'Not specified' && !address.toLowerCase().includes(country.toLowerCase())) {
                    defaultAddress += `, ${country}`;
                  }
                }
              }
              
              if (recipient?.email) {
                const gsEntry = {
                  ...data,
                  coverLetterHtml: data.coverLetterHtml,
                  address: defaultAddress,
                  date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                  generated: true,
                  sent: result.sent || false,
                  sentDate: result.sent ? new Date().toISOString() : null,
                  storedRecipientEmail: recipient?.email,
                  storedRecipientWebsite: recipient?.website
                };
                setReviewCoverLetters(prev => ({ ...prev, [recipient.email]: gsEntry }));
                AsyncStorage.getItem(`reviewCoverLetters_${user?.email}`).then(raw => {
                  const existing = raw ? JSON.parse(raw) : {};
                  return AsyncStorage.setItem(`reviewCoverLetters_${user?.email}`, JSON.stringify({ ...existing, [recipient.email]: gsEntry }));
                }).catch(() => {});
              }
              setTotalGenerated(prev => prev + 1);
            }
            
            // Update sent state + history
            if (result.sent) {
              const coverLetter = result.generationData || {};
              const historyEntry = {
                id: Date.now() + index,
                companyName: coverLetter.companyName || '',
                position: recipient?.position || 'N/A',
                recipientEmail: recipient?.email,
                sentDate: new Date().toISOString(),
                replyReceived: false,
                replyDate: null
              };
              setApplicationHistory(prev => [historyEntry, ...prev].slice(0, 10));
              setTotalSent(prev => prev + 1);
            }
          }
          
          // Save to backend
          setTimeout(() => {
            setReviewCoverLetters(current => {
              saveReviewCoverLettersToBackend(current);
              return current;
            });
          }, 500);
          
          // Reload credits
          try {
            const creditsResponse = await fetch(`${API_BASE}/user/credits`, {
              headers: { 'Authorization': `Bearer ${user.token}` }
            });
            if (creditsResponse.ok) {
              const creditsData = await creditsResponse.json();
              if (creditsData.success) setCreditBalance(creditsData.balance || 0);
            }
          } catch (e) { console.log('Failed to reload credits:', e); }
        }
        
        if (!isCancelledRef.current) {
          const genCount = batchResult.generatedCount || 0;
          const sentCount = batchResult.sentCount || 0;
          if (sentCount > 0) {
            Alert.alert('Success', `Generated and sent ${sentCount} application${sentCount !== 1 ? 's' : ''}${genCount > sentCount ? `. ${genCount - sentCount} failed to send.` : ''}`);
          } else {
            // Extract actual error from results to show the user
            let errorDetail = '';
            if (batchResult.results) {
              const firstError = Object.values(batchResult.results).find(r => r.error || r.sendError);
              if (firstError) {
                errorDetail = firstError.sendError || firstError.error || '';
              }
            }
            Alert.alert('Error', errorDetail 
              ? `Failed to send applications: ${errorDetail}` 
              : 'Failed to send any applications. Please check your email connection in settings.');
          }
        }
      } else {
        const errorText = await response.text();
        throw new Error(`Batch request failed: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('❌ Auto Process error:', error);
      if (!isCancelledRef.current) {
        Alert.alert('Error', error.message);
      }
    } finally {
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      stopProgressiveLoading();
      setReviewGeneratingAndSendingAll(false);
    }
  };

  const sendApplicationFromReview = async (recipientIndex, silent = false, coverLetterOverride = null, retryCount = 0) => {
    const recipient = recipients[recipientIndex];
    const coverLetter = coverLetterOverride || getCoverLetter(recipientIndex);
    
    console.log(`\n🔍 [SEND ${recipientIndex}] Starting send process...`);
    console.log(`   Recipient: ${recipient?.email}`);
    console.log(`   Cover letter source: ${coverLetterOverride ? 'OVERRIDE' : 'STATE'}`);
    console.log(`   Cover letter exists: ${!!coverLetter}`);
    
    // Reset cancellation flag for single send operations
    if (!reviewSendingAll && !reviewGeneratingAndSendingAll && !silent) {
      isCancelledRef.current = false;
    }
    
    if (coverLetter) {
      console.log(`   Cover letter details:`);
      console.log(`     - Company: ${coverLetter.companyName}`);
      console.log(`     - Has HTML: ${!!coverLetter.coverLetterHtml}`);
      console.log(`     - HTML length: ${coverLetter.coverLetterHtml?.length || 0}`);
      console.log(`     - Already sent: ${coverLetter.sent || false}`);
    }
    
    if (!coverLetter) {
      console.log(`❌ [SEND ${recipientIndex}] No cover letter found`);
      if (!silent) Alert.alert('Error', 'Generate cover letter first');
      return false;
    }

    try {
      setReviewLoading(true);
      
      // Track active request and keep app awake
      requestInProgressRef.current = true;
      await activateKeepAwakeAsync();
      
      console.log(`\n=== [SEND ${recipientIndex}] MOBILE: SENDING APPLICATION ===`);
      console.log('Recipient email:', recipient.email);
      console.log('Recipient website:', recipient.website);
      console.log('Position:', recipient.position);
      console.log('Company name:', coverLetter.companyName);
      console.log('🔍 COMPANY ADDRESS DEBUG:');
      console.log('  coverLetter.locations:', coverLetter.locations);
      console.log('  coverLetter.locations[0]:', coverLetter.locations?.[0]);
      console.log('  coverLetter.locations[0].address:', coverLetter.locations?.[0]?.address);
      console.log('Cover letter length:', coverLetter.coverLetterHtml?.length || 0);
      console.log('API endpoint:', `${API_BASE}/send-single-application`);
      console.log('User token present:', !!user.token);
      
      // Region selection: honour the user's saved pick, else auto-detect. The employer address
      // lives in coverLetter.locations[] (NOT coverLetter.address — that was empty → always
      // 'generic'); bestRegion() resolves it and falls back to the website/email ccTLD.
      const autoRegion = bestRegion(coverLetter, recipient);
      const clRegion  = coverLetter.coverLetterRegion || autoRegion;
      const resRegion = coverLetter.resumeRegion      || autoRegion;
      console.log(`🌍 Region resolved: cover=${clRegion} resume=${resRegion} (auto=${autoRegion})`);

      const requestBody = {
        recipientEmail: recipient.email,
        websiteUrl: recipient.website,
        position: recipient.position,
        coverLetterText: coverLetter.coverLetterHtml,
        companyName: coverLetter.companyName,
        companyAddress: employerAddress(coverLetter) || coverLetter.address || '',
        brandColor: coverLetter.brandColor || null,
        fontName: coverLetter.fontName || null,
        coverLetterRegion: clRegion,
        resumeRegion: resRegion
      };
      console.log('Request body companyAddress:', requestBody.companyAddress);
      console.log('Request body:', JSON.stringify(requestBody, null, 2));
      
      console.log(`⏱️  [SEND ${recipientIndex}] Starting fetch request...`);
      
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout after 180 seconds')), 180000)
      );

      // Create new AbortController for this request
      abortControllerRef.current = new AbortController();
      
      const fetchPromise = fetch(`${API_BASE}/send-single-application`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify(requestBody)
      });
      
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      
      console.log(`✅ [SEND ${recipientIndex}] Got response!`);
      console.log(`Response status [${recipientIndex}]:`, response.status);
      
      // ASYNC MODE: Server returned 202 with jobId — switch to polling
      if (response.status === 202) {
        const { jobId } = await response.json();
        console.log(`🔄 [SEND ${recipientIndex}] Async job started: ${jobId} — switching to polling`);
        activeJobRef.current = { jobId, type: 'send', recipientIndex };
        
        const result = await pollJobStatus(jobId);
        console.log(`✅ [SEND ${recipientIndex}] Async job completed`);
        
        if (isCancelledRef.current) {
          console.log(`🛑 [SEND ${recipientIndex}] Operation cancelled during polling`);
          return false;
        }
        
        if (!result || !result.success) {
          throw new Error((result && result.error) || 'Send failed');
        }
        
        // Fall through to update state below
      } else {
      // Check if operation was cancelled while waiting for response
      if (isCancelledRef.current) {
        console.log(`🛑 [SEND ${recipientIndex}] Operation cancelled - not updating state`);
        return false;
      }
      
      // Check if response is OK first
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`❌ [SEND ${recipientIndex}] Response not OK:`, response.status, errorText);
        // Try to parse error message from server
        let errorMsg = `Server error: ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error) errorMsg = errorData.error;
          if (errorData.message) errorMsg = errorData.message;
        } catch (e) {}
        // If OAuth token issue, update user state to show disconnected
        if (errorMsg.includes('OAuth') || errorMsg.includes('token expired') || errorMsg.includes('log in again')) {
          setUser(prev => ({ ...prev, oauth_provider: null }));
        }
        throw new Error(errorMsg);
      }
      
      // Get response as text first to see what we're dealing with
      const responseText = await response.text();
      console.log(`Response text [${recipientIndex}] (first 500 chars):`, responseText.substring(0, 500));
      
      // Try to parse as JSON
      let responseData;
      try {
        responseData = JSON.parse(responseText);
        console.log(`Parsed response data [${recipientIndex}]:`, responseData);
      } catch (parseError) {
        console.log(`⚠️ JSON parse error [${recipientIndex}]:`, parseError.message);
        // If response was OK but can't parse JSON, still consider it success
        console.log(`✅ [SEND ${recipientIndex}] Email sent (response OK despite parse error)`);
      }
      } // end else (sync path)

      console.log(`✅ [SEND ${recipientIndex}] Updating state to mark as sent`);
      const sentEmail = recipient?.email;
      if (sentEmail) {
        setReviewCoverLetters(prev => ({
          ...prev,
          [sentEmail]: {
            ...(prev[sentEmail] || prev[recipientIndex] || {}),
            sent: true,
            sentDate: new Date().toISOString()
          }
        }));
      }
      
      // Add to application history
      const historyEntry = {
        id: Date.now() + recipientIndex, // Ensure unique ID
        companyName: coverLetter.companyName,
        position: recipient.position || 'N/A',
        recipientEmail: recipient.email,
        sentDate: new Date().toISOString(),
        replyReceived: false,
        replyDate: null
      };
      
      setApplicationHistory(prev => [historyEntry, ...prev].slice(0, 10)); // Keep last 10
      
      // Increment total sent counter
      setTotalSent(prev => prev + 1);
      
      console.log(`=== [SEND ${recipientIndex}] APPLICATION SENT SUCCESSFULLY ===\n`);
      if (!silent) Alert.alert('Success', `Application sent to ${recipient.email}`);
      return true;
    } catch (error) {
      console.log(`\n=== [SEND ${recipientIndex}] SEND APPLICATION ERROR ===`);
      console.log('Error name:', error.name);
      console.log('Error message:', error.message);
      console.log('Error stack:', error.stack);
      console.log('Error type:', typeof error);
      console.log('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      console.log('================================\n');

      // Handle user cancellation
      if (error.name === 'AbortError' && isCancelledRef.current) {
        console.log('🛑 Request cancelled by user');
        return false;
      }

      // Retry on network/timeout errors (up to 2 retries)
      if (error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('Network request failed')) {
        if (retryCount < 2) {
          console.log(`🔄 [SEND ${recipientIndex}] Retrying attempt ${retryCount + 1}...`);
          if (!silent) Alert.alert('Network Issue', 'Retrying automatically...');
          requestInProgressRef.current = 'retrying';
          return new Promise(resolve => {
            setTimeout(async () => {
              const result = await sendApplicationFromReview(recipientIndex, silent, coverLetterOverride, retryCount + 1);
              resolve(result);
            }, 1500);
          });
        }
      }

      if (!silent) Alert.alert('Error', error.message || 'Failed to send application');
      return false;
    } finally {
      if (requestInProgressRef.current === 'retrying') {
        requestInProgressRef.current = true;
        return;
      }
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      setReviewLoading(false);
    }
  };

  // Look up cover letter by the recipient's email (the stable key used for all writes).
  // Also tries a linear scan as a fallback for any legacy entries that were written
  // with a numeric key before this migration, so old data is never lost.
  const getCoverLetter = (index) => {
    const recipient = recipients[index];
    if (!recipient) return null;
    // 0. AUTHORITATIVE: the unique clKey link (AI-Hub cards). Never ambiguous across companies,
    //    even when the email is the shared user placeholder or the website is empty.
    if (recipient.clKey) {
      if (reviewCoverLetters[recipient.clKey]) return reviewCoverLetters[recipient.clKey];
      const byKey = Object.values(reviewCoverLetters).find(e => e?.storedRecipientClKey === recipient.clKey);
      if (byKey) return byKey;
    }
    // 1. Direct email-key lookup (normal recipients have unique real emails)
    if (recipient.email && reviewCoverLetters[recipient.email]) return reviewCoverLetters[recipient.email];
    // 2. Legacy storedRecipientEmail scan
    if (recipient.email) {
      const legacy = Object.values(reviewCoverLetters).find(e => e?.storedRecipientEmail === recipient.email);
      if (legacy) return legacy;
    }
    // 3. Legacy website fallback (old cards saved before clKey existed)
    if (recipient.website) {
      const sameSite = Object.values(reviewCoverLetters).filter(e => e?.storedRecipientWebsite === recipient.website);
      if (sameSite.length === 1) return sameSite[0];
      if (sameSite.length > 1) {
        const byPos = sameSite.find(e => e?.storedRecipientPosition === recipient.position);
        if (byPos) return byPos;
        return sameSite[0];
      }
    }
    return null;
  };

  const downloadCoverLetterPDFFromReview = async (recipientIndex, format = 'pdf') => {
    const coverLetter = getCoverLetter(recipientIndex);

    if (!coverLetter) {
      Alert.alert('Error', 'Generate cover letter first');
      return;
    }

    // Open the country-format cover-letter picker (preview free, download = 2 credits).
    // `format` ('pdf' | 'docx') is the choice made on the Review screen; the picker
    // surfaces that format first so the user lands on their chosen download.
    try {
      await AsyncStorage.setItem('coverLetterPickerContext', JSON.stringify({
        coverLetterHtml: coverLetter.coverLetterHtml,
        companyName: coverLetter.companyName,
        companyAddress: coverLetter.address || '',
        format,
      }));
      expoRouter.push('/(cover-letter)/templates');
    } catch (e) {
      Alert.alert('Error', 'Could not open download options.');
    }
    return;

    try {
      isCancelledRef.current = false;
      setReviewDownloading(true);
      
      // Track active request and keep app awake
      requestInProgressRef.current = true;
      await activateKeepAwakeAsync();

      // Create new AbortController for this request
      abortControllerRef.current = new AbortController();

      const response = await fetch(`${API_BASE}/generate-cover-letter-pdf`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          coverLetterHtml: coverLetter.coverLetterHtml,
          companyName: coverLetter.companyName,
          companyAddress: coverLetter.address || '',
          websiteUrl: coverLetter.storedRecipientWebsite || null,
          brandColor: coverLetter.brandColor || null,
          fontName: coverLetter.fontName || null
        })
      });

      let data;
      
      // ASYNC MODE: Server returned 202 with jobId — switch to polling
      if (response.status === 202) {
        const { jobId } = await response.json();
        console.log(`🔄 [PDF] Async job started: ${jobId} — switching to polling`);
        activeJobRef.current = { jobId, type: 'pdf', recipientIndex };
        
        data = await pollJobStatus(jobId);
        console.log(`✅ [PDF] Async job completed`);
        
        if (isCancelledRef.current) {
          console.log('🛑 Download cancelled during polling');
          return;
        }
      } else {
      if (!response.ok) throw new Error('Failed to generate PDF');
      
      // Check if operation was cancelled
      if (isCancelledRef.current) {
        console.log('🛑 Download cancelled - aborting');
        return;
      }
      
      // Get the response JSON with download URL
      data = await response.json();
      } // end else (sync path)
      
      if (!data.downloadUrl) {
        throw new Error('No download URL received');
      }
      
      // Save to file system using legacy downloadAsync (reliable across all versions)
      const sanitizedName = (profileData?.fullName || 'Applicant').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
      const fileName = `${sanitizedName}_Cover_Letter.pdf`;
      
      // downloadUrl starts with /api/ but API_BASE already ends with /api
      const cleanUrl = data.downloadUrl.replace(/^\/api/, '');
      const fullUrl = `${API_BASE}${cleanUrl}`;
      console.log('📥 Downloading PDF from:', fullUrl);
      
      const fileUri = cacheDirectory + fileName;
      const downloadResult = await downloadAsync(fullUrl, fileUri, {
        headers: { 'Authorization': `Bearer ${user.token}` },
      });
      
      console.log('📥 Downloaded file:', downloadResult.uri, 'status:', downloadResult.status);
      
      if (downloadResult.status !== 200) {
        throw new Error(`Download failed with status ${downloadResult.status}`);
      }
      
      // Share the file
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloadResult.uri);
        Alert.alert('Success', 'PDF downloaded successfully!');
      } else {
        Alert.alert('Error', 'Sharing is not available on this device');
      }
    } catch (error) {
      // Handle user cancellation
      if (error.name === 'AbortError' && isCancelledRef.current) {
        console.log('🛑 Download cancelled by user');
        return;
      }
      
      Alert.alert('Error', error.message);
    } finally {
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      setReviewDownloading(false);
    }
  };

  // Load recipients from backend
  const loadRecipientsFromBackend = async (userToken) => {
    try {
      const response = await fetch(`${API_BASE}/users/recipients`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        console.log('Failed to load recipients from backend');
        return;
      }

      const data = await response.json();
      
      if (data.success && data.recipients && data.recipients.length > 0) {
        // Convert database format to state format (add error field)
        const loadedRecipients = data.recipients.map(r => ({
          id: r.id,
          email: r.email,
          website: r.website,
          position: r.position || '',
          ...(r.clKey ? { clKey: r.clKey } : {}),   // preserve the AI-Hub unique link across reloads
          error: ''
        }));
        setRecipients(loadedRecipients);
        console.log(`✅ Loaded ${loadedRecipients.length} recipients from backend`);
      } else {
        // Keep default empty recipient if no recipients in database
        setRecipients([{ id: 0, email: '', website: '', position: '', error: '' }]);
      }
    } catch (err) {
      console.log('Error loading recipients:', err.message);
      // Keep default empty recipient on error
      setRecipients([{ id: 0, email: '', website: '', position: '', error: '' }]);
    }
  };

  // Save recipients to backend (debounced)
  const saveRecipientsToBackend = async () => {
    if (!user?.token) return;

    try {
      const response = await fetch(`${API_BASE}/users/recipients`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipients })
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`✅ Saved ${data.recipientsCount} recipients to backend`);
      } else {
        console.log('Failed to save recipients to backend');
      }
    } catch (err) {
      console.log('Error saving recipients:', err.message);
    }
  };

  // Load notifications from backend
  const loadNotifications = async (force = false) => {
    if (!user?.token) return;
    
    // Don't fetch if we just updated locally (within last 5 seconds) unless forced
    const now = Date.now();
    const timeSinceLastUpdate = lastNotificationUpdateRef.current ? now - lastNotificationUpdateRef.current : Infinity;
    
    if (!force && timeSinceLastUpdate < 5000) {
      console.log('⏭️  Skipping fetch - notifications were just updated locally', timeSinceLastUpdate, 'ms ago');
      console.log('💡 Using local state to preserve recent mark-as-read updates');
      return;
    }
    
    console.log('📥 Loading notifications (limit 5)... Force:', force, 'Time since last update:', timeSinceLastUpdate);
    setLoadingNotifications(true);
    try {
      const response = await fetch(`${API_BASE}/notifications?limit=5`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        console.log('✅ Notifications loaded:', data.notifications?.length || 0, 'unread:', data.unreadCount);
        if (data.success) {
          setNotifications(data.notifications || []);
          setUnreadCount(data.unreadCount || 0);
        }
      } else {
        console.log('❌ Failed to load notifications:', response.status);
      }
    } catch (err) {
      console.log('❌ Error loading notifications:', err.message);
    } finally {
      setLoadingNotifications(false);
    }
  };

  // Load all notifications for notifications page  
  const loadAllNotifications = async (force = false) => {
    if (!user?.token) return;

    // Don't fetch if we just updated locally (within last 5 seconds) unless forced
    const now = Date.now();
    const timeSinceLastUpdate = lastNotificationUpdateRef.current ? now - lastNotificationUpdateRef.current : Infinity;

    if (!force && timeSinceLastUpdate < 5000) {
      console.log('⏭️  Skipping fetch (all) - notifications were just updated locally', timeSinceLastUpdate, 'ms ago');
      return;
    }

    console.log('📥 Loading notifications page 1...');
    setLoadingNotifications(true);
    notificationsPageRef.current = 0;
    try {
      const response = await fetch(`${API_BASE}/notifications?limit=${NOTIF_PAGE_SIZE}&offset=0`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${user.token}`, 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        const data = await response.json();
        console.log('✅ Notifications loaded:', data.notifications?.length || 0, '/ total:', data.totalCount, '/ unread:', data.unreadCount);
        if (data.success) {
          setNotifications(data.notifications || []);
          setUnreadCount(data.unreadCount || 0);
          setNotificationsTotalCount(data.totalCount || 0);
          setNotificationsReadCount(data.readCount || 0);
          setNotificationsHasMore(data.hasMore || false);
          notificationsPageRef.current = (data.notifications || []).length;
        }
      } else {
        console.log('❌ Failed to load notifications:', response.status);
      }
    } catch (err) {
      console.log('Error loading notifications:', err.message);
    } finally {
      setLoadingNotifications(false);
    }
  };

  // Load the next page of notifications and append to existing list
  const loadMoreNotifications = async () => {
    if (!user?.token || notificationsLoadingMore || !notificationsHasMore) return;
    const offset = notificationsPageRef.current;
    console.log('📥 Loading more notifications, offset:', offset);
    setNotificationsLoadingMore(true);
    try {
      const response = await fetch(`${API_BASE}/notifications?limit=${NOTIF_PAGE_SIZE}&offset=${offset}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${user.token}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setNotifications(prev => [...prev, ...(data.notifications || [])]);
          setUnreadCount(data.unreadCount || 0);
          setNotificationsTotalCount(data.totalCount || 0);
          setNotificationsReadCount(data.readCount || 0);
          setNotificationsHasMore(data.hasMore || false);
          notificationsPageRef.current = offset + (data.notifications || []).length;
          console.log('✅ More notifications appended. New offset:', notificationsPageRef.current, '/ hasMore:', data.hasMore);
        }
      }
    } catch (err) {
      console.log('Error loading more notifications:', err.message);
    } finally {
      setNotificationsLoadingMore(false);
    }
  };

  // Mark all notifications as read
  const markAllNotificationsRead = async () => {
    if (!user?.token) return;
    
    console.log('📝 Marking ALL notifications as read');
    
    // Optimistically update UI immediately
    setNotifications(prevNotifications => 
      prevNotifications.map(n => ({ ...n, is_read: true }))
    );
    setUnreadCount(0);
    
    // Mark timestamp of local update to prevent immediate refetch
    lastNotificationUpdateRef.current = Date.now();
    console.log('⏰ Set last notification update timestamp:', lastNotificationUpdateRef.current);
    
    // Make API call in background
    try {
      await fetch(`${API_BASE}/notifications/mark-all-read`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        }
      });
    } catch (err) {
      console.log('Error marking all notifications as read (silent):', err.message);
      // Don't revert - keep optimistic update
    }
  };

  // Mark single notification as read
  const markNotificationAsRead = async (notificationId) => {
    if (!user?.token) return;
    
    // Check if already marked
    const notification = notifications.find(n => n.id === notificationId);
    console.log('🔍 Checking notification:', { id: notificationId, found: !!notification, is_read: notification?.is_read });
    
    if (!notification || notification.is_read) {
      console.log('⏭️  Notification already read or not found:', notificationId);
      return;
    }
    
    console.log('📝 Marking notification as read:', notificationId, 'API_BASE:', API_BASE);
    console.log('🔑 Using token:', user.token ? 'Token exists' : 'No token');
    
    // Optimistically update UI immediately
    setNotifications(prevNotifications => {
      const updated = prevNotifications.map(n => 
        n.id === notificationId ? { ...n, is_read: true } : n
      );
      console.log('✅ Optimistically updated state. Unread before:', prevNotifications.filter(n => !n.is_read).length);
      return updated;
    });
    setUnreadCount(prevCount => {
      const newCount = Math.max(0, prevCount - 1);
      console.log('📊 Unread count updated:', prevCount, '→', newCount);
      return newCount;
    });
    
    // Mark timestamp of local update to prevent immediate refetch
    lastNotificationUpdateRef.current = Date.now();
    console.log('⏰ Set last notification update timestamp:', lastNotificationUpdateRef.current);
    
    // Make API call in background
    try {
      const url = `${API_BASE}/notifications/${notificationId}/read`;
      console.log('🌐 Making API call to:', url);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        }
      });
      
      console.log('📡 API Response status:', response.status, response.statusText);
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Notification marked as read on server:', data);
      } else {
        const errorText = await response.text();
        console.log('❌ Failed to mark notification as read on server:', response.status, errorText);
      }
    } catch (err) {
      console.log('❌ Error marking notification as read:', err.message, err.stack);
      // Don't revert - keep optimistic update
    }
  };

  // Get time ago for notifications
  const getTimeAgo = (timestamp) => {
    const now = new Date();
    const then = new Date(timestamp);
    const seconds = Math.floor((now - then) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return `${Math.floor(seconds / 604800)}w ago`;
  };

  // Save review cover letters to backend database
  const saveReviewCoverLettersToBackend = async (lettersToSave = null) => {
    try {
      if (!user?.token) {
        console.log('⚠️ Cannot save review cover letters - no user token');
        return;
      }

      const dataToSave = lettersToSave || reviewCoverLetters;

      console.log('💾 Saving review cover letters to backend:', Object.keys(dataToSave).length, 'items');

      // ✅ ALWAYS persist to AsyncStorage first — local data is guaranteed regardless of network
      try {
        await AsyncStorage.setItem(`reviewCoverLetters_${user.email}`, JSON.stringify(dataToSave));
        console.log('✅ Review cover letters saved to AsyncStorage');
      } catch (storageErr) {
        console.error('⚠️ AsyncStorage write failed:', storageErr.message);
      }

      const response = await fetch(`${API_BASE}/users/review-cover-letters`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reviewCoverLetters: dataToSave })
      });

      if (response.ok) {
        console.log('✅ Review cover letters saved to backend database');
      } else {
        console.error('❌ Failed to save cover letters to backend:', response.status);
      }
    } catch (error) {
      console.error('Failed to save review cover letters to backend:', error);
    }
  };

  // Re-key any legacy entries that were stored under a numeric index so the entire
  // state is always indexed by email after a load. This runs once per load and is
  // idempotent — email-keyed entries pass through unchanged.
  const rekeyByEmail = (raw) => {
    const result = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (!v) continue;
      const emailKey = v.storedRecipientEmail;
      if (emailKey) {
        // Always prefer the email key; drop the old numeric key
        result[emailKey] = v;
      } else {
        result[k] = v; // keep as-is if no email available
      }
    }
    return result;
  };

  const loadReviewCoverLettersFromStorage = async () => {
    try {
      if (!user?.email) {
        console.log('⚠️ Cannot load review cover letters - no user email');
        return;
      }

      // Always read local AsyncStorage first so we never lose locally-generated
      // entries that the backend doesn't know about yet.
      let localData = {};
      try {
        const stored = await AsyncStorage.getItem(`reviewCoverLetters_${user.email}`);
        if (stored) localData = rekeyByEmail(JSON.parse(stored));
      } catch (_) {}

      // Try to fetch from backend and MERGE with local data.
      // Backend entries win on key conflict (they are the source of truth for
      // persisted data), but local-only entries are always preserved so nothing
      // generated offline can be silently dropped.
      try {
        const response = await fetch(`${API_BASE}/users/review-cover-letters`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          }
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success && data.reviewCoverLetters) {
            const backendData = rekeyByEmail(data.reviewCoverLetters);
            // Merge: local-only entries first, then backend entries override conflicts
            const merged = { ...localData, ...backendData };
            setReviewCoverLetters(merged);
            console.log('📖 Cover letters merged — local:', Object.keys(localData).length,
              '+ backend:', Object.keys(backendData).length,
              '= merged:', Object.keys(merged).length);

            // Persist the merged result so local-only entries survive future loads
            await AsyncStorage.setItem(`reviewCoverLetters_${user.email}`, JSON.stringify(merged));

            // If there are local-only entries the backend doesn't have, push them up now
            const localOnlyKeys = Object.keys(localData).filter(k => !backendData[k]);
            if (localOnlyKeys.length > 0) {
              console.log('📤 Pushing', localOnlyKeys.length, 'local-only cover letters to backend...');
              saveReviewCoverLettersToBackend(merged);
            }
            return;
          }
        } else {
          console.log('⚠️ Backend returned error for cover letters, using local cache');
        }
      } catch (apiError) {
        console.log('⚠️ Backend API error, using local cache:', apiError.message);
      }

      // Backend unreachable — use local data as-is
      if (Object.keys(localData).length > 0) {
        setReviewCoverLetters(localData);
        console.log('📖 Cover letters loaded from local cache (offline):', Object.keys(localData).length, 'items');
      } else {
        console.log('ℹ️ No stored review cover letters found');
      }
    } catch (error) {
      console.error('Failed to load review cover letters:', error);
    }
  };

  const loadApplicationHistoryFromStorage = async () => {
    try {
      if (!user?.email) {
        console.log('⚠️ Cannot load application history - no user email');
        return;
      }
      
      // Try to load from backend API first
      try {
        const response = await fetch(`${API_BASE}/users/application-history`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.applicationHistory) {
            setApplicationHistory(data.applicationHistory);
            console.log('📖 Application history loaded from backend API:', data.applicationHistory.length, 'items');
            
            // Cache in AsyncStorage for offline access
            await AsyncStorage.setItem(`applicationHistory_${user.email}`, JSON.stringify(data.applicationHistory));
            // Continue to load counters and credits below
          }
        } else {
          // Fallback to AsyncStorage if backend returns error
          const stored = await AsyncStorage.getItem(`applicationHistory_${user.email}`);
          if (stored) {
            const parsed = JSON.parse(stored);
            setApplicationHistory(parsed);
            console.log('📖 Application history loaded from AsyncStorage cache:', parsed.length, 'items');
          } else {
            console.log('ℹ️ No stored application history found');
            setApplicationHistory([]); // Set to empty array
          }
        }
      } catch (apiError) {
        console.log('⚠️ Failed to load from backend, trying AsyncStorage cache:', apiError.message);
        // Fallback to AsyncStorage if backend fails
        const stored = await AsyncStorage.getItem(`applicationHistory_${user.email}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          setApplicationHistory(parsed);
          console.log('📖 Application history loaded from AsyncStorage cache:', parsed.length, 'items');
        } else {
          console.log('ℹ️ No stored application history found');
          setApplicationHistory([]); // Set to empty array
        }
      }
      
      // Load cumulative counters from backend API first, fallback to AsyncStorage
      try {
        const response = await fetch(`${API_BASE}/users/counters`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          // Only update if backend returns actual data (not null/undefined)
          if (data.totalGenerated !== null && data.totalGenerated !== undefined) {
            setTotalGenerated(data.totalGenerated);
          }
          if (data.totalSent !== null && data.totalSent !== undefined) {
            setTotalSent(data.totalSent);
          }
          if (data.totalReplied !== null && data.totalReplied !== undefined) {
            setTotalReplied(data.totalReplied);
          }
          console.log('📊 Loaded counters from backend API - Generated:', data.totalGenerated, 'Sent:', data.totalSent, 'Replied:', data.totalReplied);

          // Also load credit balance
          try {
            const creditsResponse = await fetch(`${API_BASE}/user/credits`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${user.token}`,
                'Content-Type': 'application/json',
              }
            });
            
            if (creditsResponse.ok) {
              const creditsData = await creditsResponse.json();
              if (creditsData.success) {
                setCreditBalance(creditsData.balance || 0);
                setExpiringCredits(creditsData.expiringCredits || 0);
                setCreditExpiryDate(creditsData.expiryDate);
                console.log('💳 Loaded credits:', creditsData.balance);
              }
            }
          } catch (creditsError) {
            console.log('⚠️ Could not load credits:', creditsError);
          }
          
          // Always overwrite cache with fresh server data (prevents stale negative values)
          await AsyncStorage.setItem(`appCounters_${user.email}`, JSON.stringify({
              totalGenerated: data.totalGenerated || 0,
              totalSent: data.totalSent || 0,
              totalReplied: data.totalReplied || 0
            }));
        } else {
          // Fallback to AsyncStorage
          console.log('⚠️ Failed to load from backend, using AsyncStorage cache');
          const countersStored = await AsyncStorage.getItem(`appCounters_${user.email}`);
          if (countersStored) {
            const counters = JSON.parse(countersStored);
            // Only update if we have valid cached data - don't override with 0
            if (counters.totalGenerated !== null && counters.totalGenerated !== undefined) {
              setTotalGenerated(counters.totalGenerated);
            }
            if (counters.totalSent !== null && counters.totalSent !== undefined) {
              setTotalSent(counters.totalSent);
            }
            console.log('📊 Loaded counters from AsyncStorage - Generated:', counters.totalGenerated, 'Sent:', counters.totalSent);
          } else {
            console.log('ℹ️ No cached counters - keeping current values');
          }
        }
      } catch (error) {
        console.error('Failed to load counters from backend:', error);
        // Fallback to AsyncStorage - don't override with 0
        const countersStored = await AsyncStorage.getItem(`appCounters_${user.email}`);
        if (countersStored) {
          const counters = JSON.parse(countersStored);
          // Only update if we have valid cached data
          if (counters.totalGenerated !== null && counters.totalGenerated !== undefined) {
            setTotalGenerated(counters.totalGenerated);
          }
          if (counters.totalSent !== null && counters.totalSent !== undefined) {
            setTotalSent(counters.totalSent);
          }
          console.log('📊 Loaded counters from AsyncStorage (fallback) - Generated:', counters.totalGenerated, 'Sent:', counters.totalSent);
        } else {
          console.log('ℹ️ No cached counters - keeping current values');
        }
      }
      
      setCountersLoaded(true);
    } catch (error) {
      console.error('Failed to load application history:', error);
    }
  };

  // Auto-save recipients when they change (debounced with 2 second delay)
  useEffect(() => {
    if (!user?.token) return;
    
    const timer = setTimeout(() => {
      const validRecipients = recipients.filter(r => r.email || r.website);
      if (validRecipients.length > 0) {
        saveRecipientsToBackend();
      }
    }, 2000); // 2 second debounce

    return () => clearTimeout(timer);
  }, [recipients, user?.token]);

  // Auto-save reviewCoverLetters to AsyncStorage AND backend API whenever it changes
  useEffect(() => {
    if (!user?.token || !user?.email) return;
    
    const saveReviewCoverLetters = async () => {
      try {
        const keyCount = Object.keys(reviewCoverLetters).length;
        if (keyCount === 0) {
          console.log('⏭️  Skipping save - no cover letters to save');
          return;
        }
        
        const dataToSave = JSON.stringify(reviewCoverLetters);
        const storageKey = `reviewCoverLetters_${user.email}`;
        await AsyncStorage.setItem(storageKey, dataToSave);
        
        console.log(`💾 Review cover letters saved to AsyncStorage`);
        console.log(`   Storage key: ${storageKey}`);
        console.log(`   Keys in data: ${keyCount}`);
        console.log(`   Data size: ${dataToSave.length} bytes`);
        
        // Verify it was saved
        const verification = await AsyncStorage.getItem(storageKey);
        if (verification) {
          console.log(`   ✅ Verification: Data successfully stored (${verification.length} bytes)`);
        } else {
          console.log(`   ❌ Verification failed: No data found after save!`);
        }

        // Also save to backend API
        try {
          const response = await fetch(`${API_BASE}/users/review-cover-letters`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${user.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ reviewCoverLetters })
          });
          
          if (response.ok) {
            console.log(`   ✅ Also synced to backend API`);
          }
        } catch (apiError) {
          console.log('   ⚠️ Backend sync failed (offline?):', apiError.message);
        }
      } catch (error) {
        console.error('Failed to save review cover letters:', error);
      }
    };
    
    saveReviewCoverLetters();
  }, [reviewCoverLetters, user?.token, user?.email]);

  // Auto-save applicationHistory to AsyncStorage AND backend API whenever it changes
  useEffect(() => {
    if (!user?.token || !user?.email) return;
    
    const saveApplicationHistory = async () => {
      try {
        if (applicationHistory.length === 0) {
          console.log('⏭️  Skipping save - no application history to save');
          return;
        }
        
        const dataToSave = JSON.stringify(applicationHistory);
        const storageKey = `applicationHistory_${user.email}`;
        await AsyncStorage.setItem(storageKey, dataToSave);
        
        console.log(`📊 Application history saved to AsyncStorage`);
        console.log(`   Storage key: ${storageKey}`);
        console.log(`   Items: ${applicationHistory.length}`);
        console.log(`   Data size: ${dataToSave.length} bytes`);

        // Also save to backend API
        try {
          const response = await fetch(`${API_BASE}/users/application-history`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${user.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ applicationHistory })
          });
          
          if (response.ok) {
            console.log(`   ✅ Also synced to backend API`);
          }
        } catch (apiError) {
          console.log('   ⚠️ Backend sync failed (offline?):', apiError.message);
        }
      } catch (error) {
        console.error('Failed to save application history:', error);
      }
    };
    
    saveApplicationHistory();
  }, [applicationHistory, user?.token, user?.email]);

  // Auto-save cumulative counters whenever they change
  useEffect(() => {
    if (!user?.email || !countersLoaded) return;
    
    const saveCounters = async () => {
      try {
        const counters = {
          totalGenerated,
          totalSent
        };
        
        // Save to AsyncStorage (cache)
        const storageKey = `appCounters_${user.email}`;
        await AsyncStorage.setItem(storageKey, JSON.stringify(counters));
        console.log(`📊 Counters saved to AsyncStorage - Generated: ${totalGenerated}, Sent: ${totalSent}`);
        
        // Save to backend API (permanent)
        try {
          const response = await fetch(`${API_BASE}/users/counters`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${user.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(counters)
          });
          
          if (response.ok) {
            console.log(`📊 Counters saved to backend API - Generated: ${totalGenerated}, Sent: ${totalSent}`);
          } else {
            console.log('⚠️ Failed to save counters to backend API');
          }
        } catch (apiError) {
          console.error('Failed to save counters to backend API:', apiError);
        }
      } catch (error) {
        console.error('Failed to save counters:', error);
      }
    };
    
    // Only save if counters have been loaded (don't save initial 0 values)
    if (countersLoaded) {
      saveCounters();
    }
  }, [totalGenerated, totalSent, user?.email, countersLoaded]);

  // Load recipients when user is set
  useEffect(() => {
    if (user?.token && user?.email) {
      console.log('🔄 User token and email available, loading data...');
      loadRecipientsFromBackend(user.token);
      loadReviewCoverLettersFromStorage();
      loadApplicationHistoryFromStorage();
      loadNotifications(); // Load notifications
      
      // Auto-check for replies on login (Microsoft OAuth users only — Gmail disabled until CASA)
      if (user.provider === 'microsoft' || user.oauth_provider === 'microsoft') {
        console.log('🔄 Microsoft OAuth user detected - starting auto-check for replies...');
        // Initial check after 10 seconds
        setTimeout(() => autoCheckForReplies(false), 10000);
      }
    }
  }, [user?.token, user?.email]);

  // Periodic reply checking (every 10 minutes) for OAuth users
  useEffect(() => {
    let replyCheckInterval = null;
    
    if (user?.token && (user.provider === 'microsoft' || user.oauth_provider === 'microsoft')) { // Gmail auto-check disabled until CASA
      console.log('🔄 Starting periodic reply check (every 10 minutes)');
      
      replyCheckInterval = setInterval(() => {
        autoCheckForReplies(true); // Show notification on periodic checks
      }, 10 * 60 * 1000); // 10 minutes
    }
    
    // Cleanup on unmount or when user changes
    return () => {
      if (replyCheckInterval) {
        console.log('⏸️ Stopping periodic reply check');
        clearInterval(replyCheckInterval);
      }
    };
  }, [user?.token, user?.provider]);

  // Also load when screen changes to dashboard
  useEffect(() => {
    if (screen === 'dashboard' && user?.token && user?.email) {
      console.log('🔄 Dashboard opened, checking for stored data...');
      loadReviewCoverLettersFromStorage();
      loadApplicationHistoryFromStorage();
    }
  }, [screen]);

  // Load packages when screen changes to 'packages'
  useEffect(() => {
    if (screen === 'packages' && user?.token) {
      const fetchUserPackages = async () => {
        try {
          setLoadingUserPackages(true);
          const response = await fetch(`${API_BASE}/packages`, {
            headers: {
              'Authorization': `Bearer ${user.token}`
            }
          });
          
          if (response.ok) {
            const data = await response.json();
            console.log('Packages response:', data);
            setUserPackages(data.packages || []);
          } else {
            console.error('Failed to fetch packages, status:', response.status);
          }
        } catch (error) {
          console.error('Error fetching packages:', error);
        } finally {
          setLoadingUserPackages(false);
        }
      };
      
      fetchUserPackages();
    }
  }, [screen, user]);

  // Load usage data when screen changes to 'usage' or 'dashboard'
  useEffect(() => {
    if ((screen === 'usage' || screen === 'dashboard') && user?.token) {
      const fetchUsageData = async () => {
        try {
          console.log('📱 [USAGE] Fetching usage data from:', `${API_BASE}/user/usage-stats`);
          setLoadingUsage(true);
          const response = await fetch(`${API_BASE}/user/usage-stats`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${user.token}`,
              'Content-Type': 'application/json',
            }
          });
          
          console.log('📱 [USAGE] Response status:', response.status, response.ok ? 'OK' : 'ERROR');
          
          if (response.ok) {
            const data = await response.json();
            console.log('📱 [USAGE] Response data.success:', data.success);
            console.log('📱 [USAGE] dateWiseActivity length:', data.dateWiseActivity?.length || 0);
            
            if (data.dateWiseActivity && data.dateWiseActivity.length > 0) {
              const nonZero = data.dateWiseActivity.filter(d => d.generated > 0 || d.sent > 0 || d.creditsUsed > 0);
              console.log('📱 [USAGE] Days with non-zero activity:', nonZero.length);
              console.log('📱 [USAGE] Sample data (first 3 days):', JSON.stringify(data.dateWiseActivity.slice(0, 3)));
              console.log('📱 [USAGE] Sample data (last 7 days):', JSON.stringify(data.dateWiseActivity.slice(-7)));
            } else {
              console.log('⚠️ [USAGE] No dateWiseActivity data received!');
            }
            
            if (data.success) {
              setUsageData(data);
              console.log('✅ [USAGE] UsageData state updated');
            }
          } else {
            console.error('❌ [USAGE] Response not OK:', response.status);
          }
        } catch (error) {
          console.error('❌ [USAGE] Failed to load usage data:', error);
        } finally {
          setLoadingUsage(false);
        }
      };
      fetchUsageData();
    }
  }, [screen, user?.token]);

  // Load all notifications when opening notifications screen
  useEffect(() => {
    if (screen === 'notifications' && user?.token) {
      console.log('🔔 Navigated to notifications screen - resetting pagination and loading...');
      // Reset pagination state so we always start from page 1 when re-entering
      notificationsPageRef.current = 0;
      setNotificationsHasMore(false);
      loadAllNotifications(); // Will skip if recently updated (within 5 seconds)
    }
  }, [screen, user?.token]);

  // Check for recipient data changes when entering review screen (runs only once per entry)
  const lastReviewCheckRef = useRef(null);
  
  useEffect(() => {
    // Only check when first entering review screen, not on every state change
    const currentCheckKey = `${screen}_${recipients.map(r => `${r.email}_${r.website}`).join('|')}`;

    if (screen === 'review' && user?.token && recipients.length > 0 && lastReviewCheckRef.current !== currentCheckKey) {
      lastReviewCheckRef.current = currentCheckKey;
      console.log('🔄 Review screen opened, checking if recipient data changed...');

      // Check if any recipient data has changed compared to saved cover letters.
      // IMPORTANT: match by storedRecipientEmail (stable), NOT by array index.
      // Recipients are prepended when added, so their array indices shift — using
      // index-based lookup causes false "data changed" alerts whenever a new company
      // is inserted at the front of the list.
      // Robust normalize: ignore https / www / path / query / trailing-slash differences
      // so we never false-flag "changed" when only the URL FORMAT differs.
      const normalize = (url) => (url || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/\/+$/, '');

      // Collect ONLY recipients whose company website genuinely changed since their letter
      // was generated. CRITICAL: link strictly by the unique clKey — NEVER by email.
      // Matching by email cross-linked companies that share an empty/placeholder email,
      // so it falsely reported "changed" on every single visit. If a recipient isn't
      // reliably linked (no clKey-keyed letter), we simply don't prompt (safe — the user
      // can still regenerate manually) rather than risk a false alarm.
      const changedIndices = [];
      recipients.forEach((recipient, index) => {
        if (!recipient.website || !recipient.clKey) return;
        const saved = reviewCoverLetters[recipient.clKey]
          || Object.values(reviewCoverLetters).find(e => e?.storedRecipientClKey === recipient.clKey);
        if (saved && saved.storedRecipientWebsite
            && normalize(saved.storedRecipientWebsite) !== normalize(recipient.website)) {
          changedIndices.push(index);
        }
      });

      // DO NOT auto-generate (that silently spent credits, sometimes for every recipient,
      // and even after the user cancelled). Ask first; regenerate ONLY the changed
      // letters, and ONLY if the user taps "Regenerate". "Not now" spends nothing.
      if (changedIndices.length > 0) {
        const n = changedIndices.length;
        Alert.alert(
          'Regenerate cover letter?',
          `The company details changed for ${n} application${n === 1 ? '' : 's'}. Regenerate ${n === 1 ? 'it' : 'them'} now? This uses 1 credit each. Tap "Not now" to keep your current letter${n === 1 ? '' : 's'} unchanged.`,
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Regenerate', onPress: () => { changedIndices.forEach((i) => generateCoverLetterForReview(i)); } },
          ]
        );
      }
    }
  }, [screen]);

  // Handle Google OAuth response
  // Function to check if user is admin
  const checkAdminStatus = async (token) => {
    try {
      const response = await fetch(`${API_BASE}/user/is-admin`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      setIsAdmin(data.isAdmin || false);
    } catch (err) {
      console.log('Error checking admin status:', err);
      setIsAdmin(false);
    }
  };

  // Re-check admin status whenever a token is available — covers session restore on
  // app launch and every login path (not just the email-login flow), so the "Admin
  // Panel" menu item appears for admins after reopening the app.
  useEffect(() => {
    if (user?.token) checkAdminStatus(user.token);
  }, [user?.token]);

  // Re-fetch the live credit balance (used by pull-to-refresh + on Home focus, so an
  // admin change or a top-up shows up without restarting the app).
  const refreshCredits = useCallback(async () => {
    try {
      if (!user?.token) return;
      const res = await fetch(`${API_BASE}/user/credits`, { headers: { 'Authorization': `Bearer ${user.token}` } });
      if (!res.ok) return;
      const data = await res.json();
      const bal = (typeof data.balance === 'number') ? data.balance
                : (typeof data.credits === 'number') ? data.credits
                : (typeof data.credits_remaining === 'number') ? data.credits_remaining : null;
      if (bal !== null) setCreditBalance(bal);
    } catch { /* offline — keep current */ }
  }, [user?.token]);

  const handleLogin = async () => {
    if (!email || !password) {
      setError('Please fill in all fields');
      return;
    }
    
    setLoading(true);
    setError('');
    
    try {
      console.log('Attempting login with API_BASE:', API_BASE);
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      
      const data = await response.json();
      console.log('Login Response Status:', response.status);
      console.log('Login Response Data:', data);
      
      if (!response.ok) {
        throw new Error(data.error || data.message || 'Login failed');
      }
      
      // Ensure user object has all required fields including token
      const userData = {
        id: data.user?.id,
        email: data.user?.email,
        fullName: data.user?.fullName || data.user?.name,
        name: data.user?.name || data.user?.fullName,
        token: data.token,
        createdAt: data.user?.createdAt,
        provider: data.user?.provider || 'email',
        oauth_provider: data.user?.oauth_provider || null
      };
      
      console.log('Login User:', userData);
      setUser(userData);
      
      // Check admin status
      await checkAdminStatus(data.token);
      
      setScreen('dashboard');
      setEmail('');
      setPassword('');
    } catch (err) {
      console.log('Login Error:', err.message);
      setError(err.message || 'Network request failed');
      Alert.alert('Login Error', err.message || 'Network request failed');
    } finally {
      setLoading(false);
    }
  };

  // Silent auto-check for replies (no UI updates, runs in background)
  const autoCheckForReplies = async (showNotification = false) => {
    try {
      console.log('🔄 Auto-checking for email replies...');
      const response = await fetch(`${API_BASE}/check-replies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        }
      });

      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Auto-check: Failed to parse response');
        return;
      }

      if (response.ok) {
        const repliesCount = data.repliesFound || 0;
        const notifCount = data.notificationsCreated || 0;
        console.log(`✅ Auto-check complete: ${repliesCount} replies found, ${notifCount} notifications created`);
        
        if (repliesCount > 0 || notifCount > 0) {
          // Refresh application history and notifications silently (no popup)
          await loadApplicationHistoryFromStorage();
          await loadNotifications(true);
        }
      } else {
        console.error('❌ Auto-check error:', data.error || data.message);
      }
    } catch (error) {
      console.error('❌ Auto-check network error:', error);
    }
  };

  // Check for email replies (manual button click)
  const checkEmailReplies = async () => {
    // Gmail auto-reply checking disabled until CASA — show info message
    if (user.provider === 'google' || user.oauth_provider === 'google') {
      Alert.alert(
        'Gmail — Coming Soon',
        'Automatic reply checking currently works only with Microsoft/Outlook email. Gmail feature coming soon.\n\nPlease check your mails manually and tap on the application card to mark it as replied.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      setIsCheckingReplies(true);

      const response = await fetch(`${API_BASE}/check-replies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        }
      });

      // Log response details for debugging
      console.log('Check replies response status:', response.status);
      console.log('Check replies response headers:', response.headers);
      
      // Get response text first to handle non-JSON responses
      const responseText = await response.text();
      console.log('Check replies response text (first 200 chars):', responseText.substring(0, 200));

      // Try to parse as JSON
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Failed to parse response as JSON:', parseError);
        throw new Error(`Server returned invalid response. Status: ${response.status}. Response: ${responseText.substring(0, 100)}`);
      }

      if (response.ok) {
        const hasNew = (data.repliesFound || 0) + (data.notificationsCreated || 0) > 0;

        if (hasNew) {
          // Refresh application history
          await loadApplicationHistoryFromStorage();
        }

        // Always refresh notifications panel after a manual check
        await loadNotifications(true);

        if (hasNew) {
          Alert.alert(
            '✅ Replies Found!',
            data.message,
            [{ text: 'OK' }]
          );
        } else {
          Alert.alert(
            'No New Replies',
            'No replies found yet. Keep checking!',
            [{ text: 'OK' }]
          );
        }
      } else {
        Alert.alert('Error', data.message || data.error || 'Failed to check replies');
      }

    } catch (error) {
      console.error('Check replies error:', error);
      Alert.alert('Error', error.message || 'Failed to check email replies. Please try again.');
    } finally {
      setIsCheckingReplies(false);
    }
  };

  // Fetch all replies for a specific application
  const showAllReplies = async (applicationId, companyName) => {
    try {
      const response = await fetch(`${API_BASE}/users/application-history/${applicationId}/replies`, {
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch replies');
      }

      const result = await response.json();

      if (result.success && result.replies && result.replies.length > 0) {
        setSelectedReplyDetails({
          companyName: result.companyName,
          replies: result.replies,
          count: result.count
        });
        setShowReplyDetailsModal(true);
      } else {
        Alert.alert('Info', 'No replies found', [{ text: 'OK' }]);
      }
    } catch (error) {
      console.error('Error fetching replies:', error);
      Alert.alert('Error', 'Failed to load replies. Please try again.', [{ text: 'OK' }]);
    }
  };

  const handleRegister = async () => {
    if (!fullName || !email || !password) {
      setError('Please fill in all fields');
      return;
    }
    if (!termsAccepted) {
      setError('Please agree to the Terms of Service and Privacy Policy');
      return;
    }
    
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, email, password })
      });
      
      const data = await response.json();
      console.log('Register Response Status:', response.status);
      console.log('Register Response Data:', data);
      
      if (!response.ok) {
        // Backend returns 'error' field for error messages
        throw new Error(data.error || data.message || 'Registration failed');
      }
      
      // Ensure user object has all required fields including token
      const userData = {
        id: data.user?.id,
        email: data.user?.email,
        fullName: data.user?.fullName || data.user?.name,
        name: data.user?.name || data.user?.fullName,
        token: data.token,
        createdAt: data.user?.createdAt,
        provider: data.user?.provider || 'email',
        oauth_provider: data.user?.oauth_provider || null
      };
      
      console.log('Registered User:', userData);
      
      // Clear any cached data from previous sessions
      try {
        const allKeys = await AsyncStorage.getAllKeys();
        const oldUserKeys = allKeys.filter(key => 
          key.startsWith('appCounters_') || 
          key.startsWith('applicationHistory_') || 
          key.startsWith('reviewCoverLetters_') || 
          key.startsWith('recipients_')
        );
        if (oldUserKeys.length > 0) {
          await AsyncStorage.multiRemove(oldUserKeys);
          console.log('🗑️ Cleared cached data from previous sessions');
        }
      } catch (error) {
        console.error('Failed to clear old cache:', error);
      }
      
      // Reset all state to fresh start
      setTotalGenerated(0);
      setTotalSent(0);
      setCreditBalance(0);
      setApplicationHistory([]);
      setReviewCoverLetters({});
      setRecipients([]);
      
      setUser(userData);
      setScreen('dashboard');
      setEmail('');
      setPassword('');
      setFullName('');
    } catch (err) {
      setError(err.message || 'Registration failed');
      Alert.alert('Error', err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    // Clear saved session from SecureStore
    try {
      await SecureStore.deleteItemAsync('userSession');
      console.log('🔑 Cleared saved session');
    } catch (error) {
      console.error('Failed to clear session:', error);
    }
    // Clear all user-specific data from AsyncStorage
    if (user?.email) {
      try {
        await AsyncStorage.removeItem(`appCounters_${user.email}`);
        await AsyncStorage.removeItem(`applicationHistory_${user.email}`);
        // Note: reviewCoverLetters and recipients are NOT wiped on logout —
        // they are reloaded from the backend on next login. Wiping them causes
        // the Home page cards to lose their "Generated ✓" state after sign-in.
        clearHomeScreenCache();
        console.log('🗑️ Cleared user counters/history cache on logout');
      } catch (error) {
        console.error('Failed to clear cache:', error);
      }
    }
    
    // Reset all state
    setUser(null);
    setScreen('login');
    setEmail('');
    setPassword('');
    setFullName('');
    setError('');
    setTotalGenerated(0);
    setTotalSent(0);
    setCreditBalance(0);
    setApplicationHistory([]);
    setReviewCoverLetters({});
    setRecipients([]);
  };

  const handleGoogleAuthResponse = async (code, codeVerifier, redirectUri, useProduction = false) => {
    setLoading(true);
    setError('');
    try {
      console.log('Google Auth Response - Code length:', code?.length || 0);
      console.log('Google Auth Response - Verifier length:', codeVerifier?.length || 0);
      console.log('Google Auth Response - Redirect URI:', redirectUri);
      const apiUrl = __DEV__ ? API_BASE : PRODUCTION_API_URL;
      console.log('API Base:', apiUrl);
      
      // Send authorization code and PKCE verifier to backend for token exchange
      const response = await fetch(`${apiUrl}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          code, 
          codeVerifier,
          redirectUri, // actual redirectUri used for auth — needed for token exchange
          isMobile: true,
          platform: Platform.OS,
        })
      });

      console.log('Backend Response Status:', response.status);
      const data = await safeResponseJson(response);
      console.log('Backend Response Data:', data);

      if (!response.ok || data.error) {
        throw new Error(data.error || 'Google login failed');
      }

      // Store user data with token
      setUser({
        ...data.user,
        token: data.token
      });
      setScreen('dashboard');
      Alert.alert('Success', `Welcome ${data.user.fullName}!`);
    } catch (err) {
      console.log('Google Login Error:', err.message);
      setError(err.message || 'Google login failed');
      Alert.alert('Login Failed', err.message || 'Google login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleMicrosoftAuthResponse = async (code, codeVerifier, redirectUri) => {
    setLoading(true);
    setError('');
    try {
      console.log('Microsoft Auth Response - Code length:', code?.length || 0);
      const apiUrl = __DEV__ ? API_BASE : PRODUCTION_API_URL;
      console.log('API Base:', apiUrl);
      
      // Send authorization code + PKCE verifier to backend for token exchange
      const response = await fetch(`${apiUrl}/auth/microsoft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri })
      });

      console.log('Backend Response Status:', response.status);
      const data = await safeResponseJson(response);
      console.log('Backend Response Data:', data);

      if (!response.ok || data.error) {
        throw new Error(data.error || 'Microsoft login failed');
      }

      // Store user data with token
      setUser({
        ...data.user,
        token: data.token
      });
      setScreen('dashboard');
      Alert.alert('Success', `Welcome ${data.user.fullName}!`);
    } catch (err) {
      console.log('Microsoft Login Error:', err.message);
      setError(err.message || 'Microsoft login failed');
      Alert.alert('Error', err.message || 'Microsoft login failed');
    } finally {
      setLoading(false);
    }
  };

  // ==========================================
  // ANDROID Google OAuth — Passport-mediated flow
  // Opens the server's /auth/google/mobile endpoint in Chrome Custom Tab.
  // Server handles everything via Passport (initiates OAuth, validates callback, exchanges tokens).
  // Server redirects to cvapplyr://oauth-success?token=...&user=... deep link.
  // The existing Linking handler (handleDeepLink) picks up the token and logs in the user.
  // ==========================================
  const handleGoogleLoginAndroid = async () => {
    try {
      setLoading(true);
      console.log('Android: Opening Google OAuth via Passport server flow...');
      const authUrl = `${AUTH_SERVER_URL}/auth/google/mobile`;
      console.log('Android: Auth URL:', authUrl);
      const result = await WebBrowser.openAuthSessionAsync(authUrl, 'cvapplyr://');
      console.log('Android: Auth result type:', result.type);
      if (result.type === 'success' && result.url) {
        console.log('Android: Deep link received:', result.url.substring(0, 80));
        // The handleDeepLink useEffect listener will handle cvapplyr://oauth-success?token=...&user=...
        // But also handle it here in case the Linking listener doesn't fire
        const urlObj = new URL(result.url);
        const token = urlObj.searchParams.get('token');
        const userStr = urlObj.searchParams.get('user');
        if (token && userStr) {
          const userData = JSON.parse(decodeURIComponent(userStr));
          console.log('Android: Google auth complete, user:', userData.email);
          setUser({ ...userData, token });
          setScreen('dashboard');
          Alert.alert('Success', `Welcome ${userData.fullName}!`);
        } else {
          // Check for error
          const error = urlObj.searchParams.get('error');
          if (error) {
            Alert.alert('OAuth Error', error);
          } else {
            console.log('Android: No token in deep link, Linking handler will pick it up');
          }
        }
      } else if (result.type === 'cancel' || result.type === 'dismiss') {
        console.log('Android: Google login cancelled/dismissed');
      } else {
        console.log('Android: Unexpected result type:', result.type);
      }
    } catch (err) {
      console.error('Android Google login error:', err);
      Alert.alert('Error', 'Google login failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // ==========================================
  // iOS Google OAuth — Direct PKCE flow
  // Uses expo-auth-session to build auth URL, WebBrowser.openAuthSessionAsync to open it
  // Reverse client ID scheme lets ASWebAuthenticationSession intercept Google's redirect
  // ==========================================
  const handleGoogleLoginIOS = async () => {
    if (!googleRequest) {
      Alert.alert('Please wait', 'Google login is initializing, try again in a moment.');
      return;
    }
    console.log('iOS: Opening Google auth session directly...');
    console.log('iOS: Auth URL:', googleRequest.url?.substring(0, 120));
    console.log('iOS: Redirect URI:', googleRequest.redirectUri);
    console.log('iOS: Code verifier length:', googleRequest.codeVerifier?.length);
    try {
      let authUrl = googleRequest.url;
      if (!authUrl) {
        authUrl = await googleRequest.makeAuthUrlAsync({
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        });
      }
      const result = await WebBrowser.openAuthSessionAsync(authUrl, googleRequest.redirectUri);
      console.log('iOS: Auth session result type:', result.type);
      if (result.type === 'success' && result.url) {
        console.log('iOS: Success URL received, parsing code...');
        const urlObj = new URL(result.url);
        const code = urlObj.searchParams.get('code');
        if (code) {
          console.log('iOS: Got authorization code, exchanging...');
          handleGoogleAuthResponse(code, googleRequest.codeVerifier, googleRequest.redirectUri);
        } else {
          Alert.alert('OAuth Error', 'No authorization code in response URL');
        }
      } else if (result.type === 'cancel' || result.type === 'dismiss') {
        console.log('iOS: Google login cancelled/dismissed');
      } else {
        console.log('iOS: Unexpected result type:', result.type);
      }
    } catch (err) {
      console.error('iOS Google login error:', err);
      Alert.alert('Google Login Error', err.message);
    }
  };

  // ==========================================
  // Unified handler — dispatches to the correct platform flow
  // ==========================================
  const handleGoogleLogin = async () => {
    if (Platform.OS === 'android') {
      return handleGoogleLoginAndroid();
    }
    return handleGoogleLoginIOS();
  };

  // ==========================================
  // Link Google Account (for Apple Sign-In users to enable Gmail sending)
  // Reuses PKCE auth flow but sends code to /auth/link-google with JWT
  // ==========================================
  const handleLinkGoogle = async () => {
    if (!googleRequest) {
      Alert.alert('Please wait', 'Google login is initializing, try again in a moment.');
      return;
    }
    try {
      let authUrl = googleRequest.url;
      if (!authUrl) {
        authUrl = await googleRequest.makeAuthUrlAsync({
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        });
      }
      const result = await WebBrowser.openAuthSessionAsync(authUrl, googleRequest.redirectUri);
      if (result.type === 'success' && result.url) {
        const urlObj = new URL(result.url);
        const code = urlObj.searchParams.get('code');
        if (code) {
          setLoading(true);
          const response = await fetch(`${API_BASE}/auth/link-google`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${userRef.current?.token}`,
            },
            body: JSON.stringify({
              code,
              codeVerifier: googleRequest.codeVerifier,
              redirectUri: googleRequest.redirectUri,
              platform: Platform.OS,
            }),
          });
          const data = await safeResponseJson(response);
          setLoading(false);
          if (response.ok && !data.error) {
            setUser(prev => ({ ...prev, oauth_provider: 'google', needsEmailConnect: false }));
            Alert.alert('Connected!', data.message || 'Google account linked. Emails will be sent from your Gmail.');
          } else {
            Alert.alert('Error', data.error || 'Failed to connect Google account');
          }
        }
      }
    } catch (err) {
      setLoading(false);
      console.error('Link Google error:', err);
      Alert.alert('Error', err.message || 'Failed to connect Google account');
    }
  };

  // ==========================================
  // Link Microsoft Account (for Apple Sign-In users to enable Outlook sending)
  // Uses same Microsoft OAuth flow but sends token to /auth/link-microsoft with JWT
  // ==========================================
  const handleLinkMicrosoft = async () => {
    try {
      const redirectUri = `msauth://com.cvapplyr.app/callback`;
      const pkce = await generatePKCE();
      const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
        `client_id=${MICROSOFT_CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent('user.read Mail.Read Mail.Send offline_access')}` +
        `&response_mode=query` +
        `&prompt=select_account` +
        `&code_challenge=${pkce.challenge}` +
        `&code_challenge_method=S256`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);

      if (result.type === 'success') {
        const url = result.url;
        const codeMatch = url.match(/[?&]code=([^&]+)/);

        if (codeMatch && codeMatch[1]) {
          const code = decodeURIComponent(codeMatch[1]);
          setLoading(true);
          const response = await fetch(`${API_BASE}/auth/link-microsoft`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${userRef.current?.token}`,
            },
            body: JSON.stringify({ code, codeVerifier: pkce.verifier, redirectUri }),
          });
          const data = await response.json();
          setLoading(false);
          if (response.ok) {
            setUser(prev => ({ ...prev, oauth_provider: 'microsoft', needsEmailConnect: false }));
            Alert.alert('Connected!', data.message || 'Microsoft account linked. Emails will be sent from your Outlook.');
          } else {
            Alert.alert('Error', data.error || 'Failed to connect Microsoft account');
          }
        } else {
          Alert.alert('Error', 'No authorization code received from Microsoft');
        }
      } else if (result.type === 'cancel') {
        console.log('Microsoft link cancelled by user');
      }
    } catch (err) {
      setLoading(false);
      console.error('Link Microsoft error:', err);
      Alert.alert('Error', err.message || 'Failed to connect Microsoft account');
    }
  };

  // ==========================================
  // Revoke linked email provider (Google/Microsoft)
  // ==========================================
  const handleRevokeEmailProvider = () => {
    const providerName = user?.oauth_provider === 'google' ? 'Gmail' : 'Outlook';
    Alert.alert(
      'Revoke Access',
      `Are you sure you want to disconnect your ${providerName} account?\n\nEmails will no longer be sent from your personal address.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              setLoading(true);
              const response = await fetch(`${API_BASE}/auth/revoke-email-provider`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${userRef.current?.token}`,
                },
              });
              const data = await response.json();
              setLoading(false);
              if (response.ok) {
                setUser(prev => ({ ...prev, oauth_provider: null, provider: null }));
                Alert.alert('Revoked', data.message || `${providerName} access has been revoked.`);
              } else {
                Alert.alert('Error', data.error || 'Failed to revoke access');
              }
            } catch (err) {
              setLoading(false);
              console.error('Revoke error:', err);
              Alert.alert('Error', err.message || 'Failed to revoke access');
            }
          },
        },
      ]
    );
  };

  // ==========================================
  // Apple Sign-In — iOS only (native ASAuthorizationController)
  // Uses expo-apple-authentication; sends identity token to backend for verification
  // ==========================================
  const handleAppleLogin = async () => {
    if (Platform.OS !== 'ios') {
      Alert.alert('Not Available', 'Sign in with Apple is only available on iOS.');
      return;
    }

    // Show important notice before Apple Sign-In dialog
    return new Promise((resolve) => {
      Alert.alert(
        '📧 Important: Share Your Email',
        'On the next screen, Apple will ask how you want to share your email.\n\nPlease select "Share My Email" — this app sends job applications on your behalf, so employers need your real email address to reply to you.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
          { text: 'Continue', style: 'default', onPress: () => {
            resolve(performAppleLogin());
          }},
        ]
      );
    });
  };

  const performAppleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      console.log('Apple Sign-In credential received:', {
        user: credential.user?.substring(0, 10) + '...',
        email: credential.email,
        fullName: credential.fullName,
        hasIdentityToken: !!credential.identityToken,
      });

      if (!credential.identityToken) {
        throw new Error('No identity token received from Apple');
      }

      // Apple only sends fullName on the FIRST sign-in — cache it locally
      let fullName = credential.fullName;
      const appleUserId = credential.user;
      if (fullName && (fullName.givenName || fullName.familyName)) {
        await AsyncStorage.setItem(`apple_fullName_${appleUserId}`, JSON.stringify(fullName));
      } else {
        // Try to recover cached name from a previous sign-in
        try {
          const cached = await AsyncStorage.getItem(`apple_fullName_${appleUserId}`);
          if (cached) {
            fullName = JSON.parse(cached);
            console.log('Recovered cached Apple fullName:', fullName);
          }
        } catch (e) { /* ignore */ }
      }

      // Send identity token to backend for verification and user creation/login
      const response = await fetch(`${API_BASE}/auth/apple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identityToken: credential.identityToken,
          authorizationCode: credential.authorizationCode,
          email: credential.email,
          fullName: fullName,
        }),
      });

      const data = await safeResponseJson(response);
      console.log('Apple backend response status:', response.status);
      console.log('Apple backend response:', JSON.stringify(data));

      if (!response.ok || data.error) {
        throw new Error(data.details || data.error || 'Apple login failed');
      }

      setUser({ ...data.user, token: data.token });
      setScreen('dashboard');

      // If Apple used private relay email, force user to provide real email before proceeding
      if (data.user.needsProfileUpdate) {
        setCompleteProfileEmail('');
        setCompleteProfileName(data.user.fullName === 'Apple User' ? '' : data.user.fullName || '');
        setTimeout(() => setShowCompleteProfileModal(true), 300);
      } else if (data.user.needsEmailConnect) {
        // User signed in with Apple but has no Google/Microsoft tokens for sending emails
        setTimeout(() => {
          Alert.alert(
            'Connect Your Email',
            'You signed in with Apple, but to send job applications from your own email address, you need to connect your Gmail or Outlook account.\n\nWithout this, emails will be sent from our system address instead of yours.',
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Connect Outlook', onPress: () => {
                handleLinkMicrosoft();
              }},
              { text: 'Connect Google', onPress: () => {
                handleLinkGoogle();
              }},
            ]
          );
        }, 500);
      } else {
        Alert.alert('Success', `Welcome ${data.user.fullName}!`);
      }
    } catch (err) {
      if (err.code === 'ERR_REQUEST_CANCELED') {
        console.log('Apple Sign-In cancelled by user');
      } else {
        console.error('Apple Sign-In error:', err);
        setError(err.message || 'Apple login failed');
        Alert.alert('Error', err.message || 'Apple login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleMicrosoftLogin = async () => {
    setLoading(true);
    try {
      const isAndroid = Platform.OS === 'android';
      
      if (isAndroid) {
        // Android: Passport-mediated flow via Chrome Custom Tab
        // Server initiates OAuth, handles callback, redirects to auth-success.html
        // auth-success.html detects mobile and redirects to cvapplyr://oauth-success?token=...&user=...
        console.log('Android: Opening Microsoft OAuth via Passport server flow...');
        const authUrl = `${AUTH_SERVER_URL}/auth/microsoft`;
        const result = await WebBrowser.openAuthSessionAsync(authUrl, 'cvapplyr://');
        console.log('Android: Microsoft auth result type:', result.type);
        if (result.type === 'success' && result.url) {
          console.log('Android: Microsoft deep link received:', result.url.substring(0, 80));
          const urlObj = new URL(result.url);
          const token = urlObj.searchParams.get('token');
          const userStr = urlObj.searchParams.get('user');
          if (token && userStr) {
            const userData = JSON.parse(decodeURIComponent(userStr));
            console.log('Android: Microsoft auth complete, user:', userData.email);
            setUser({ ...userData, token });
            setScreen('dashboard');
            Alert.alert('Success', `Welcome ${userData.fullName}!`);
          } else {
            const error = urlObj.searchParams.get('error');
            if (error) {
              Alert.alert('OAuth Error', error);
            }
          }
        } else if (result.type === 'cancel' || result.type === 'dismiss') {
          setError('Microsoft login cancelled');
        }
      } else {
        // iOS: Direct PKCE flow with msauth:// scheme
        const redirectUri = `msauth://com.cvapplyr.app/callback`;
        const pkce = await generatePKCE();
        const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
          `client_id=${MICROSOFT_CLIENT_ID}` +
          `&response_type=code` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent('user.read Mail.Read Mail.Send offline_access')}` +
          `&response_mode=query` +
          `&prompt=select_account` +
          `&code_challenge=${pkce.challenge}` +
          `&code_challenge_method=S256`;
        
        console.log('iOS: Opening Microsoft auth URL...');
        console.log('iOS: Microsoft redirect URI:', redirectUri);
        const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
        
        console.log('iOS: Microsoft auth result type:', result.type);
        
        if (result.type === 'success') {
          const url = result.url;
          console.log('iOS: Microsoft result URL:', url?.substring(0, 80));
          const codeMatch = url.match(/[?&]code=([^&]+)/);
          
          if (codeMatch && codeMatch[1]) {
            const code = decodeURIComponent(codeMatch[1]);
            console.log('iOS: Microsoft authorization code received');
            await handleMicrosoftAuthResponse(code, pkce.verifier, redirectUri);
          } else {
            throw new Error('No authorization code received from Microsoft');
          }
        } else if (result.type === 'cancel') {
          setError('Microsoft login cancelled');
        }
      }
    } catch (err) {
      console.error('Microsoft login error:', err);
      setError('Microsoft login failed: ' + err.message);
      Alert.alert('Error', 'Microsoft login failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Show splash screen overlay on top of login (so login is already rendered behind)
  const splashOverlay = showSplash ? <SplashScreen onFinish={() => setShowSplash(false)} /> : null;

  // LOGIN SCREEN
  if (screen === 'login') {
    return (
      <SafeAreaViewContext style={{ flex: 1, backgroundColor: '#06091B' }} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent={true} />
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={{ flex: 1, paddingHorizontal: 11, paddingTop: 8, paddingBottom: 0 }}>
            {/* Hero card */}
            <View style={{ height: 220, borderRadius: 18, overflow: 'hidden', marginBottom: 12 }}>
              <Animated.View style={{
                position: 'absolute', top: -15, left: -20, right: -20, bottom: -60,
                transform: [
                  { scale: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [1.0, 1.10] }) },
                  { translateX: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) },
                  { translateY: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 8] }) },
                ]
              }}>
                <Image source={require('./assets/images/login_hero.jpg')} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </Animated.View>
              <LinearGradient
                colors={['rgba(7,10,28,0.10)', 'rgba(7,10,28,0.15)', 'rgba(7,10,28,0.80)']}
                locations={[0, 0.5, 1]}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              />
              <View style={{ position: 'absolute', top: 14, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(13,18,38,0.55)', borderWidth: 0.5, borderColor: 'rgba(91,149,255,0.2)', borderRadius: 12, paddingVertical: 7, paddingHorizontal: 13 }}>
                  <Image source={require('./assets/images/logo_img_white.png')} style={{ width: 22, height: 22 }} resizeMode="contain" />
                  <Text style={{ fontSize: 18, fontWeight: '600' }}>
                    <Text style={{ color: '#ffffff' }}>cv</Text><Text style={{ color: '#5B95FF' }}>applyr</Text>
                  </Text>
                </View>
                <View style={{ backgroundColor: 'rgba(13,18,38,0.55)', borderWidth: 0.5, borderColor: 'rgba(160,180,220,0.18)', borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Ionicons name="star" size={11} color="#FFC857" />
                  <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 11 }}>4.9</Text>
                  <Text style={{ color: '#8995AC', fontSize: 11 }}> · 70+</Text>
                </View>
              </View>
              <View style={{ position: 'absolute', bottom: 14, left: 14, right: 14 }}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: '#ffffff', lineHeight: 20, marginBottom: 8 }}>
                  Job hunting, but you're <Text style={{ color: '#5B95FF' }}>actually winning.</Text>
                </Text>
                <View style={{ height: 0.5, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 7 }} />
                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 15 }}>
                  <Text style={{ color: '#5B95FF', fontWeight: '600' }}>Pro tip · </Text>{proTipText}<Text style={{ color: '#5B95FF' }}>|</Text>
                </Text>
              </View>
            </View>

            {/* Form card — flex:1 fills remaining screen space */}
            <View style={{ flex: 1, backgroundColor: '#0E1430', borderWidth: 0.5, borderColor: '#1F2A4A', borderRadius: 18, padding: 16 }}>
              <Text style={{ fontSize: 20, fontWeight: '500', color: '#ffffff', marginBottom: 3, letterSpacing: -0.3 }}>
                Sign in to your <Text style={{ color: '#5B95FF' }}>career copilot.</Text>
              </Text>
              <Text style={{ fontSize: 15, color: '#8995AC', marginBottom: 14 }}>Pick up where you left off.</Text>

              {error ? (
                <View style={{ backgroundColor: 'rgba(239,68,68,0.12)', borderRadius: 10, borderLeftWidth: 3, borderLeftColor: '#ef4444', padding: 10, marginBottom: 13 }}>
                  <Text style={{ fontSize: 13, color: '#fecaca' }}>{error}</Text>
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 13 }}>
                <TouchableOpacity style={styles.newSocBtn} onPress={handleGoogleLogin} disabled={loading} activeOpacity={0.7}>
                  <Image source={require('./assets/images/google.png')} style={{ width: 22, height: 22 }} resizeMode="contain" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.newSocBtn} onPress={handleAppleLogin} disabled={loading} activeOpacity={0.7}>
                  <Ionicons name="logo-apple" size={22} color="#ffffff" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.newSocBtn} onPress={() => handleMicrosoftLogin()} disabled={loading} activeOpacity={0.7}>
                  <Image source={require('./assets/images/microsoft.png')} style={{ width: 20, height: 20 }} resizeMode="contain" />
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                <View style={{ flex: 1, height: 0.5, backgroundColor: '#1F2A4A' }} />
                <Text style={{ fontSize: 11, color: '#6A748A', letterSpacing: 1.4, fontWeight: '500' }}>OR EMAIL</Text>
                <View style={{ flex: 1, height: 0.5, backgroundColor: '#1F2A4A' }} />
              </View>

              <View style={[styles.newInputWrap, { marginBottom: 10 }]}>
                <Ionicons name="mail-outline" size={16} color="#6A748A" />
                <TextInput
                  style={styles.newInput}
                  placeholder="you@company.com"
                  value={email}
                  onChangeText={setEmail}
                  editable={!loading}
                  keyboardType="email-address"
                  placeholderTextColor="#5D6781"
                  autoCapitalize="none"
                />
              </View>

              <View style={[styles.newInputWrap, { marginBottom: 6, justifyContent: 'space-between' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <Ionicons name="lock-closed-outline" size={16} color="#6A748A" />
                  <TextInput
                    style={[styles.newInput, { flex: 1 }]}
                    placeholder="Password"
                    value={password}
                    onChangeText={setPassword}
                    editable={!loading}
                    secureTextEntry={!showLoginPassword}
                    placeholderTextColor="#5D6781"
                    autoCapitalize="none"
                  />
                </View>
                <TouchableOpacity onPress={() => setShowLoginPassword(!showLoginPassword)}>
                  <Text style={{ fontSize: 12, color: '#5B95FF', fontWeight: '500', letterSpacing: 0.8 }}>{showLoginPassword ? 'HIDE' : 'SHOW'}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={{ alignSelf: 'flex-end', marginBottom: 12 }} onPress={() => Alert.alert('Reset Password', 'Please contact support@cvapplyr.com to reset your password.')}>
                <Text style={{ fontSize: 14, color: '#5B95FF', fontWeight: '500' }}>Forgot password?</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 14 }} onPress={() => setRememberMe(!rememberMe)} activeOpacity={0.7}>
                <View style={{ width: 15, height: 15, backgroundColor: rememberMe ? '#3D7EFC' : 'transparent', borderRadius: 3, borderWidth: rememberMe ? 0 : 1, borderColor: '#5D6781', alignItems: 'center', justifyContent: 'center' }}>
                  {rememberMe && <Ionicons name="checkmark" size={10} color="#fff" />}
                </View>
                <Text style={{ fontSize: 14, color: '#B6BFD3' }}>Remember me</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{ height: 58, borderRadius: 13, backgroundColor: '#3D7EFC', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: loading ? 0.6 : 1, marginBottom: 13 }}
                onPress={handleLogin}
                disabled={loading}
                activeOpacity={0.85}
              >
                <Text style={{ fontSize: 16, fontWeight: '500', color: '#fff' }}>{loading ? 'Signing in...' : 'Sign in'}</Text>
                {!loading && <Ionicons name="arrow-forward" size={19} color="#fff" />}
              </TouchableOpacity>

              <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ fontSize: 13, color: '#8995AC' }}>New here? </Text>
                <TouchableOpacity onPress={() => { setScreen('register'); setError(''); }}>
                  <Text style={{ fontSize: 13, color: '#5B95FF', fontWeight: '500' }}>Create account →</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
        {splashOverlay}
      </SafeAreaViewContext>
    );
  }

  // REGISTER SCREEN
  if (screen === 'register') {
    return (
      <SafeAreaViewContext style={{ flex: 1, backgroundColor: '#06091B' }} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent={true} />
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={{ flex: 1, paddingHorizontal: 11, paddingTop: 8, paddingBottom: 0 }}>
            {/* Hero card */}
            <View style={{ height: 220, borderRadius: 18, overflow: 'hidden', marginBottom: 12 }}>
              <Animated.View style={{
                position: 'absolute', top: -15, left: -20, right: -20, bottom: -60,
                transform: [
                  { scale: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [1.0, 1.10] }) },
                  { translateX: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) },
                  { translateY: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 8] }) },
                ]
              }}>
                <Image source={require('./assets/images/login_hero.jpg')} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </Animated.View>
              <LinearGradient
                colors={['rgba(7,10,28,0.10)', 'rgba(7,10,28,0.15)', 'rgba(7,10,28,0.80)']}
                locations={[0, 0.5, 1]}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              />
              <View style={{ position: 'absolute', top: 14, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(13,18,38,0.55)', borderWidth: 0.5, borderColor: 'rgba(91,149,255,0.2)', borderRadius: 12, paddingVertical: 7, paddingHorizontal: 13 }}>
                  <Image source={require('./assets/images/logo_img_white.png')} style={{ width: 22, height: 22 }} resizeMode="contain" />
                  <Text style={{ fontSize: 18, fontWeight: '600' }}>
                    <Text style={{ color: '#ffffff' }}>cv</Text><Text style={{ color: '#5B95FF' }}>applyr</Text>
                  </Text>
                </View>
                <View style={{ backgroundColor: 'rgba(13,18,38,0.55)', borderWidth: 0.5, borderColor: 'rgba(160,180,220,0.18)', borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Ionicons name="star" size={11} color="#FFC857" />
                  <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 11 }}>4.9</Text>
                  <Text style={{ color: '#8995AC', fontSize: 11 }}> · 70+</Text>
                </View>
              </View>
              <View style={{ position: 'absolute', bottom: 14, left: 14, right: 14 }}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: '#ffffff', lineHeight: 20, marginBottom: 8 }}>
                  Job hunting, but you're <Text style={{ color: '#5B95FF' }}>actually winning.</Text>
                </Text>
                <View style={{ height: 0.5, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 7 }} />
                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 15 }}>
                  <Text style={{ color: '#5B95FF', fontWeight: '600' }}>Pro tip · </Text>{proTipText}<Text style={{ color: '#5B95FF' }}>|</Text>
                </Text>
              </View>
            </View>

            {/* Form card — flex:1 fills remaining screen space */}
            <View style={{ flex: 1, backgroundColor: '#0E1430', borderWidth: 0.5, borderColor: '#1F2A4A', borderRadius: 18, padding: 16 }}>
              <Text style={{ fontSize: 20, fontWeight: '500', color: '#ffffff', marginBottom: 3, letterSpacing: -0.3 }}>
                Create your <Text style={{ color: '#5B95FF' }}>account.</Text>
              </Text>
              <Text style={{ fontSize: 15, color: '#8995AC', marginBottom: 14 }}>Auto-apply to roles on your behalf.</Text>

              {error ? (
                <View style={{ backgroundColor: 'rgba(239,68,68,0.12)', borderRadius: 10, borderLeftWidth: 3, borderLeftColor: '#ef4444', padding: 10, marginBottom: 13 }}>
                  <Text style={{ fontSize: 13, color: '#fecaca' }}>{error}</Text>
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 13 }}>
                <TouchableOpacity style={styles.newSocBtn} onPress={handleGoogleLogin} disabled={loading} activeOpacity={0.7}>
                  <Image source={require('./assets/images/google.png')} style={{ width: 22, height: 22 }} resizeMode="contain" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.newSocBtn} onPress={handleAppleLogin} disabled={loading} activeOpacity={0.7}>
                  <Ionicons name="logo-apple" size={22} color="#ffffff" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.newSocBtn} onPress={() => handleMicrosoftLogin()} disabled={loading} activeOpacity={0.7}>
                  <Image source={require('./assets/images/microsoft.png')} style={{ width: 20, height: 20 }} resizeMode="contain" />
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                <View style={{ flex: 1, height: 0.5, backgroundColor: '#1F2A4A' }} />
                <Text style={{ fontSize: 11, color: '#6A748A', letterSpacing: 1.4, fontWeight: '500' }}>OR EMAIL</Text>
                <View style={{ flex: 1, height: 0.5, backgroundColor: '#1F2A4A' }} />
              </View>

              <View style={[styles.newInputWrap, { marginBottom: 10 }]}>
                <Ionicons name="person-outline" size={16} color="#6A748A" />
                <TextInput
                  style={styles.newInput}
                  placeholder="Full name"
                  value={fullName}
                  onChangeText={setFullName}
                  editable={!loading}
                  placeholderTextColor="#5D6781"
                  autoCapitalize="words"
                />
              </View>

              <View style={[styles.newInputWrap, { marginBottom: 10 }]}>
                <Ionicons name="mail-outline" size={16} color="#6A748A" />
                <TextInput
                  style={styles.newInput}
                  placeholder="Work email"
                  value={email}
                  onChangeText={setEmail}
                  editable={!loading}
                  keyboardType="email-address"
                  placeholderTextColor="#5D6781"
                  autoCapitalize="none"
                />
              </View>

              <View style={[styles.newInputWrap, { marginBottom: 14, justifyContent: 'space-between' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <Ionicons name="lock-closed-outline" size={16} color="#6A748A" />
                  <TextInput
                    style={[styles.newInput, { flex: 1 }]}
                    placeholder="Password (min. 6)"
                    value={password}
                    onChangeText={setPassword}
                    editable={!loading}
                    secureTextEntry={!showRegisterPassword}
                    placeholderTextColor="#5D6781"
                    autoCapitalize="none"
                  />
                </View>
                <TouchableOpacity onPress={() => setShowRegisterPassword(!showRegisterPassword)}>
                  <Text style={{ fontSize: 12, color: '#5B95FF', fontWeight: '500', letterSpacing: 0.8 }}>{showRegisterPassword ? 'HIDE' : 'SHOW'}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginBottom: 14 }}
                onPress={() => setTermsAccepted(!termsAccepted)}
                activeOpacity={0.7}
              >
                <View style={{ width: 15, height: 15, backgroundColor: termsAccepted ? '#3D7EFC' : 'transparent', borderRadius: 3, borderWidth: termsAccepted ? 0 : 1, borderColor: '#5D6781', alignItems: 'center', justifyContent: 'center', marginTop: 1, flexShrink: 0 }}>
                  {termsAccepted && <Ionicons name="checkmark" size={10} color="#fff" />}
                </View>
                <Text style={{ fontSize: 14, color: '#B6BFD3', lineHeight: 20, flex: 1 }}>
                  {'I agree to the '}
                  <Text style={{ color: '#5B95FF', fontWeight: '500' }} onPress={() => Linking.openURL('https://cvapplyr.com/terms-of-service')}>Terms</Text>
                  {' & '}
                  <Text style={{ color: '#5B95FF', fontWeight: '500' }} onPress={() => Linking.openURL('https://cvapplyr.com/privacy-policy')}>Privacy</Text>
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{ height: 58, borderRadius: 13, backgroundColor: '#3D7EFC', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: loading ? 0.6 : 1, marginBottom: 13 }}
                onPress={handleRegister}
                disabled={loading}
                activeOpacity={0.85}
              >
                <Text style={{ fontSize: 16, fontWeight: '500', color: '#fff' }}>{loading ? 'Creating account...' : 'Create account'}</Text>
                {!loading && <Ionicons name="arrow-forward" size={19} color="#fff" />}
              </TouchableOpacity>

              <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ fontSize: 13, color: '#8995AC' }}>Have an account? </Text>
                <TouchableOpacity onPress={() => { setScreen('login'); setError(''); }}>
                  <Text style={{ fontSize: 13, color: '#5B95FF', fontWeight: '500' }}>Sign in →</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </SafeAreaViewContext>
    );
  }

  // DASHBOARD/RECIPIENTS SCREEN
  // Complete Profile Modal for Apple Sign-In users with private relay email
  const renderCompleteProfileModal = () => (
    <Modal visible={showCompleteProfileModal} animationType="slide" transparent={true}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 24, width: '85%', maxWidth: 400 }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: '#1a1a2e', textAlign: 'center', marginBottom: 8 }}>Complete Your Profile</Text>
          <Text style={{ fontSize: 14, color: '#6b7280', textAlign: 'center', marginBottom: 20 }}>
            Apple Sign-In used a private relay email. Please provide your real email address — it's required for sending applications to employers.
          </Text>
          
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 }}>Full Name *</Text>
          <TextInput
            style={{ borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 16, color: '#1a1a2e' }}
            placeholder="Enter your full name"
            placeholderTextColor="#9CA3AF"
            value={completeProfileName}
            onChangeText={setCompleteProfileName}
            autoCapitalize="words"
          />
          
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 }}>Email Address *</Text>
          <TextInput
            style={{ borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 20, color: '#1a1a2e' }}
            placeholder="your.real@email.com"
            placeholderTextColor="#9CA3AF"
            value={completeProfileEmail}
            onChangeText={setCompleteProfileEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          
          <TouchableOpacity
            style={{ backgroundColor: (!completeProfileEmail.includes('@') || !completeProfileName.trim()) ? '#d1d5db' : '#0d9488', borderRadius: 10, padding: 14, alignItems: 'center' }}
            disabled={!completeProfileEmail.includes('@') || !completeProfileName.trim()}
            onPress={async () => {
              try {
                const response = await fetch(`${API_BASE}/users/profile/update`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${user.token}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ fullName: completeProfileName.trim(), email: completeProfileEmail.trim() }),
                });
                if (response.ok) {
                  setUser({ ...user, fullName: completeProfileName.trim(), email: completeProfileEmail.trim(), name: completeProfileName.trim() });
                  setProfileData(prev => ({ ...prev, fullName: completeProfileName.trim(), email: completeProfileEmail.trim() }));
                  setShowCompleteProfileModal(false);
                  setScreen('dashboard');
                  Alert.alert('Welcome!', `Profile updated successfully.`);
                } else {
                  const err = await response.json();
                  Alert.alert('Error', err.error || 'Failed to update profile');
                }
              } catch (e) {
                Alert.alert('Error', e.message || 'Network error');
              }
            }}
          >
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Continue</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  if (screen === 'dashboard' || !screen || screen === '') {
    return (
      <HomeScreen
        user={user}
        creditBalance={creditBalance}
        refreshCredits={refreshCredits}
        unreadCount={unreadCount}
        totalSent={totalSent}
        totalGenerated={totalGenerated}
        totalReplied={totalReplied}
        recipients={recipients}
        applicationHistory={applicationHistory}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        showNotifications={showNotifications}
        setShowNotifications={setShowNotifications}
        notifications={notifications}
        loadingNotifications={loadingNotifications}
        isCheckingReplies={isCheckingReplies}
        showReplyDatePicker={showReplyDatePicker}
        setShowReplyDatePicker={setShowReplyDatePicker}
        selectedReplyDate={selectedReplyDate}
        setSelectedReplyDate={setSelectedReplyDate}
        selectedReplyDateRef={selectedReplyDateRef}
        replyAppId={replyAppId}
        setReplyAppId={setReplyAppId}
        showReplyDetailsModal={showReplyDetailsModal}
        setShowReplyDetailsModal={setShowReplyDetailsModal}
        selectedReplyDetails={selectedReplyDetails}
        isAdmin={isAdmin}
        handleReview={handleReview}
        handleAutoStart={() => {
          if (validateAllRecipients()) {
            setCurrentReviewTab(0);
            setScreen('review');
            setTimeout(() => generateAndSendAllApplications(), 600);
          }
        }}
        addRecipient={addRecipient}
        removeRecipient={removeRecipient}
        updateRecipient={updateRecipient}
        checkEmailReplies={checkEmailReplies}
        loadNotifications={loadNotifications}
        markNotificationAsRead={markNotificationAsRead}
        showAllReplies={showAllReplies}
        handleLogout={handleLogout}
        onRateApp={() => setShowRateApp(true)}
        isValidEmail={isValidEmail}
        getTimeAgo={getTimeAgo}
        setScreen={setScreen}
        renderCompleteProfileModal={renderCompleteProfileModal}
        API_BASE={API_BASE}
        userRef={userRef}
        setApplicationHistory={setApplicationHistory}
        setTotalReplied={setTotalReplied}
        usageData={usageData}
        generateCoverLetterForReview={generateCoverLetterForReview}
      />
    );
  }

  // USAGE & CREDITS SCREEN
  if (screen === 'usage') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />

        <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: 120 }]} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.usageHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                setShowSettings(false);
                setScreen('dashboard');
              }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.usageHeaderTitle}>Usage & Credits</Text>
            <View style={{ width: 50 }} />
          </View>

          {loadingUsage ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#8B5CF6" />
              <Text style={styles.loadingText}>Loading usage data...</Text>
            </View>
          ) : (
            <>
              {/* Credit Balance Card */}
              <View style={styles.usageCreditCard}>
                <Text style={styles.usageCreditLabel}>💳 Available Credits</Text>
                <Text style={styles.usageCreditNumber}>{creditBalance}</Text>
                {expiringCredits > 0 && creditExpiryDate && (
                  <View style={styles.usageExpiryWarning}>
                    <Text style={styles.usageExpiryText}>
                      ⚠️ {expiringCredits} credits expiring on {new Date(creditExpiryDate).toLocaleDateString()}
                    </Text>
                  </View>
                )}
              </View>

              {/* Monthly Usage Stats */}
              {usageData?.currentMonthUsage && (
                <View style={styles.usageMonthCard}>
                  <View style={styles.usageCardHeader}>
                    <Text style={styles.usageCardTitle}>📊 This Month</Text>
                    <Text style={styles.usageCardIcon}>📈</Text>
                  </View>
                  <View style={styles.usageProgressSection}>
                    <View style={styles.usageProgressHeader}>
                      <Text style={styles.usageProgressLabel}>Generated</Text>
                      <Text style={styles.usageProgressValue}>
                        {usageData.currentMonthUsage.monthlyGenerated || usageData.currentMonthUsage.totalGenerated || 0}
                      </Text>
                    </View>
                    <View style={styles.usageProgressBar}>
                      <View 
                        style={[
                          styles.usageProgressFill, 
                          { 
                            width: '100%',
                            backgroundColor: '#8B5CF6'
                          }
                        ]} 
                      />
                    </View>
                  </View>

                  <View style={styles.usageProgressSection}>
                    <View style={styles.usageProgressHeader}>
                      <Text style={styles.usageProgressLabel}>Sent</Text>
                      <Text style={styles.usageProgressValue}>
                        {usageData.currentMonthUsage.monthlySent || usageData.currentMonthUsage.totalSent || 0}
                      </Text>
                    </View>
                    <View style={styles.usageProgressBar}>
                      <View 
                        style={[
                          styles.usageProgressFill, 
                          { 
                            width: '100%',
                            backgroundColor: '#10B981'
                          }
                        ]} 
                      />
                    </View>
                  </View>
                </View>
              )}

              {/* 30-Day Activity Overview Chart */}
              {usageData?.dateWiseActivity && usageData.dateWiseActivity.length > 0 && (
                <View style={styles.usageHistoryCard}>
                  <Text style={styles.usageCardTitle}>📈 Activity Overview (Last 7 Days)</Text>
                  <View style={styles.chartContainer}>
                    {(() => {
                      // Get days with activity for chart (show all 30 days)
                      const daysWithActivity = usageData.dateWiseActivity.filter(d => d.generated > 0 || d.sent > 0 || d.creditsUsed > 0);
                      const chartData = daysWithActivity.length > 0 ? daysWithActivity : usageData.dateWiseActivity.slice(-7);
                      console.log('📊 [CHART] Days with activity:', daysWithActivity.length);
                      console.log('📊 [CHART] Rendering chart with data:', JSON.stringify(chartData));
                      
                      // If no activity at all, show a message
                      if (daysWithActivity.length === 0) {
                        return (
                          <View style={{ padding: 20, alignItems: 'center' }}>
                            <Text style={{ fontSize: 16, color: '#666', textAlign: 'center' }}>
                              📊 No activity recorded yet.{'\n'}
                              Generate and send cover letters to see your activity here!
                            </Text>
                          </View>
                        );
                      }
                      
                      const maxValue = Math.max(
                        ...chartData.map(d => Math.max(d.generated || 0, d.sent || 0, d.creditsUsed || 0)),
                        5
                      );
                      console.log('📊 [CHART] Max value for chart:', maxValue);
                      
                      // Generate Y-axis labels (0 to maxValue)
                      const yAxisLabels = [];
                      const labelCount = 5;
                      for (let i = 0; i <= labelCount; i++) {
                        yAxisLabels.push(Math.round((maxValue / labelCount) * (labelCount - i)));
                      }
                      
                      return (
                        <View>
                          {/* Chart with Y-axis */}
                          <View style={styles.chartWithAxis}>
                            {/* Y-axis labels */}
                            <View style={styles.chartYAxis}>
                              {yAxisLabels.map((label, index) => (
                                <Text key={index} style={styles.chartYAxisLabel}>{label}</Text>
                              ))}
                            </View>
                            {/* Chart bars */}
                            <View style={styles.chartBars}>
                              {chartData.map((day, index) => {
                                const genHeight = ((day.generated || 0) / maxValue) * 120;
                                const sentHeight = ((day.sent || 0) / maxValue) * 120;
                                const usedHeight = ((day.creditsUsed || 0) / maxValue) * 120;
                                
                                console.log(`📊 [BAR ${index}] ${day.date}: Gen=${day.generated}(${genHeight.toFixed(1)}px), Sent=${day.sent}(${sentHeight.toFixed(1)}px), Used=${day.creditsUsed}(${usedHeight.toFixed(1)}px)`);
                                
                                return (
                                  <View key={index} style={styles.chartBarGroup}>
                                    <View style={styles.chartBarContainer}>
                                      <View style={[styles.chartBar, { height: Math.max(genHeight, 2), backgroundColor: '#8B5CF6' }]} />
                                      <View style={[styles.chartBar, { height: Math.max(sentHeight, 2), backgroundColor: '#10B981', marginLeft: 3 }]} />
                                      <View style={[styles.chartBar, { height: Math.max(usedHeight, 2), backgroundColor: '#EF4444', marginLeft: 3 }]} />
                                    </View>
                                    <Text style={styles.chartLabel}>
                                      {new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                    </Text>
                                  </View>
                                );
                              })}
                            </View>
                          </View>
                          {/* Legend */}
                          <View style={styles.chartLegend}>
                            <View style={styles.chartLegendItem}>
                              <View style={[styles.chartLegendDot, { backgroundColor: '#8B5CF6' }]} />
                              <Text style={styles.chartLegendText}>Generated</Text>
                            </View>
                            <View style={styles.chartLegendItem}>
                              <View style={[styles.chartLegendDot, { backgroundColor: '#10B981' }]} />
                              <Text style={styles.chartLegendText}>Sent</Text>
                            </View>
                            <View style={styles.chartLegendItem}>
                              <View style={[styles.chartLegendDot, { backgroundColor: '#EF4444' }]} />
                              <Text style={styles.chartLegendText}>Credits Used</Text>
                            </View>
                          </View>
                        </View>
                      );
                    })()}
                  </View>
                </View>
              )}

              {/* Date-wise Activity Table */}
              {usageData?.dateWiseActivity && usageData.dateWiseActivity.length > 0 && (
                <View style={styles.usageHistoryCard}>
                  <Text style={styles.usageCardTitle}>📅 Date-wise Activity (Last 7 Days)</Text>
                  <View style={styles.activityTableHeader}>
                    <Text style={[styles.activityTableHeaderText, { flex: 2 }]}>Date</Text>
                    <Text style={[styles.activityTableHeaderText, { flex: 1, textAlign: 'center' }]}>Generated</Text>
                    <Text style={[styles.activityTableHeaderText, { flex: 1, textAlign: 'center' }]}>Sent</Text>
                    <Text style={[styles.activityTableHeaderText, { flex: 1, textAlign: 'center' }]}>Credits Used</Text>
                    <Text style={[styles.activityTableHeaderText, { flex: 1, textAlign: 'center' }]}>Credits Available</Text>
                  </View>
                  <ScrollView style={{ maxHeight: 300 }}>
                    {(() => {
                      const activeDays = usageData.dateWiseActivity.filter(day => day.generated > 0 || day.sent > 0 || day.creditsUsed > 0);
                      
                      if (activeDays.length === 0) {
                        return (
                          <View style={{ padding: 20, alignItems: 'center' }}>
                            <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
                              No activity recorded in the last 7 days.
                            </Text>
                          </View>
                        );
                      }
                      
                      return activeDays.reverse().map((day, index) => (
                        <View key={index} style={styles.activityTableRow}>
                          <Text style={[styles.activityTableCell, { flex: 2, fontWeight: '500' }]}>
                            {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          </Text>
                          <Text style={[styles.activityTableCell, styles.activityHighlight, { flex: 1, textAlign: 'center' }]}>
                            {day.generated}
                          </Text>
                          <Text style={[styles.activityTableCell, styles.activityHighlight, { flex: 1, textAlign: 'center' }]}>
                            {day.sent}
                          </Text>
                          <Text style={[styles.activityTableCell, styles.activityHighlight, { flex: 1, textAlign: 'center' }]}>
                            {day.creditsUsed}
                          </Text>
                          <Text style={[styles.activityTableCell, { flex: 1, textAlign: 'center' }]}>
                            {day.creditsAvailable}
                          </Text>
                        </View>
                      ));
                    })()}
                  </ScrollView>
                </View>
              )}

              {/* Recent Credit Activity */}
              <View style={styles.usageHistoryCard}>
                <Text style={styles.usageCardTitle}>📜 Recent Credit Activity</Text>
                {usageData?.creditHistory && usageData.creditHistory.length > 0 ? (
                  usageData.creditHistory.slice(0, 15).map((item, index) => (
                    <View key={index} style={styles.usageHistoryItem}>
                      <View style={styles.usageHistoryLeft}>
                        <Text style={[
                          styles.usageHistoryType,
                          { color: item.transactionType === 'deduction' ? '#EF4444' : '#10B981' }
                        ]}>
                          {item.transactionType === 'deduction' ? '−' : '+'}
                          {Math.abs(item.creditsChange)}
                        </Text>
                        <Text style={styles.usageHistoryDesc}>{item.description}</Text>
                      </View>
                      <View style={styles.usageHistoryRight}>
                        <Text style={styles.usageHistoryDate}>
                          {new Date(item.transactionDate).toLocaleDateString()}
                        </Text>
                        <Text style={styles.usageHistoryBalance}>
                          Balance: {item.balanceAfter}
                        </Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyStateIcon}>📋</Text>
                    <Text style={styles.emptyStateText}>No credit activity yet</Text>
                  </View>
                )}
              </View>

              {/* Buy More Credits Button */}
              <TouchableOpacity 
                style={styles.buyCreditsButton}
                onPress={() => setScreen('packages')}
              >
                <Text style={styles.buyCreditsButtonText}>💎 Buy More Credits</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
        <FloatingTabBar currentScreen="usage" setScreen={setScreen} handleReview={handleReview} />
      </SafeAreaViewContext>
    );
  }

  // NOTIFICATIONS SCREEN
  if (screen === 'notifications') {
    // Use server-provided totals for stats so they reflect the full dataset,
    // not just the loaded batch. Fall back to local counts if server totals
    // aren't available yet (e.g. first render before load completes).
    const displayTotal  = notificationsTotalCount  || notifications.length;
    const displayUnread = unreadCount;
    const displayRead   = notificationsReadCount   || Math.max(0, displayTotal - displayUnread);
    // Local counts used only for filter chip badges (reflect what's actually visible)
    const localUnreadCount = notifications.filter(n => !n.is_read).length;
    const localReadCount   = notifications.filter(n =>  n.is_read).length;
    const localTotalCount  = notifications.length;

    // Filter notifications based on selected filter
    const filteredNotifications = notifications.filter(notif => {
      if (notificationFilter === 'unread') return !notif.is_read;
      if (notificationFilter === 'read') return notif.is_read;
      return true; // 'all'
    });

    // Icon config for each notification type
    const notifIconConfig = (type) => {
      switch (type) {
        case 'email':       return { name: 'mail-outline',          bg: '#DBEAFE', color: '#2563EB' };
        case 'cover_letter':return { name: 'document-text-outline', bg: '#F3E8FF', color: '#7C3AED' };
        case 'credits':     return { name: 'diamond-outline',       bg: '#FEF3C7', color: '#D97706' };
        case 'profile':     return { name: 'person-outline',        bg: '#CCFBF1', color: '#0D9488' };
        case 'reply':       return { name: 'chatbubble-outline',    bg: '#DCFCE7', color: '#16A34A' };
        default:            return { name: 'notifications-outline', bg: '#E0E7FF', color: '#4F46E5' };
      }
    };

    return (
      <SafeAreaViewContext style={styles.notifPageContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#E5EAF3" translucent={false} />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.notifScrollContent}>

          {/* ── TOP BAR ──────────────────────────────────────────────── */}
          <View style={styles.notifTopBar}>
            {/* Back pill */}
            <TouchableOpacity
              style={styles.notifBackPill}
              onPress={() => setScreen('dashboard')}
              activeOpacity={0.8}
            >
              <Ionicons name="arrow-back" size={14} color="#0B0F22" />
              <Text style={styles.notifBackPillText}>Back</Text>
            </TouchableOpacity>

            {/* Wordmark (centered absolutely) */}
            <View style={styles.notifWordmark} pointerEvents="none">
              <Image
                source={require('./assets/images/logo_img.png')}
                style={styles.notifWordmarkLogo}
                resizeMode="contain"
              />
              <Text style={styles.notifWordmarkText}>
                cv<Text style={styles.notifWordmarkBlue}>applyr</Text>
              </Text>
            </View>

            {/* Mark all read pill (right side) */}
            {localUnreadCount > 0 ? (
              <TouchableOpacity
                style={styles.notifMarkReadPill}
                onPress={markAllNotificationsRead}
                activeOpacity={0.8}
              >
                <Ionicons name="checkmark-done-outline" size={14} color="#4F8DFF" />
                <Text style={styles.notifMarkReadText}>All read</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ width: 80 }} />
            )}
          </View>

          {/* ── HERO CARD ─────────────────────────────────────────────── */}
          <View style={styles.notifHeroCard}>
            <LinearGradient
              colors={['#0B0F22', '#0F1635', '#0B0F22']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
            {/* Mesh blobs */}
            <View style={[styles.notifMeshBlob, { top: -20, left: -30, backgroundColor: 'rgba(79,141,255,0.18)', width: 140, height: 140 }]} />
            <View style={[styles.notifMeshBlob, { top: 10, right: -20, backgroundColor: 'rgba(124,107,255,0.14)', width: 110, height: 110 }]} />
            <View style={[styles.notifMeshBlob, { bottom: -10, left: 60, backgroundColor: 'rgba(20,184,166,0.10)', width: 90, height: 90 }]} />

            {/* Eyebrow row */}
            <View style={styles.notifHeroEyeRow}>
              <Text style={styles.notifHeroEyebrow}>ACTIVITY · INBOX</Text>
              {localUnreadCount > 0 && (
                <View style={styles.notifHeroCountChip}>
                  <View style={styles.notifHeroCountDot} />
                  <Text style={styles.notifHeroCountText}>{localUnreadCount} unread</Text>
                </View>
              )}
            </View>

            {/* Title */}
            <Text style={styles.notifHeroTitle}>Stay in the loop.</Text>
            <Text style={styles.notifHeroSub}>
              Track replies, updates, and cover letter activity all in one place.
            </Text>

            {/* Stats strip */}
            <View style={styles.notifStatsRow}>
              <View style={styles.notifStatChip}>
                <Text style={styles.notifStatNum}>{displayTotal}</Text>
                <Text style={styles.notifStatLabel}>Total</Text>
              </View>
              <View style={styles.notifStatDivider} />
              <View style={styles.notifStatChip}>
                <Text style={styles.notifStatNum}>{displayUnread}</Text>
                <Text style={styles.notifStatLabel}>Unread</Text>
              </View>
              <View style={styles.notifStatDivider} />
              <View style={styles.notifStatChip}>
                <Text style={styles.notifStatNum}>{displayRead}</Text>
                <Text style={styles.notifStatLabel}>Read</Text>
              </View>
            </View>
          </View>

          {/* ── FILTER CHIPS ─────────────────────────────────────────── */}
          <View style={styles.notifFiltersRow}>
            {[
              { key: 'all',    label: 'All',    count: localTotalCount },
              { key: 'unread', label: 'Unread', count: localUnreadCount },
              { key: 'read',   label: 'Read',   count: localReadCount },
            ].map(f => (
              <TouchableOpacity
                key={f.key}
                style={[styles.notifFilterChip, notificationFilter === f.key && styles.notifFilterChipActive]}
                onPress={() => setNotificationFilter(f.key)}
                activeOpacity={0.8}
              >
                <Text style={[styles.notifFilterChipText, notificationFilter === f.key && styles.notifFilterChipTextActive]}>
                  {f.label}
                </Text>
                <View style={[styles.notifFilterBadge, notificationFilter === f.key && styles.notifFilterBadgeActive]}>
                  <Text style={[styles.notifFilterBadgeText, notificationFilter === f.key && styles.notifFilterBadgeTextActive]}>
                    {f.count}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── LIST ─────────────────────────────────────────────────── */}
          {loadingNotifications ? (
            <View style={styles.notifLoadingBox}>
              <ActivityIndicator size="large" color="#4F8DFF" />
              <Text style={styles.notifLoadingText}>Loading notifications…</Text>
            </View>
          ) : filteredNotifications.length === 0 ? (
            <View style={styles.notifEmptyBox}>
              <View style={styles.notifEmptyIconRing}>
                <Ionicons name="notifications-off-outline" size={36} color="#8896B0" />
              </View>
              <Text style={styles.notifEmptyTitle}>
                {notificationFilter === 'unread' ? 'All caught up' :
                 notificationFilter === 'read'   ? 'Nothing read yet' :
                 'No notifications yet'}
              </Text>
              <Text style={styles.notifEmptySub}>
                {notificationFilter === 'all'
                  ? "You'll be notified when replies arrive or something important happens."
                  : 'Switch to a different filter to see more.'}
              </Text>
            </View>
          ) : (
            <View style={styles.notifList}>
              {filteredNotifications.map((notif, index) => {
                const ic = notifIconConfig(notif.type);
                return (
                  <TouchableOpacity
                    key={notif.id || index}
                    activeOpacity={0.75}
                    onPress={() => { if (!notif.is_read) markNotificationAsRead(notif.id); }}
                    style={[styles.notifCard, !notif.is_read && styles.notifCardUnread]}
                  >
                    {/* Unread left accent bar */}
                    {!notif.is_read && <View style={styles.notifCardAccent} />}

                    {/* Icon */}
                    <View style={[styles.notifCardIconBox, { backgroundColor: ic.bg }]}>
                      <Ionicons name={ic.name} size={20} color={ic.color} />
                    </View>

                    {/* Content */}
                    <View style={styles.notifCardBody}>
                      <View style={styles.notifCardTopRow}>
                        <Text style={styles.notifCardTitle} numberOfLines={2}>{notif.title}</Text>
                        {!notif.is_read && <View style={styles.notifUnreadDot} />}
                      </View>
                      <Text style={styles.notifCardMessage} numberOfLines={3}>{notif.message}</Text>
                      <View style={styles.notifCardFooter}>
                        <Ionicons name="time-outline" size={11} color="#8896B0" />
                        <Text style={styles.notifCardTime}>{getTimeAgo(notif.created_at)}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* ── LOAD MORE ─────────────────────────────────────────────── */}
          {notificationsHasMore && !loadingNotifications && (
            <View style={styles.notifLoadMoreWrapper}>
              {notificationsLoadingMore ? (
                <View style={styles.notifLoadMoreSpinner}>
                  <ActivityIndicator size="small" color="#4F8DFF" />
                  <Text style={styles.notifLoadMoreSpinnerText}>Loading more…</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.notifLoadMoreBtn}
                  onPress={loadMoreNotifications}
                  activeOpacity={0.8}
                >
                  <Ionicons name="chevron-down-circle-outline" size={18} color="#4F8DFF" />
                  <Text style={styles.notifLoadMoreText}>
                    Load more  ·  {displayTotal - localTotalCount} remaining
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          <View style={{ height: 32 }} />
        </ScrollView>
      </SafeAreaViewContext>
    );
  }

  // PACKAGES SCREEN
  if (screen === 'packages') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.usageHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => setScreen('dashboard')}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.usageHeaderTitle}>💎 Credit Packages</Text>
            <View style={{ width: 50 }} />
          </View>

          {/* Page Header */}
          <View style={styles.packagesPageHeader}>
            <Text style={styles.packagesPageTitle}>Choose Your Plan</Text>
            <Text style={styles.packagesPageSubtitle}>Select the perfect package for your job application needs</Text>
          </View>

          {/* Current Credits Card */}
          <View style={styles.packagesCreditCard}>
            <Text style={styles.packagesCreditLabel}>💳 YOUR CURRENT CREDITS</Text>
            <Text style={styles.packagesCreditNumber}>{creditBalance}</Text>
            <Text style={styles.packagesCreditSubtext}>Purchase credits to continue generating cover letters</Text>
          </View>

          {/* Packages Section */}
          {loadingUserPackages ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#8B5CF6" />
              <Text style={styles.loadingText}>Loading packages...</Text>
            </View>
          ) : (
            <>
              <View style={styles.packagesSectionHeader}>
                <Text style={styles.packagesSectionTitle}>Available Packages</Text>
                <Text style={styles.packagesSectionSubtitle}>Select a package below to get started</Text>
              </View>

              <View style={styles.packagesGrid}>
                {userPackages.map((pkg) => (
                  <View 
                    key={pkg.id} 
                    style={[
                      styles.packageCard,
                      pkg.is_popular === 1 && styles.packageCardPopular
                    ]}
                  >
                    {/* Popular Badge */}
                    {pkg.is_popular === 1 && (
                      <View style={styles.popularBadge}>
                        <Text style={styles.popularBadgeText}>⭐ MOST POPULAR</Text>
                      </View>
                    )}
                    
                    {/* Package Header */}
                    <View style={styles.packageCardHeader}>
                      <Text style={styles.packageName}>{pkg.name}</Text>
                      {pkg.description && (
                        <Text style={styles.packageDescriptionText}>{pkg.description}</Text>
                      )}
                    </View>

                    {/* Package Price - Large and Centered */}
                    <View style={styles.packagePriceSection}>
                      <View style={styles.packagePriceContainer}>
                        {Platform.OS === 'ios' && iapProducts.length > 0 ? (
                          // Show Apple IAP localized price on iOS
                          <Text style={styles.packagePrice}>
                            {(() => {
                              const nameToProductId = {
                                'Starter': 'com.cvapplyr.mobile.starter',
                                'Professional': 'com.cvapplyr.mobile.professional',
                                'Premium': 'com.cvapplyr.mobile.premium',
                                'Enterprise': 'com.cvapplyr.mobile.enterprise',
                              };
                              const iapProduct = iapProducts.find(p => p.id === nameToProductId[pkg.name]);
                              return iapProduct ? iapProduct.displayPrice : `$${pkg.amount}`;
                            })()}
                          </Text>
                        ) : (
                          <>
                            <Text style={styles.packageCurrency}>$</Text>
                            <Text style={styles.packagePrice}>{pkg.amount}</Text>
                          </>
                        )}
                      </View>
                    </View>

                    {/* Package Details - Label Value Pairs */}
                    <View style={styles.packageDetailsSection}>
                      <View style={styles.packageDetailRowNew}>
                        <View style={styles.packageDetailLeft}>
                          <Text style={styles.packageDetailIconNew}>💎</Text>
                          <Text style={styles.packageDetailLabel}>Credits</Text>
                        </View>
                        <Text style={styles.packageDetailValue}>{pkg.credits}</Text>
                      </View>
                      
                      <View style={styles.packageDetailRowNew}>
                        <View style={styles.packageDetailLeft}>
                          <Text style={styles.packageDetailIconNew}>⏰</Text>
                          <Text style={styles.packageDetailLabel}>Validity</Text>
                        </View>
                        <Text style={styles.packageDetailValue}>{pkg.validity_days} days</Text>
                      </View>
                    </View>

                    {/* Buy Button */}
                    <TouchableOpacity 
                      style={[
                        styles.packageBuyButton,
                        pkg.is_popular === 1 && styles.packageBuyButtonPopular
                      ]}
                      onPress={() => handleBuyPackage(pkg)}
                    >
                      <Text style={styles.packageBuyButtonText}>💳 Buy Plan</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            </>
          )}

          {userPackages.length === 0 && !loadingUserPackages && (
            <View style={styles.emptyPackagesContainer}>
              <Text style={styles.emptyPackagesIcon}>📦</Text>
              <Text style={styles.emptyPackagesText}>No packages available</Text>
              <Text style={styles.emptyPackagesSubtext}>Please check back later</Text>
            </View>
          )}

          {/* Restore Purchases Button (iOS only) */}
          {Platform.OS === 'ios' && (
            <TouchableOpacity
              style={{ alignItems: 'center', paddingVertical: 16, marginBottom: 20 }}
              onPress={handleRestorePurchases}
              disabled={restoringPurchases}
            >
              <Text style={{ color: '#6366f1', fontSize: 14, fontWeight: '500' }}>
                {restoringPurchases ? 'Restoring...' : 'Restore Purchases'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* Payment handled by native Razorpay SDK - no WebView needed */}
        <FloatingTabBar currentScreen="notifications" setScreen={setScreen} handleReview={handleReview} />
      </SafeAreaViewContext>
    );
  }

  // PROFILE SCREEN
  if (screen === 'profile') {
    const displayName = profileData?.fullName || user?.fullName || user?.name || 'User';
    const displayEmail = profileData?.email || user?.email || '';
    const accountCreatedDate = profileData?.createdAt ? new Date(profileData.createdAt).toLocaleDateString() : new Date().toLocaleDateString();

    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.profileHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                setShowSettings(false);
                setScreen('dashboard');
              }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.profileHeaderTitle}>Account Settings</Text>
            <TouchableOpacity 
              style={styles.editButton}
              onPress={() => setIsEditingProfile(!isEditingProfile)}
            >
              <Text style={[styles.editButtonText, { color: '#0d9488' }]}>{isEditingProfile ? 'Cancel' : 'Edit'}</Text>
            </TouchableOpacity>
          </View>

          {/* Profile Avatar and Basic Info */}
          <View style={styles.profileCardHeader}>
            <TouchableOpacity 
              style={styles.profileAvatarLarge}
              onPress={pickProfileImage}
              disabled={!isEditingProfile}
              activeOpacity={isEditingProfile ? 0.7 : 1}
            >
              {profileData?.profileImage ? (
                <Image 
                  source={{ uri: profileData.profileImage }} 
                  style={styles.profileImageContent}
                />
              ) : (
                <Text style={styles.profileAvatarText}>{displayName.charAt(0).toUpperCase()}</Text>
              )}
              {isEditingProfile && (
                <View style={styles.editOverlay}>
                  <Text style={styles.editOverlayText}>📷</Text>
                </View>
              )}
            </TouchableOpacity>
            <View style={styles.profileBasicInfo}>
              <Text style={styles.profileNameLarge}>{displayName}</Text>
              <Text style={styles.profileEmail}>{displayEmail}</Text>
              <View style={styles.profileBadge}>
                <Text style={styles.profileBadgeText}>✓ Active</Text>
              </View>
            </View>
          </View>

          {/* Profile Photo Upload */}
          {isEditingProfile && (
            <View style={styles.profileDetailCard}>
              <Text style={styles.cardTitleProfile}>📷 Profile Photo</Text>
              <TouchableOpacity 
                style={[styles.uploadZone, styles.uploadZoneActive]}
                onPress={pickProfileImage}
                activeOpacity={0.7}
              >
                {profileData?.profileImage ? (
                  <Image 
                    source={{ uri: profileData.profileImage }}
                    style={styles.profilePhotoPreview}
                  />
                ) : (
                  <View style={styles.uploadPlaceholder}>
                    <Text style={styles.uploadIcon}>📷</Text>
                    <Text style={styles.uploadText}>Tap to upload photo</Text>
                  </View>
                )}
              </TouchableOpacity>
              <Text style={styles.uploadHint}>Tap to change from files or photos</Text>
            </View>
          )}

          {/* Email Information */}
          <View style={styles.profileDetailCard}>
            <Text style={styles.cardTitleProfile}>📧 Email Information</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Email Address</Text>
              <Text style={styles.detailValue}>{displayEmail}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Verification Status</Text>
              <Text style={styles.detailValueVerified}>✓ Verified</Text>
            </View>
            <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.detailLabel}>Email Sending</Text>
              {user?.oauth_provider === 'google' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.detailValueVerified}>✓ Gmail</Text>
                  <TouchableOpacity onPress={handleRevokeEmailProvider}>
                    <Text style={{ color: '#EF4444', fontWeight: '600', fontSize: 12 }}>Revoke</Text>
                  </TouchableOpacity>
                </View>
              ) : user?.oauth_provider === 'microsoft' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.detailValueVerified}>✓ Outlook</Text>
                  <TouchableOpacity onPress={handleRevokeEmailProvider}>
                    <Text style={{ color: '#EF4444', fontWeight: '600', fontSize: 12 }}>Revoke</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <TouchableOpacity onPress={handleLinkGoogle}>
                    <Text style={{ color: '#0d9488', fontWeight: '600', fontSize: 14 }}>Google →</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleLinkMicrosoft}>
                    <Text style={{ color: '#0d9488', fontWeight: '600', fontSize: 14 }}>Outlook →</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            {user?.oauth_provider !== 'google' && user?.oauth_provider !== 'microsoft' && (
              <Text style={{ color: '#9CA3AF', fontSize: 12, marginTop: 4, paddingHorizontal: 16, paddingBottom: 12 }}>
                Connect Google or Outlook to send job applications from your own email
              </Text>
            )}
          </View>

          {/* Personal Information */}
          <View style={styles.profileDetailCard}>
            <Text style={styles.cardTitleProfile}>👤 Personal Information</Text>
            
            {isEditingProfile ? (
              <>
                <View style={styles.editFormGroup}>
                  <Text style={styles.formLabel}>Email Address</Text>
                  <TextInput 
                    style={styles.formInput}
                    placeholder="your@email.com"
                    placeholderTextColor="#9CA3AF"
                    value={profileData?.email || ''}
                    onChangeText={(text) => setProfileData({ ...profileData, email: text })}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
                <View style={styles.editFormGroup}>
                  <Text style={styles.formLabel}>Full Name</Text>
                  <TextInput 
                    style={styles.formInput}
                    value={profileData?.fullName || ''}
                    onChangeText={(text) => setProfileData({ ...profileData, fullName: text })}
                  />
                </View>
                <View style={styles.editFormGroup}>
                  <Text style={styles.formLabel}>Phone Number</Text>
                  <TextInput 
                    style={styles.formInput}
                    placeholder="Enter phone number"
                    placeholderTextColor="#9CA3AF"
                    value={profileData?.phone || ''}
                    onChangeText={(text) => setProfileData({ ...profileData, phone: text })}
                  />
                </View>
                <View style={styles.editFormGroup}>
                  <Text style={styles.formLabel}>Address</Text>
                  <TextInput 
                    style={styles.formInput}
                    placeholder="Enter your address"
                    placeholderTextColor="#9CA3AF"
                    value={profileData?.address || ''}
                    onChangeText={(text) => setProfileData({ ...profileData, address: text })}
                  />
                </View>
                <View style={styles.editFormGroup}>
                  <Text style={styles.formLabel}>Date of Birth</Text>
                  <TouchableOpacity 
                    style={styles.datePickerButton}
                    onPress={() => {
                      let initDate = new Date();
                      if (profileData?.dateOfBirth) {
                        // Parse as local date to avoid UTC timezone shift (e.g. '2026-04-10' → April 9 in US timezones)
                        const parts = profileData.dateOfBirth.split('-');
                        initDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                      }
                      setTempDobDate(initDate);
                      tempDobDateRef.current = initDate;
                      setShowDatePicker(true);
                    }}
                  >
                    <Text style={styles.datePickerText}>
                      {profileData?.dateOfBirth || 'Select Date'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.editFormGroup}>
                  <Text style={styles.formLabel}>Gender</Text>
                  <Text style={{ fontSize: 12, color: '#6B7280', marginTop: -2, marginBottom: 8 }}>
                    Optional. Used only — with your consent — to auto-fill pronoun/gender questions on job applications.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {['Male', 'Female', 'Prefer Not to Say'].map((opt) => {
                      const sel = profileData?.gender === opt;
                      return (
                        <TouchableOpacity
                          key={opt}
                          activeOpacity={0.8}
                          onPress={() => setProfileData({ ...profileData, gender: sel ? '' : opt })}
                          style={{
                            flex: 1, paddingVertical: 11, paddingHorizontal: 4, borderRadius: 10,
                            borderWidth: 1.5, alignItems: 'center', justifyContent: 'center',
                            borderColor: sel ? '#1e40af' : '#E5E7EB',
                            backgroundColor: sel ? '#EFF2FF' : '#FFFFFF',
                          }}
                        >
                          <Text style={{ fontSize: 12.5, fontWeight: sel ? '700' : '500', color: sel ? '#1e40af' : '#374151', textAlign: 'center' }}>
                            {opt}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </>
            ) : (
              <>
                <TouchableOpacity 
                  style={styles.detailRow}
                  onLongPress={() => {
                    Clipboard.setStringAsync(profileData?.fullName || '');
                    Alert.alert('Copied', 'Full name copied to clipboard');
                  }}
                >
                  <Text style={styles.detailLabel}>Full Name</Text>
                  <Text style={styles.detailValue}>{profileData?.fullName || 'Not provided'}</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.detailRow}
                  onLongPress={() => {
                    Clipboard.setStringAsync(profileData?.phone || '');
                    Alert.alert('Copied', 'Phone number copied to clipboard');
                  }}
                >
                  <Text style={styles.detailLabel}>Phone Number</Text>
                  <Text style={styles.detailValue}>{profileData?.phone || 'Not provided'}</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.detailRow, { alignItems: 'flex-start' }]}
                  onLongPress={() => {
                    Clipboard.setStringAsync(profileData?.address || '');
                    Alert.alert('Copied', 'Address copied to clipboard');
                  }}
                >
                  <Text style={[styles.detailLabel, { marginTop: 2 }]}>Address</Text>
                  <Text style={[styles.detailValue, { flex: 1, textAlign: 'right' }]}>{profileData?.address || 'Not provided'}</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.detailRow}
                  onLongPress={() => {
                    Clipboard.setStringAsync(profileData?.dateOfBirth || '');
                    Alert.alert('Copied', 'Date of birth copied to clipboard');
                  }}
                >
                  <Text style={styles.detailLabel}>Date of Birth</Text>
                  <Text style={styles.detailValue}>{profileData?.dateOfBirth || 'Not provided'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.detailRow}
                  onLongPress={() => {
                    Clipboard.setStringAsync(profileData?.gender || '');
                    Alert.alert('Copied', 'Gender copied to clipboard');
                  }}
                >
                  <Text style={styles.detailLabel}>Gender</Text>
                  <Text style={styles.detailValue}>{profileData?.gender || 'Not provided'}</Text>
                </TouchableOpacity>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Account Type</Text>
                  <Text style={styles.detailValue}>{user?.provider === 'google' ? 'Google' : 'Email'}</Text>
                </View>
                <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                  <Text style={styles.detailLabel}>Member Since</Text>
                  <Text style={styles.detailValue}>{accountCreatedDate}</Text>
                </View>
              </>
            )}
          </View>

          {/* Resume Upload */}
          <View style={styles.profileDetailCard}>
            <Text style={styles.cardTitleProfile}>📄 Resume</Text>
            <TouchableOpacity 
              style={[
                styles.uploadZone,
                isEditingProfile && styles.uploadZoneActive
              ]}
              onPress={pickResume}
              disabled={!isEditingProfile}
              activeOpacity={isEditingProfile ? 0.7 : 1}
            >
              {profileData?.resume ? (
                <View style={styles.uploadPlaceholder}>
                  <Text style={styles.uploadIcon}>✓</Text>
                  <Text style={styles.uploadText}>{profileData.resume}</Text>
                  {isEditingProfile && <Text style={styles.uploadHint}>Tap to change</Text>}
                </View>
              ) : (
                <View style={styles.uploadPlaceholder}>
                  <Text style={styles.uploadIcon}>📄</Text>
                  <Text style={styles.uploadText}>{isEditingProfile ? 'Tap to upload resume (PDF)' : 'No resume uploaded'}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Signature Upload */}
          <View style={styles.profileDetailCard}>
            <Text style={styles.cardTitleProfile}>✍️ Signature</Text>

            {/* Preview zone — always shown */}
            <TouchableOpacity
              style={[styles.uploadZone, isEditingProfile && styles.uploadZoneActive]}
              onPress={pickSignature}
              disabled={!isEditingProfile}
              activeOpacity={isEditingProfile ? 0.7 : 1}
            >
              {profileData?.signature ? (
                <Image source={{ uri: profileData.signature }} style={styles.uploadPreview} resizeMode="contain" />
              ) : (
                <View style={styles.uploadPlaceholder}>
                  <Text style={styles.uploadIcon}>✍️</Text>
                  <Text style={styles.uploadText}>
                    {isEditingProfile ? 'Tap to upload an image' : 'No signature uploaded'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>

            {/* Generate Signature button — only in edit mode */}
            {isEditingProfile && (
              <TouchableOpacity
                style={styles.generateSigBtn}
                onPress={() => {
                  const name = profileData?.fullName?.trim() || user?.fullName?.trim();
                  if (!name) {
                    Alert.alert('Name required', 'Please fill in your full name in the profile before generating a signature.');
                    return;
                  }
                  setShowSignatureGenerator(true);
                }}
                activeOpacity={0.8}
                disabled={signatureGenerating}
              >
                {signatureGenerating ? (
                  <ActivityIndicator size="small" color="#7C6BFF" />
                ) : (
                  <Ionicons name="sparkles-outline" size={15} color="#7C6BFF" />
                )}
                <Text style={styles.generateSigBtnText}>
                  {signatureGenerating ? 'Generating…' : 'Generate Signature from Name'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Signature Generator Modal */}
          <Modal
            visible={showSignatureGenerator}
            animationType="slide"
            transparent
            onRequestClose={() => setShowSignatureGenerator(false)}
          >
            <View style={styles.sigGenOverlay}>
              <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowSignatureGenerator(false)} />
              <View style={styles.sigGenSheet}>
                {/* Handle */}
                <View style={styles.sigGenHandle} />

                {/* Header */}
                <View style={styles.sigGenHeader}>
                  <View>
                    <Text style={styles.sigGenTitle}>Generate Signature</Text>
                    <Text style={styles.sigGenSub}>
                      {profileData?.fullName || user?.fullName || ''}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.sigGenCloseBtn}
                    onPress={() => setShowSignatureGenerator(false)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="close" size={18} color="#0B0F22" />
                  </TouchableOpacity>
                </View>

                {/* WebView — renders font picker + canvas export */}
                <View style={styles.sigGenWebViewWrap}>
                  <WebView
                    source={{ html: buildSignatureGeneratorHTML(profileData?.fullName || user?.fullName || '') }}
                    style={styles.sigGenWebView}
                    onMessage={handleSignatureWebViewMessage}
                    javaScriptEnabled
                    domStorageEnabled
                    scrollEnabled
                    showsVerticalScrollIndicator={false}
                    originWhitelist={['*']}
                  />
                </View>
              </View>
            </View>
          </Modal>

          {/* Save Changes Button */}
          {isEditingProfile && (
            <TouchableOpacity
              style={[styles.profileDetailCard, { backgroundColor: '#0d9488', marginBottom: 20 }]}
              onPress={saveProfileChanges}
            >
              <Text style={[styles.cardTitleProfile, { color: '#fff', textAlign: 'center' }]}>✓ Save Changes</Text>
            </TouchableOpacity>
          )}

          {/* Application Statistics */}
          <View style={styles.profileDetailCard}>
            <Text style={styles.cardTitleProfile}>📊 Statistics</Text>
            <View style={styles.statsGrid}>
              <View style={styles.statItemProfile}>
                <Text style={styles.statValueProfile}>
                  {totalSent}
                </Text>
                <Text style={styles.statLabelProfile}>Total Sent</Text>
              </View>
              <View style={styles.statItemProfile}>
                <Text style={styles.statValueProfile}>
                  {totalGenerated}
                </Text>
                <Text style={styles.statLabelProfile}>Generated</Text>
              </View>
              <View style={styles.statItemProfile}>
                <Text style={styles.statValueProfile}>
                  {applicationHistory.filter(app => app.replyReceived).length}
                </Text>
                <Text style={styles.statLabelProfile}>Responses</Text>
              </View>
            </View>
          </View>

          {/* Account Actions */}
          <View style={styles.profileDetailCard}>
            <Text style={styles.cardTitleProfile}>⚙️ Account Actions</Text>
            <TouchableOpacity 
              style={styles.actionButton}
              onPress={() => setShowChangePassword(true)}
            >
              <Text style={styles.actionButtonText}>{isOAuthUser ? 'Set Password' : 'Change Password'}</Text>
              <Text style={styles.actionButtonIcon}>→</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => setShowPrivacySettings(true)}
            >
              <Text style={styles.actionButtonText}>Privacy Settings</Text>
              <Text style={styles.actionButtonIcon}>→</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => setShowDeleteAccount(true)}
            >
              <Text style={[styles.actionButtonText, { color: '#ef4444' }]}>Delete Account Permanently</Text>
              <Text style={styles.actionButtonIcon}>→</Text>
            </TouchableOpacity>
            {/* AI Hub — dedicated "Rate this App" entry, placed right above Sign Out. */}
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => setShowRateApp(true)}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="star" size={16} color="#FBBF24" style={{ marginRight: 10 }} />
                <Text style={styles.actionButtonText}>Rate this App</Text>
              </View>
              <Text style={styles.actionButtonIcon}>→</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, { borderBottomWidth: 0 }]}
              onPress={() => {
                Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
                  { text: 'Cancel', onPress: () => {} },
                  { text: 'Sign Out', onPress: () => handleLogout(), style: 'destructive' }
                ]);
              }}
            >
              <Text style={[styles.actionButtonText, { color: '#6b7280' }]}>Sign Out</Text>
              <Text style={styles.actionButtonIcon}>→</Text>
            </TouchableOpacity>
          </View>

          <View style={{ height: 30 }} />
        </ScrollView>

        {/* AI Hub — dedicated "Rate this App" modal (compliant store-review routing). */}
        <RateAppModal visible={showRateApp} onClose={() => setShowRateApp(false)} />

        {/* Change Password Modal */}
        <Modal
          transparent={true}
          visible={showChangePassword}
          animationType="slide"
          onRequestClose={() => setShowChangePassword(false)}
        >
          <TouchableWithoutFeedback onPress={() => setShowChangePassword(false)}>
            <View style={styles.accountModalOverlay}>
              <TouchableWithoutFeedback>
                <KeyboardAvoidingView 
                  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                  style={styles.accountModalKeyboardView}
                >
                  <View style={styles.accountModalContent}>
                    <View style={styles.accountModalHeader}>
                      <Text style={styles.accountModalTitle}>{isOAuthUser ? '🔒 Set Password' : '🔒 Change Password'}</Text>
                      <TouchableOpacity onPress={() => setShowChangePassword(false)}>
                        <Text style={styles.accountModalCloseBtn}>✕</Text>
                      </TouchableOpacity>
                    </View>

                    <ScrollView 
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={styles.accountModalScrollContent}
                    >
                      {!isOAuthUser && (
                        <TextInput
                          style={styles.accountModalInput}
                          placeholder="Current Password"
                          placeholderTextColor="#9ca3af"
                          secureTextEntry
                          value={currentPassword}
                          onChangeText={setCurrentPassword}
                        />
                      )}
                      <TextInput
                        style={styles.accountModalInput}
                        placeholder="New Password"
                        placeholderTextColor="#9ca3af"
                        secureTextEntry
                        value={newPassword}
                        onChangeText={setNewPassword}
                      />
                      <TextInput
                        style={styles.accountModalInput}
                        placeholder="Confirm New Password"
                        placeholderTextColor="#9ca3af"
                        secureTextEntry
                        value={confirmPassword}
                        onChangeText={setConfirmPassword}
                      />
                    </ScrollView>

                    <TouchableOpacity 
                      style={styles.accountModalButton}
                      onPress={handleChangePassword}
                    >
                      <Text style={styles.accountModalButtonText}>{isOAuthUser ? 'Set Password' : 'Change Password'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity 
                      style={styles.accountModalButtonSecondary}
                      onPress={() => setShowChangePassword(false)}
                    >
                      <Text style={styles.accountModalButtonSecondaryText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </KeyboardAvoidingView>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        {/* Privacy Settings Modal */}
        <Modal
          transparent={true}
          visible={showPrivacySettings}
          animationType="slide"
          onRequestClose={() => setShowPrivacySettings(false)}
        >
          <TouchableWithoutFeedback onPress={() => setShowPrivacySettings(false)}>
            <View style={styles.accountModalOverlay}>
              <TouchableWithoutFeedback>
                <View style={styles.accountModalContent}>
                  <View style={styles.accountModalHeader}>
                    <Text style={styles.accountModalTitle}>🔐 Privacy Settings</Text>
                    <TouchableOpacity onPress={() => setShowPrivacySettings(false)}>
                      <Text style={styles.accountModalCloseBtn}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <ScrollView 
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.accountModalScrollContent}
                  >
                    <View style={styles.settingRow}>
                      <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Email Notifications</Text>
                        <Text style={styles.settingDescription}>Receive updates via email</Text>
                      </View>
                      <TouchableOpacity 
                        style={[styles.toggle, privacySettings.emailNotifications && styles.toggleActive]}
                        onPress={() => setPrivacySettings({ ...privacySettings, emailNotifications: !privacySettings.emailNotifications })}
                      >
                        <View style={[styles.toggleCircle, privacySettings.emailNotifications && styles.toggleCircleActive]} />
                      </TouchableOpacity>
                    </View>

                    <View style={styles.settingRow}>
                      <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>SMS Notifications</Text>
                        <Text style={styles.settingDescription}>Receive updates via SMS</Text>
                      </View>
                      <TouchableOpacity 
                        style={[styles.toggle, privacySettings.smsNotifications && styles.toggleActive]}
                        onPress={() => setPrivacySettings({ ...privacySettings, smsNotifications: !privacySettings.smsNotifications })}
                      >
                        <View style={[styles.toggleCircle, privacySettings.smsNotifications && styles.toggleCircleActive]} />
                      </TouchableOpacity>
                    </View>

                    <View style={styles.settingRow}>
                      <View style={styles.settingTextContainer}>
                        <Text style={styles.settingLabel}>Public Profile</Text>
                        <Text style={styles.settingDescription}>Allow others to view your profile</Text>
                      </View>
                      <TouchableOpacity 
                        style={[styles.toggle, privacySettings.profilePublic && styles.toggleActive]}
                        onPress={() => setPrivacySettings({ ...privacySettings, profilePublic: !privacySettings.profilePublic })}
                      >
                        <View style={[styles.toggleCircle, privacySettings.profilePublic && styles.toggleCircleActive]} />
                      </TouchableOpacity>
                    </View>
                  </ScrollView>

                  <TouchableOpacity 
                    style={styles.accountModalButton}
                    onPress={handleUpdatePrivacySettings}
                  >
                    <Text style={styles.accountModalButtonText}>Save Settings</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.accountModalButtonSecondary}
                    onPress={() => setShowPrivacySettings(false)}
                  >
                    <Text style={styles.accountModalButtonSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        {/* Delete Account Modal */}
        <Modal
          transparent={true}
          visible={showDeleteAccount}
          animationType="slide"
          onRequestClose={() => setShowDeleteAccount(false)}
        >
          <TouchableWithoutFeedback onPress={() => setShowDeleteAccount(false)}>
            <View style={styles.accountModalOverlay}>
              <TouchableWithoutFeedback>
                <View style={styles.accountModalContent}>
                  <View style={styles.accountModalHeader}>
                    <Text style={[styles.accountModalTitle, { color: '#ef4444' }]}>⚠️ Delete Account</Text>
                    <TouchableOpacity onPress={() => setShowDeleteAccount(false)}>
                      <Text style={styles.accountModalCloseBtn}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <ScrollView 
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.accountModalScrollContent}
                  >
                    <Text style={styles.deleteWarningText}>
                      This action is permanent and cannot be undone. All your data will be deleted:
                    </Text>
                    <Text style={styles.deleteWarningList}>
                      • All cover letters and applications{'\n'}
                      • Profile and account information{'\n'}
                      • Payment history and credits{'\n'}
                      • Saved templates and settings
                    </Text>
                    <Text style={styles.deleteConfirmInstructions}>
                      To confirm, type <Text style={styles.deleteConfirmKeyword}>DELETE</Text> below:
                    </Text>
                    <TextInput
                      style={styles.accountModalInput}
                      placeholder="Type DELETE to confirm"
                      placeholderTextColor="#9ca3af"
                      value={deleteConfirmText}
                      onChangeText={setDeleteConfirmText}
                      autoCapitalize="characters"
                    />
                  </ScrollView>

                  <TouchableOpacity 
                    style={[styles.accountModalButton, { backgroundColor: '#ef4444' }]}
                    onPress={handleDeleteAccount}
                  >
                    <Text style={styles.accountModalButtonText}>Delete Account Permanently</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.accountModalButtonSecondary}
                    onPress={() => {
                      setShowDeleteAccount(false);
                      setDeleteConfirmText('');
                    }}
                  >
                    <Text style={styles.accountModalButtonSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        {/* Date of Birth Picker — Android renders the native dialog directly (no
            modal wrapper) so a tap selects the date, applies it, and closes. The
            iOS inline-spinner modal below is unchanged. */}
        {Platform.OS === 'android' && showDatePicker && (
          <DateTimePicker
            value={tempDobDate}
            mode="date"
            display="default"
            maximumDate={new Date()}
            onChange={(event, date) => {
              setShowDatePicker(false);
              if (event.type === 'set' && date) {
                setProfileData({ ...profileData, dateOfBirth: date.toLocaleDateString('en-CA') });
              }
            }}
          />
        )}
        {/* Date of Birth Picker Modal (iOS) */}
        {Platform.OS === 'ios' && (
        <Modal
          transparent={true}
          visible={showDatePicker}
          animationType="slide"
          onRequestClose={() => setShowDatePicker(false)}
        >
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => setShowDatePicker(false)}>
              <View style={{ flex: 1 }} />
            </TouchableWithoutFeedback>
            <SafeAreaViewContext style={styles.datePickerModalWrapper}>
              <View style={styles.datePickerModal}>
                <View style={styles.datePickerHeader}>
                  <View style={styles.datePickerHeaderLine} />
                  <Text style={styles.datePickerTitle}>Date of Birth</Text>
                </View>
                <View style={styles.datePickerContainer}>
                  <DateTimePicker
                    value={tempDobDate}
                    mode="date"
                    display="spinner"
                    onChange={(event, date) => {
                      const currentDate = date || tempDobDate;
                      setTempDobDate(currentDate);
                      tempDobDateRef.current = currentDate;
                    }}
                    maximumDate={new Date()}
                    themeVariant="light"
                    style={{ height: 216, width: '100%' }}
                  />
                </View>
                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => setShowDatePicker(false)}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalConfirmButton}
                    onPress={() => {
                      const formattedDate = tempDobDateRef.current.toLocaleDateString('en-CA');
                      setProfileData({ ...profileData, dateOfBirth: formattedDate });
                      setShowDatePicker(false);
                    }}
                  >
                    <View style={styles.confirmButtonWrapper}>
                      <LinearGradient
                        colors={['#667eea', '#764ba2']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.modalConfirmGradient}
                      >
                        <Text style={styles.modalConfirmText}>Confirm</Text>
                      </LinearGradient>
                    </View>
                  </TouchableOpacity>
                </View>
              </View>
            </SafeAreaViewContext>
          </View>
        </Modal>
        )}

        <FloatingTabBar currentScreen="profile" setScreen={setScreen} handleReview={handleReview} />
      </SafeAreaViewContext>
    );
  }

  // ADMIN PACKAGES SCREEN
  if (screen === 'admin') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.profileHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                setShowSettings(false);
                setScreen('dashboard');
              }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.profileHeaderTitle}>🛡️ Admin Panel</Text>
            <View style={{ width: 50 }} />
          </View>

          {loadingAdminPackages ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#8B5CF6" />
              <Text style={styles.loadingText}>Loading packages...</Text>
            </View>
          ) : (
            <>
              {/* Page Title */}
              <View style={styles.adminPageHeader}>
                <Text style={styles.adminPageTitle}>💳 Credit Packages</Text>
                <Text style={styles.adminPageSubtitle}>Manage credit packages for users</Text>
              </View>

              {/* AI Event Credits — configure per-event credit costs */}
              <TouchableOpacity
                style={[styles.adminCreateButton, { backgroundColor: '#0E7490', marginBottom: 16 }]}
                onPress={() => { try { require('expo-router').router.push('/(admin)/ai-event-credits'); } catch (e) { console.warn('nav failed', e?.message); } }}
              >
                <Text style={styles.adminCreateButtonIcon}>⚙️</Text>
                <Text style={styles.adminCreateButtonText}>AI Event Credits</Text>
              </TouchableOpacity>

              {/* Create Package Button */}
              <TouchableOpacity 
                style={styles.adminCreateButton}
                onPress={() => {
                  setEditingPackage(null);
                  setPackageFormData({
                    name: '',
                    amount: '',
                    credits: '',
                    validity_days: '',
                    description: '',
                    is_popular: false,
                    is_active: 1,
                    display_order: '0'
                  });
                  setShowPackageForm(true);
                }}
              >
                <Text style={styles.adminCreateButtonIcon}>+</Text>
                <Text style={styles.adminCreateButtonText}>Create New Package</Text>
              </TouchableOpacity>

              {/* Packages List */}
              {adminPackages && adminPackages.length > 0 ? (
                adminPackages.map((pkg) => (
                  <View key={pkg.id} style={styles.adminPackageCard}>
                    {/* Popular Badge */}
                    {pkg.is_popular === 1 && (
                      <View style={styles.adminPopularBadge}>
                        <Text style={styles.adminPopularBadgeText}>★ POPULAR</Text>
                      </View>
                    )}

                    {/* Package Name */}
                    <Text style={styles.adminPackageName}>{pkg.name}</Text>
                    
                    {/* Description */}
                    {pkg.description && (
                      <Text style={styles.adminPackageDescription}>{pkg.description}</Text>
                    )}

                    {/* Price - Centered and Bold */}
                    <Text style={styles.adminPackagePrice}>USD {parseFloat(pkg.amount).toFixed(2)}</Text>

                    {/* Package Details - Label Value Pairs */}
                    <View style={styles.adminPackageDetails}>
                      <View style={styles.adminDetailRow}>
                        <Text style={styles.adminDetailLabel}>Credits</Text>
                        <Text style={styles.adminDetailValue}>{pkg.credits}</Text>
                      </View>
                      <View style={styles.adminDetailRow}>
                        <Text style={styles.adminDetailLabel}>Validity</Text>
                        <Text style={styles.adminDetailValue}>{pkg.validity_days} days</Text>
                      </View>
                      <View style={styles.adminDetailRow}>
                        <Text style={styles.adminDetailLabel}>Display Order</Text>
                        <Text style={styles.adminDetailValue}>{pkg.display_order || 0}</Text>
                      </View>
                      <View style={styles.adminDetailRow}>
                        <Text style={styles.adminDetailLabel}>Status</Text>
                        <View style={[
                          styles.adminStatusBadge,
                          pkg.is_active === 1 ? styles.adminStatusActive : styles.adminStatusInactive
                        ]}>
                          <Text style={[
                            styles.adminStatusText,
                            pkg.is_active === 1 ? styles.adminStatusTextActive : styles.adminStatusTextInactive
                          ]}>
                            {pkg.is_active === 1 ? 'Active' : 'Inactive'}
                          </Text>
                        </View>
                      </View>
                    </View>

                    {/* Action Buttons */}
                    <View style={styles.adminPackageActions}>
                      <TouchableOpacity 
                        style={styles.adminActionButton}
                        onPress={() => {
                          setEditingPackage(pkg);
                          setPackageFormData({
                            name: pkg.name,
                            amount: pkg.amount.toString(),
                            credits: pkg.credits.toString(),
                            validity_days: pkg.validity_days.toString(),
                            description: pkg.description || '',
                            is_popular: pkg.is_popular === 1,
                            is_active: pkg.is_active,
                            display_order: (pkg.display_order || 0).toString()
                          });
                          setShowPackageForm(true);
                        }}
                      >
                        <Text style={styles.adminActionButtonText}>✏️ Edit</Text>
                      </TouchableOpacity>
                      <TouchableOpacity 
                        style={[styles.adminActionButton, { backgroundColor: pkg.is_active === 1 ? '#FEF3C7' : '#D1FAE5' }]}
                        onPress={() => togglePackageStatus(pkg.id, pkg.is_active)}
                      >
                        <Text style={[styles.adminActionButtonText, { color: pkg.is_active === 1 ? '#92400E' : '#065F46' }]}>
                          {pkg.is_active === 1 ? '⭘ Deactivate' : '● Activate'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity 
                        style={[styles.adminActionButton, { backgroundColor: '#FEE2E2' }]}
                        onPress={() => {
                          Alert.alert(
                            'Delete Package',
                            `Are you sure you want to delete "${pkg.name}"? This action cannot be undone.`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => deletePackage(pkg.id) }
                            ]
                          );
                        }}
                      >
                        <Text style={[styles.adminActionButtonText, { color: '#991B1B' }]}>🗑️ Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              ) : (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateIcon}>📦</Text>
                  <Text style={styles.emptyStateText}>No Packages Yet</Text>
                  <Text style={styles.emptyStateSubtext}>Create your first credit package to get started</Text>
                </View>
              )}
            </>
          )}
        </ScrollView>

        {/* Package Form Modal */}
        {showPackageForm && (
          <Modal
            visible={showPackageForm}
            transparent={true}
            animationType="slide"
            onRequestClose={() => setShowPackageForm(false)}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={{ flex: 1 }}
            >
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={styles.modalOverlay}>
                  <View style={styles.packageFormModal}>
                    {/* Modal Header */}
                    <View style={styles.packageFormHeader}>
                      <Text style={styles.packageFormTitle}>
                        {editingPackage ? 'Edit Package' : 'Create Package'}
                      </Text>
                      <TouchableOpacity onPress={() => setShowPackageForm(false)}>
                        <Text style={styles.packageFormClose}>×</Text>
                      </TouchableOpacity>
                    </View>

                    {/* Modal Body - Scrollable */}
                    <ScrollView 
                      style={styles.packageFormBody}
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={true}
                    >
                  {/* Package Name */}
                  <View style={styles.adminFormGroup}>
                    <Text style={styles.adminFormLabel}>Package Name *</Text>
                    <TextInput
                      style={styles.adminFormInput}
                      value={packageFormData.name}
                      onChangeText={(text) => setPackageFormData({...packageFormData, name: text})}
                      placeholder="e.g., Starter Pack"
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>

                  {/* Amount and Credits Row */}
                  <View style={styles.formRowGroup}>
                    <View style={styles.formGroupHalf}>
                      <Text style={styles.adminFormLabel}>Amount (USD) *</Text>
                      <TextInput
                        style={styles.adminFormInput}
                        value={packageFormData.amount}
                        onChangeText={(text) => setPackageFormData({...packageFormData, amount: text})}
                        placeholder="9.99"
                        keyboardType="decimal-pad"
                        placeholderTextColor="#9CA3AF"
                      />
                    </View>
                    <View style={styles.formGroupHalf}>
                      <Text style={styles.adminFormLabel}>Credits *</Text>
                      <TextInput
                        style={styles.adminFormInput}
                        value={packageFormData.credits}
                        onChangeText={(text) => setPackageFormData({...packageFormData, credits: text})}
                        placeholder="50"
                        keyboardType="number-pad"
                        placeholderTextColor="#9CA3AF"
                      />
                    </View>
                  </View>

                  {/* Validity and Display Order Row */}
                  <View style={styles.formRowGroup}>
                    <View style={styles.formGroupHalf}>
                      <Text style={styles.adminFormLabel}>Validity (Days) *</Text>
                      <TextInput
                        style={styles.adminFormInput}
                        value={packageFormData.validity_days}
                        onChangeText={(text) => setPackageFormData({...packageFormData, validity_days: text})}
                        placeholder="30"
                        keyboardType="number-pad"
                        placeholderTextColor="#9CA3AF"
                      />
                    </View>
                    <View style={styles.formGroupHalf}>
                      <Text style={styles.adminFormLabel}>Display Order</Text>
                      <TextInput
                        style={styles.adminFormInput}
                        value={packageFormData.display_order}
                        onChangeText={(text) => setPackageFormData({...packageFormData, display_order: text})}
                        placeholder="0"
                        keyboardType="number-pad"
                        placeholderTextColor="#9CA3AF"
                      />
                    </View>
                  </View>

                  {/* Description */}
                  <View style={styles.adminFormGroup}>
                    <Text style={styles.adminFormLabel}>Description</Text>
                    <TextInput
                      style={[styles.adminFormInput, styles.formTextArea]}
                      value={packageFormData.description}
                      onChangeText={(text) => setPackageFormData({...packageFormData, description: text})}
                      placeholder="Brief description of the package..."
                      multiline
                      numberOfLines={3}
                      placeholderTextColor="#9CA3AF"
                    />
                  </View>

                  {/* Checkboxes */}
                  <View style={styles.formCheckboxContainer}>
                    <View style={styles.formCheckboxRow}>
                      <TouchableOpacity 
                        style={styles.formCheckboxWrapper}
                        onPress={() => setPackageFormData({...packageFormData, is_popular: !packageFormData.is_popular})}
                      >
                        <View style={[styles.checkbox, packageFormData.is_popular && styles.checkboxChecked]}>
                          {packageFormData.is_popular && <Text style={styles.checkboxCheck}>✓</Text>}
                        </View>
                        <Text style={styles.checkboxLabel}>Mark as Popular</Text>
                      </TouchableOpacity>
                      <TouchableOpacity 
                        style={styles.formCheckboxWrapper}
                        onPress={() => setPackageFormData({...packageFormData, is_active: packageFormData.is_active === 1 ? 0 : 1})}
                      >
                        <View style={[styles.checkbox, packageFormData.is_active === 1 && styles.checkboxChecked]}>
                          {packageFormData.is_active === 1 && <Text style={styles.checkboxCheck}>✓</Text>}
                        </View>
                        <Text style={styles.checkboxLabel}>Active Status</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </ScrollView>

                {/* Modal Footer */}
                <View style={styles.packageFormFooter}>
                  <TouchableOpacity 
                    style={styles.formCancelButton}
                    onPress={() => setShowPackageForm(false)}
                  >
                    <Text style={styles.formCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.formSaveButton}
                    onPress={() => editingPackage ? updatePackage() : createPackage()}
                  >
                    <Text style={styles.formSaveButtonText}>
                      {editingPackage ? 'Update Package' : 'Save Package'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Modal>
    )}
      </SafeAreaViewContext>
    );
  }

  // Terms & Conditions Screen
  if (screen === 'terms') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.profileHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                setShowSettings(false);
                setScreen('dashboard');
              }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.profileHeaderTitle}>📄 Terms & Conditions</Text>
            <View style={{ width: 50 }} />
          </View>

          {/* Content Card */}
          <View style={styles.legalContentCard}>
            <Text style={styles.legalUpdateText}>Last Updated: {new Date().toLocaleDateString()}</Text>

            <Text style={styles.legalSection}>1. Acceptance of Terms</Text>
            <Text style={styles.legalParagraph}>By accessing and using CVApplyr, you accept and agree to be bound by these Terms and Conditions. If you do not agree, please discontinue use immediately.</Text>

            <Text style={styles.legalSection}>2. Service Description</Text>
            <Text style={styles.legalParagraph}>CVApplyr is a credit-based platform that helps users create professional cover letters using AI technology and send them to potential employers via email.</Text>

            <Text style={styles.legalSection}>3. User Account</Text>
            <Text style={styles.legalParagraph}>• You must provide accurate registration information{'\n'}• You are responsible for maintaining account security{'\n'}• One account per user is permitted{'\n'}• Sharing accounts is prohibited</Text>

            <Text style={styles.legalSection}>4. Credits and Payment</Text>
            <Text style={styles.legalParagraph}>• Credits are required for generating and sending cover letters{'\n'}• Credits are purchased through packages{'\n'}• All purchases are final unless otherwise stated in our Refund Policy{'\n'}• Credits expire after the validity period mentioned in the package{'\n'}• Prices are in USD</Text>

            <Text style={styles.legalSection}>5. Acceptable Use Policy</Text>
            <Text style={styles.legalParagraph}>You agree NOT to:{'\n'}• Use the service for spam or unsolicited emails{'\n'}• Upload malicious content{'\n'}• Violate any laws or regulations{'\n'}• Misrepresent yourself or your qualifications{'\n'}• Abuse the AI generation system</Text>

            <Text style={styles.legalSection}>6. Intellectual Property</Text>
            <Text style={styles.legalParagraph}>• Cover letters generated are your property{'\n'}• You retain all rights to content you upload{'\n'}• CVApplyr retains rights to its platform and technology{'\n'}• Our logo, branding, and design are protected</Text>

            <Text style={styles.legalSection}>7. AI-Generated Content</Text>
            <Text style={styles.legalParagraph}>• Cover letters are generated using AI technology{'\n'}• You are responsible for reviewing and editing content{'\n'}• We do not guarantee job placement or interview calls{'\n'}• Always verify AI-generated information before use</Text>

            <Text style={styles.legalSection}>8. Privacy and Data</Text>
            <Text style={styles.legalParagraph}>Your privacy is important. Please review our Privacy Policy to understand how we collect, use, and protect your information.</Text>

            <Text style={styles.legalSection}>9. Service Availability</Text>
            <Text style={styles.legalParagraph}>• We strive for 99.9% uptime but cannot guarantee uninterrupted service{'\n'}• Maintenance windows may be scheduled{'\n'}• We are not liable for service interruptions</Text>

            <Text style={styles.legalSection}>10. Limitation of Liability</Text>
            <Text style={styles.legalParagraph}>CVApplyr is provided "as is". We are not liable for:{'\n'}• Job application outcomes{'\n'}• Email delivery failures{'\n'}• Data loss or corruption{'\n'}• Indirect or consequential damages</Text>

            <Text style={styles.legalSection}>11. Termination</Text>
            <Text style={styles.legalParagraph}>We reserve the right to suspend or terminate accounts that violate these terms. Upon termination, unused credits are forfeited.</Text>

            <Text style={styles.legalSection}>12. Changes to Terms</Text>
            <Text style={styles.legalParagraph}>We may update these terms at any time. Continued use after changes constitutes acceptance.</Text>

            <Text style={styles.legalSection}>13. Governing Law</Text>
            <Text style={styles.legalParagraph}>These terms are governed by applicable laws. Any disputes will be resolved in appropriate courts.</Text>

            <Text style={styles.legalSection}>14. Contact Us</Text>
            <Text style={styles.legalParagraph}>For questions about these Terms:{'\n'}Email: support@cvapplyr.com</Text>
          </View>
        </ScrollView>
      </SafeAreaViewContext>
    );
  }

  // Privacy Policy Screen
  if (screen === 'privacy') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.profileHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                setShowSettings(false);
                setScreen('dashboard');
              }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.profileHeaderTitle}>🔒 Privacy Policy</Text>
            <View style={{ width: 50 }} />
          </View>

          {/* Content Card */}
          <View style={styles.legalContentCard}>
            <Text style={styles.legalUpdateText}>Last Updated: {new Date().toLocaleDateString()}</Text>

            <Text style={styles.legalSection}>1. Introduction</Text>
            <Text style={styles.legalParagraph}>CVApplyr ("we", "our", "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information.</Text>

            <Text style={styles.legalSection}>2. Information We Collect</Text>
            <Text style={styles.legalParagraph}>We collect information you provide directly:{'\n'}• Name and email address{'\n'}• Password (encrypted){'\n'}• Resume/CV content{'\n'}• Cover letter templates{'\n'}• Employer contact information{'\n'}• Payment/billing information (processed securely)</Text>

            <Text style={styles.legalSection}>3. How We Use Your Information</Text>
            <Text style={styles.legalParagraph}>We use your information to:{'\n'}• Provide our cover letter generation service{'\n'}• Send emails on your behalf to employers{'\n'}• Process credit purchases{'\n'}• Improve our AI algorithms{'\n'}• Send service-related notifications{'\n'}• Provide customer support</Text>

            <Text style={styles.legalSection}>4. Information Sharing</Text>
            <Text style={styles.legalParagraph}>We do NOT sell your personal information. We may share data with:{'\n'}• Email service providers (to send applications){'\n'}• Payment processors (for credit purchases){'\n'}• Cloud hosting services (for data storage){'\n'}• Law enforcement (if legally required)</Text>

            <Text style={styles.legalSection}>5. Data Security</Text>
            <Text style={styles.legalParagraph}>We implement security measures including:{'\n'}• Encryption of sensitive data{'\n'}• Secure password hashing{'\n'}• Regular security audits{'\n'}• Access controls and authentication{'\n'}• HTTPS encryption for all transmissions</Text>

            <Text style={styles.legalSection}>6. Data Retention</Text>
            <Text style={styles.legalParagraph}>We retain your data:{'\n'}• Account data: Until you delete your account{'\n'}• Cover letters: Until you delete them{'\n'}• Transaction records: For legal/tax purposes (typically 7 years){'\n'}• Logs: 90 days</Text>

            <Text style={styles.legalSection}>7. Your Rights</Text>
            <Text style={styles.legalParagraph}>You have the right to:{'\n'}• Access your personal data{'\n'}• Correct inaccurate information{'\n'}• Request data deletion{'\n'}• Export your data{'\n'}• Withdraw consent{'\n'}• Object to processing{'\n'}• Lodge a complaint with authorities</Text>

            <Text style={styles.legalSection}>8. Children's Privacy</Text>
            <Text style={styles.legalParagraph}>CVApplyr is not intended for users under 16 years of age. We do not knowingly collect information from children.</Text>

            <Text style={styles.legalSection}>9. Third-Party Links</Text>
            <Text style={styles.legalParagraph}>Our service may contain links to third-party websites. We are not responsible for their privacy practices.</Text>

            <Text style={styles.legalSection}>10. International Data Transfers</Text>
            <Text style={styles.legalParagraph}>Your data may be transferred and stored in countries outside your residence. We ensure appropriate safeguards are in place.</Text>

            <Text style={styles.legalSection}>11. Changes to Privacy Policy</Text>
            <Text style={styles.legalParagraph}>We may update this policy periodically. Continued use after changes constitutes acceptance.</Text>

            <Text style={styles.legalSection}>12. Contact Us</Text>
            <Text style={styles.legalParagraph}>For privacy-related questions:{'\n'}Email: support@cvapplyr.com</Text>
          </View>
        </ScrollView>
      </SafeAreaViewContext>
    );
  }

  // Refund Policy Screen
  if (screen === 'refund') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Back Button */}
          <View style={styles.profileHeader}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                setShowSettings(false);
                setScreen('dashboard');
              }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.profileHeaderTitle}>💰 Refund Policy</Text>
            <View style={{ width: 50 }} />
          </View>

          {/* Content Card */}
          <View style={styles.legalContentCard}>
            <Text style={styles.legalUpdateText}>Last Updated: {new Date().toLocaleDateString()}</Text>

            {/* Important Notice */}
            <View style={styles.importantNotice}>
              <Text style={styles.importantNoticeTitle}>⚠️ Important</Text>
              <Text style={styles.importantNoticeText}>Credits are generally non-refundable once purchased. Please review this policy carefully before making a purchase.</Text>
            </View>

            <Text style={styles.legalSection}>1. General Policy</Text>
            <Text style={styles.legalParagraph}>All credit purchases on CVApplyr are final and non-refundable unless otherwise stated in this policy or required by law.</Text>

            <Text style={styles.legalSection}>2. Non-Refundable Credits</Text>
            <Text style={styles.legalParagraph}>The following are NOT eligible for refunds:{'\n'}• Used credits (generated or sent cover letters){'\n'}• Expired credits after validity period{'\n'}• Promotional or bonus credits{'\n'}• Credits purchased more than 7 days ago{'\n'}• Account violations or terminations</Text>

            <Text style={styles.legalSection}>3. Eligible Refund Scenarios</Text>
            <Text style={styles.legalParagraph}>Refunds may be considered in these cases:{'\n'}• Duplicate or accidental charges{'\n'}• Technical errors preventing credit delivery{'\n'}• Service unavailability for extended periods{'\n'}• Unused credits within 7 days of purchase</Text>

            <Text style={styles.legalSection}>4. Refund Request Process</Text>
            <Text style={styles.legalParagraph}>To request a refund:{'\n'}1. Contact support@cvapplyr.com within 7 days{'\n'}2. Provide your transaction ID and reason{'\n'}3. Include any supporting documentation{'\n'}4. Wait for our team to review (2-5 business days){'\n'}5. Refund processed if approved (7-14 business days)</Text>

            <Text style={styles.legalSection}>5. Refund Processing</Text>
            <Text style={styles.legalParagraph}>• Approved refunds are processed to original payment method{'\n'}• Processing time: 7-14 business days{'\n'}• Bank processing may take additional time{'\n'}• Unused credits will be deducted from account</Text>

            <Text style={styles.legalSection}>6. Partial Refunds</Text>
            <Text style={styles.legalParagraph}>If you've used some credits from a package, partial refunds may be calculated as:{'\n'}(Total Amount × Unused Credits) ÷ Total Credits</Text>

            <Text style={styles.legalSection}>7. Credit Expiration</Text>
            <Text style={styles.legalParagraph}>Credits expire according to the validity period of your purchased package. Expired credits cannot be refunded or extended.</Text>

            <Text style={styles.legalSection}>8. Chargebacks and Disputes</Text>
            <Text style={styles.legalParagraph}>• Contact us before initiating a chargeback{'\n'}• Chargebacks may result in account suspension{'\n'}• We reserve the right to dispute illegitimate chargebacks{'\n'}• Evidence will be provided to payment processors</Text>

            <Text style={styles.legalSection}>9. Modifications to Policy</Text>
            <Text style={styles.legalParagraph}>We reserve the right to modify this refund policy. Changes will not affect purchases made before the modification date.</Text>

            <Text style={styles.legalSection}>10. Free Credits</Text>
            <Text style={styles.legalParagraph}>Credits received as bonuses, promotions, or sign-up rewards are not eligible for cash refunds.</Text>

            <Text style={styles.legalSection}>11. Contact for Refunds</Text>
            <Text style={styles.legalParagraph}>For refund requests or questions:{'\n'}Email: support@cvapplyr.com{'\n'}Subject: "Refund Request - [Transaction ID]"</Text>

            <Text style={styles.legalSection}>12. Legal Rights</Text>
            <Text style={styles.legalParagraph}>This policy does not affect your statutory rights as a consumer under applicable laws.</Text>
          </View>
        </ScrollView>
      </SafeAreaViewContext>
    );
  }

  // ===== REVIEW SCREEN EDIT FUNCTIONS =====
  
  const toggleReviewEditMode = (index) => {
    if (editingReviewIndex === index) {
      // Exit edit mode
      setEditingReviewIndex(null);
      setEditedCoverLetterData({});
    } else {
      // Enter edit mode - store current values
      const currentData = getCoverLetter(index) || {};
      const addrForRegion = currentData.address || (currentData.locations?.find(loc => loc.isHeadquarters)?.address || currentData.locations?.[0]?.address || '');
      // Auto-select region from the employer country (points 1,2); keep any saved override.
      const autoRegion = regionFromCountry(addrForRegion);
      setEditingReviewIndex(index);
      setEditedCoverLetterData({
        hiringManager: currentData.hiringManager || '',
        companyName: currentData.companyName || '',
        email: recipients[index]?.email || '',
        address: addrForRegion,
        date: currentData.date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        position: recipients[index]?.position || '',
        subject: currentData.subject || '',
        coverLetterText: currentData.coverLetterText || '',
        coverLetterRegion: currentData.coverLetterRegion || autoRegion,
        resumeRegion: currentData.resumeRegion || autoRegion
      });
    }
  };

  const saveReviewEdits = (index) => {
    const emailKey = recipients[index]?.email;
    // Update cover letter with edited data - use functional setState
    setReviewCoverLetters(prev => {
      // Always key by email; fall back to index if email somehow not available
      const key = emailKey || index;
      const updated = {
        ...prev,
        [key]: {
          ...(prev[key] || prev[index] || {}),
          ...editedCoverLetterData
        }
      };
      // Save to backend after state update
      saveReviewCoverLettersToBackend(updated);
      return updated;
    });
    
    // Exit edit mode
    setEditingReviewIndex(null);
    setEditedCoverLetterData({});
    
    Alert.alert('Success', 'Changes saved successfully!');
  };

  // ===== END REVIEW SCREEN EDIT FUNCTIONS =====
  
  // Check if any loading operation is in progress
  const isAnyLoadingActive = reviewGeneratingAll || reviewSendingAll || reviewGeneratingAndSendingAll || reviewLoading || reviewDownloading || (reviewGeneratingIndex !== null);
  
  // Check if all applications have been sent
  const allApplicationsSent = recipients.length > 0 && recipients.every((recipient, index) => {
    const coverLetter = getCoverLetter(index);
    return coverLetter && coverLetter.sent;
  });
  
    return (
      <ReviewScreen
        setScreen={setScreen}
        user={user}
        creditBalance={creditBalance}
        unreadCount={unreadCount}
        recipients={recipients}
        currentReviewTab={currentReviewTab}
        setCurrentReviewTab={setCurrentReviewTab}
        reviewCoverLetters={reviewCoverLetters}
        getRecipientFlipAnim={getRecipientFlipAnim}
        handleRecipientFlip={handleRecipientFlip}
        editingReviewIndex={editingReviewIndex}
        toggleReviewEditMode={toggleReviewEditMode}
        editedCoverLetterData={editedCoverLetterData}
        setEditedCoverLetterData={setEditedCoverLetterData}
        showAddressDropdown={showAddressDropdown}
        setShowAddressDropdown={setShowAddressDropdown}
        saveReviewEdits={saveReviewEdits}
        generateCoverLetterForReview={generateCoverLetterForReview}
        downloadCoverLetterPDFFromReview={downloadCoverLetterPDFFromReview}
        sendApplicationFromReview={sendApplicationFromReview}
        generateAllCoverLettersForReview={generateAllCoverLettersForReview}
        sendAllApplicationsFromReview={sendAllApplicationsFromReview}
        generateAndSendAllApplications={generateAndSendAllApplications}
        reviewGeneratingIndex={reviewGeneratingIndex}
        reviewLoading={reviewLoading}
        reviewDownloading={reviewDownloading}
        reviewGeneratingAll={reviewGeneratingAll}
        reviewSendingAll={reviewSendingAll}
        reviewGeneratingAndSendingAll={reviewGeneratingAndSendingAll}
        isAnyLoadingActive={isAnyLoadingActive}
        allApplicationsSent={allApplicationsSent}
        progressiveLoadingMessage={progressiveLoadingMessage}
        progressiveLoadingProgress={progressiveLoadingProgress}
        progressAnimValue={progressAnimValue}
        cancelOperation={cancelOperation}
        showPaymentModal={showPaymentModal}
        setShowPaymentModal={setShowPaymentModal}
        paymentUrl={paymentUrl}
        setPaymentUrl={setPaymentUrl}
        showReviewDatePicker={showReviewDatePicker}
        setShowReviewDatePicker={setShowReviewDatePicker}
        selectedReviewDate={selectedReviewDate}
        setSelectedReviewDate={setSelectedReviewDate}
        selectedReviewDateRef={selectedReviewDateRef}
        setShowNotifications={setShowNotifications}
        showCoverLetterPreview={showCoverLetterPreview}
        setShowCoverLetterPreview={setShowCoverLetterPreview}
      />
    );
    // ---- OLD REVIEW SCREEN START (replaced by ReviewScreen component) ----
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with Gradient Design */}
          <View style={styles.reviewHeaderCard}>
            <LinearGradient
              colors={['#667eea', '#764ba2']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.reviewHeaderGradient}
            >
              <TouchableOpacity 
                onPress={() => setScreen('dashboard')} 
                style={styles.reviewBackButton}
              >
                <Text style={styles.reviewBackIcon}>←</Text>
                <Text style={styles.reviewBackText}>Back</Text>
              </TouchableOpacity>
              
              <View style={styles.reviewHeaderContent}>
                <Text style={styles.reviewHeaderTitle}>Review Applications</Text>
                <Text style={styles.reviewHeaderSubtitle}>Review and send your cover letters</Text>
              </View>
              
              <TouchableOpacity 
                style={styles.reviewCreditBadge}
                onPress={() => setScreen('usage')}
                activeOpacity={0.8}
              >
                <View style={styles.reviewCreditIconBox}>
                  <View style={styles.reviewDiamondIcon}>
                    <View style={styles.reviewDiamondTop} />
                    <View style={styles.reviewDiamondBottom} />
                  </View>
                </View>
                <Text style={styles.reviewCreditText}>{creditBalance}</Text>
              </TouchableOpacity>
            </LinearGradient>
          </View>

          {/* Recipients Horizontal Scrollable Cards */}
          <View style={styles.recipientsCardsSection}>
            <Text style={styles.recipientsCardsSectionLabel}>Recipients ({recipients.length})</Text>
            <ScrollView 
              horizontal 
              showsHorizontalScrollIndicator={false} 
              style={styles.recipientsCardsScroll}
              contentContainerStyle={styles.recipientsCardsContent}
              snapToInterval={280}
              decelerationRate="fast"
            >
              {recipients.map((recipient, index) => {
                const flipAnim = getRecipientFlipAnim(index);
                const isActive = currentReviewTab === index;
                const companyName = recipient.website 
                  ? recipient.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]
                  : recipient.email.split('@')[1] || 'Company';
                
                const frontRotate = flipAnim.interpolate({
                  inputRange: [0, 180],
                  outputRange: ['0deg', '180deg']
                });
                
                const backRotate = flipAnim.interpolate({
                  inputRange: [0, 180],
                  outputRange: ['180deg', '360deg']
                });
                
                // Color palettes for variety - all light shades with dark text
                const colorSets = [
                  { front: ['#fffbeb', '#fef3c7', '#fde68a'], back: ['#fde68a', '#fef3c7', '#fffbeb'] }, // Yellow
                  { front: ['#f0f9ff', '#e0f2fe', '#bae6fd'], back: ['#bae6fd', '#e0f2fe', '#f0f9ff'] }, // Blue
                  { front: ['#fdf2f8', '#fce7f3', '#fbcfe8'], back: ['#fbcfe8', '#fce7f3', '#fdf2f8'] }, // Pink
                  { front: ['#f0fdf4', '#dcfce7', '#bbf7d0'], back: ['#bbf7d0', '#dcfce7', '#f0fdf4'] }, // Green
                  { front: ['#faf5ff', '#f3e8ff', '#e9d5ff'], back: ['#e9d5ff', '#f3e8ff', '#faf5ff'] }, // Purple
                ];
                const colorSet = colorSets[index % colorSets.length];
                
                // Calculate narrative text length for dynamic sizing
                const narrativeText = `You are applying for the position of ${recipient.position || 'Not specified'} at ${companyName.toUpperCase()} with the email address ${recipient.email}`;
                const narrativeFontSize = narrativeText.length > 120 ? 11 : narrativeText.length > 100 ? 12 : 13;
                
                return (
                  <View key={index} style={styles.recipientCardWrapper}>
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={() => {
                        if (isActive) {
                          // If already selected, flip the card
                          handleRecipientFlip(index);
                        } else {
                          // If not selected, select it first
                          setCurrentReviewTab(index);
                        }
                      }}
                      style={styles.recipientCardTouchable}
                    >
                      {/* Front Side - iOS Widget Style */}
                      <Animated.View style={[
                        styles.recipientCardAnimated,
                        {
                          backfaceVisibility: 'hidden',
                          transform: [{ rotateY: frontRotate }]
                        }
                      ]}>
                        <LinearGradient
                          colors={colorSet.front}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 1, y: 1 }}
                          style={styles.recipientCardGradient}
                        >
                          {/* Number Badge */}
                          <View style={styles.recipientCardBadge}>
                            <Text style={styles.recipientCardBadgeText}>
                              {index + 1}
                            </Text>
                          </View>
                          
                          {/* Content */}
                          <View style={styles.recipientCardContent}>
                            <View style={styles.recipientCardSection}>
                              <Text style={styles.recipientCardLabel}>Position:</Text>
                              <Text style={styles.recipientCardPosition} numberOfLines={1} ellipsizeMode="tail">
                                {recipient.position || 'No position specified'}
                              </Text>
                            </View>
                            
                            <View style={styles.recipientCardSection}>
                              <Text style={styles.recipientCardLabel}>Employer:</Text>
                              <Text style={styles.recipientCardCompany} numberOfLines={1} ellipsizeMode="tail">
                                {companyName.toUpperCase()}
                              </Text>
                            </View>
                            
                            <View style={styles.recipientCardSection}>
                              <Text style={styles.recipientCardLabel}>Email:</Text>
                              <Text style={styles.recipientCardEmail} numberOfLines={1} ellipsizeMode="tail">
                                {recipient.email}
                              </Text>
                            </View>
                          </View>
                          
                          {/* Footer Hint */}
                          <Text style={styles.recipientCardFlipHint}>Tap to see details</Text>
                        </LinearGradient>
                        
                        {/* Bottom Selection Indicator */}
                        {isActive && (
                          <View style={styles.recipientCardBottomIndicator} />
                        )}
                      </Animated.View>
                      
                      {/* Back Side - iOS Widget Style */}
                      <Animated.View style={[
                        styles.recipientCardAnimated,
                        styles.recipientCardBackPosition,
                        {
                          backfaceVisibility: 'hidden',
                          transform: [{ rotateY: backRotate }]
                        }
                      ]}>
                        <LinearGradient
                          colors={colorSet.back}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 1, y: 1 }}
                          style={styles.recipientCardGradient}
                        >
                          {/* Number Badge */}
                          <View style={styles.recipientCardBadge}>
                            <Text style={styles.recipientCardBadgeText}>
                              {index + 1}
                            </Text>
                          </View>
                          
                          {/* Details Content - Narrative Style */}
                          <View style={styles.recipientCardContent}>
                            <Text style={[
                              styles.recipientCardNarrative,
                              { fontSize: narrativeFontSize, lineHeight: narrativeFontSize * 1.6 }
                            ]}>
                              You are applying for the position of{' '}
                              <Text style={styles.recipientCardNarrativeBold}>
                                {recipient.position || 'Not specified'}
                              </Text>
                              {' '}at{' '}
                              <Text style={styles.recipientCardNarrativeBold}>
                                {companyName.toUpperCase()}
                              </Text>
                              {' '}with the email address{' '}
                              <Text style={styles.recipientCardNarrativeBold}>
                                {recipient.email}
                              </Text>
                            </Text>
                          </View>
                          
                          {/* Footer Hint */}
                          <Text style={styles.recipientCardFlipHint}>Tap to return</Text>
                        </LinearGradient>
                        
                        {/* Bottom Selection Indicator */}
                        {isActive && (
                          <View style={styles.recipientCardBottomIndicator} />
                        )}
                      </Animated.View>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </ScrollView>
          </View>

          {/* Cover Letter Generation Section */}
          {getCoverLetter(currentReviewTab) ? (
            <View style={styles.reviewCoverLetterCard}>
              <LinearGradient
                colors={['#f0f9ff', '#e0f2fe', '#dbeafe']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.reviewCoverLetterGradient}
              >
                {/* Header with Edit Button */}
                <View style={styles.sectionHeader}>
                <View style={styles.reviewRecipientHeaderLeft}>
                  <Text style={styles.reviewRecipientNumberBadge}>#{currentReviewTab + 1}</Text>
                  <Text style={styles.reviewCoverLetterTitle}>Recipient Details</Text>
                </View>
                {editingReviewIndex !== currentReviewTab && (
                  <TouchableOpacity 
                    style={styles.editButton}
                    onPress={() => toggleReviewEditMode(currentReviewTab)}
                  >
                    <LinearGradient
                      colors={['#3b82f6', '#2563eb']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.editButtonGradient}
                    >
                      <Text style={styles.editButtonText}>Edit</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                )}
              </View>

              {/* Edit/View Mode Combined */}
              {editingReviewIndex === currentReviewTab ? (
                <View style={styles.viewModeContainer}>
                  {/* To (Hiring Manager) - Label Only */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>To (Hiring Manager)</Text>
                    <View style={styles.fieldDisplay}>
                      <Text style={styles.fieldDisplayValue}>The Hiring Manager</Text>
                    </View>
                  </View>

                  {/* Employer Field */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Employer</Text>
                    <TextInput
                      style={styles.editFieldInput}
                      value={editedCoverLetterData.companyName}
                      onChangeText={(text) => setEditedCoverLetterData({ ...editedCoverLetterData, companyName: text })}
                      placeholder="Company Name"
                    />
                  </View>

                  {/* Email Field - Read Only */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Email</Text>
                    <TextInput
                      style={[styles.editFieldInput, styles.readOnlyField]}
                      value={editedCoverLetterData.email}
                      editable={false}
                    />
                  </View>

                  {/* Address Dropdown */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Address</Text>
                    {getCoverLetter(currentReviewTab).locations && getCoverLetter(currentReviewTab).locations.length > 0 ? (
                      <View>
                        <TouchableOpacity 
                          style={styles.dropdownButton}
                          onPress={() => setShowAddressDropdown(true)}
                        >
                          <Text style={styles.dropdownButtonText}>
                            {editedCoverLetterData.address || 'Select Address'}
                          </Text>
                          <Text style={styles.dropdownArrow}>▼</Text>
                        </TouchableOpacity>
                        <Modal
                          visible={showAddressDropdown}
                          transparent
                          animationType="fade"
                        >
                          <TouchableOpacity 
                            style={styles.dropdownOverlay}
                            onPress={() => setShowAddressDropdown(false)}
                          >
                            <View style={styles.dropdownMenu}>
                              <ScrollView>
                                {getCoverLetter(currentReviewTab).locations.map((location, idx) => (
                                  <TouchableOpacity
                                    key={idx}
                                    style={styles.dropdownItem}
                                    onPress={() => {
                                      setEditedCoverLetterData({ 
                                        ...editedCoverLetterData, 
                                        address: `${location.address}, ${location.city}, ${location.country}` 
                                      });
                                      setShowAddressDropdown(false);
                                    }}
                                  >
                                    <Text style={styles.dropdownItemText}>
                                      {`${location.address}, ${location.city}, ${location.country}${location.isHeadquarters ? ' (Headquarters)' : ''}`}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </ScrollView>
                            </View>
                          </TouchableOpacity>
                        </Modal>
                      </View>
                    ) : (
                      <TextInput
                        style={styles.editFieldInput}
                        value={editedCoverLetterData.address}
                        onChangeText={(text) => setEditedCoverLetterData({ ...editedCoverLetterData, address: text })}
                        placeholder="Company Address"
                      />
                    )}
                  </View>

                  {/* Date Field */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Date</Text>
                    <TouchableOpacity 
                      style={styles.dropdownButton}
                      onPress={() => {
                        // Parse the current date string to Date object, or use current date
                        if (editedCoverLetterData.date) {
                          try {
                            const parsedDate = new Date(editedCoverLetterData.date);
                            const d = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
                            setSelectedReviewDate(d);
                            selectedReviewDateRef.current = d;
                          } catch (e) {
                            setSelectedReviewDate(new Date());
                            selectedReviewDateRef.current = new Date();
                          }
                        } else {
                          setSelectedReviewDate(new Date());
                          selectedReviewDateRef.current = new Date();
                        }
                        setShowReviewDatePicker(true);
                      }}
                    >
                      <Text style={styles.dropdownButtonText}>
                        {editedCoverLetterData.date || 'Select Date'}
                      </Text>
                      <Text style={styles.dropdownArrow}>▼</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Position Field */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Position</Text>
                    <TextInput
                      style={styles.editFieldInput}
                      value={editedCoverLetterData.position}
                      onChangeText={(text) => setEditedCoverLetterData({ ...editedCoverLetterData, position: text })}
                      placeholder="Position"
                    />
                  </View>

                  {/* Subject Field */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Subject</Text>
                    <TextInput
                      style={styles.editFieldInput}
                      value={editedCoverLetterData.subject}
                      onChangeText={(text) => setEditedCoverLetterData({ ...editedCoverLetterData, subject: text })}
                      placeholder="Email Subject"
                    />
                  </View>

                  {/* Rich Text Editor for Cover Letter */}
                  <View style={styles.editFieldSection}>
                    <Text style={styles.fieldDisplayLabel}>Cover Letter - Rich Text Editor</Text>
                    
                    {/* Quill.js Rich Text Editor - Full Width */}
                    <RichTextEditorWebView 
                      initialHtml={getCoverLetter(currentReviewTab)?.coverLetterHtml || editedCoverLetterData.coverLetterHtml || ''}
                      onContentChange={(html) => {
                        setEditedCoverLetterData({ 
                          ...editedCoverLetterData, 
                          coverLetterHtml: html // Store the full HTML with formatting
                        });
                      }}
                      height={500}
                    />
                  </View>

                  {/* Save and Cancel Buttons */}
                  <View style={styles.editButtonGroup}>
                    <TouchableOpacity
                      style={styles.editActionBtn}
                      onPress={() => saveReviewEdits(currentReviewTab)}
                    >
                      <LinearGradient
                        colors={['#10b981', '#059669']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.editActionGradient}
                      >
                        <Text style={styles.editActionBtnText}>Save</Text>
                      </LinearGradient>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.editActionBtn}
                      onPress={() => toggleReviewEditMode(currentReviewTab)}
                    >
                      <LinearGradient
                        colors={['#64748b', '#475569']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.editActionGradient}
                      >
                        <Text style={styles.editActionBtnText}>Cancel</Text>
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <>
                  {/* View Mode */}
                  <View style={styles.viewModeContainer}>
                    {/* Fields Display */}
                    <View style={styles.fieldDisplayRow}>
                      <View style={styles.fieldDisplay}>
                        <Text style={styles.fieldDisplayLabel}>To</Text>
                        <Text style={styles.fieldDisplayValue}>The Hiring Manager</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRow}>
                      <View style={styles.fieldDisplay}>
                        <Text style={styles.fieldDisplayLabel}>Employer</Text>
                        <Text style={styles.fieldDisplayValue}>{getCoverLetter(currentReviewTab).companyName}</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRowDouble}>
                      <View style={styles.fieldDisplayHalf}>
                        <Text style={styles.fieldDisplayLabel}>Position</Text>
                        <Text style={styles.fieldDisplayValue}>{recipients[currentReviewTab]?.position}</Text>
                      </View>
                      <View style={styles.fieldDisplayHalf}>
                        <Text style={styles.fieldDisplayLabel}>Date</Text>
                        <Text style={styles.fieldDisplayValue}>{getCoverLetter(currentReviewTab).date}</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRow}>
                      <View style={styles.fieldDisplay}>
                        <Text style={styles.fieldDisplayLabel}>Address</Text>
                        <Text style={styles.fieldDisplayValue}>{getCoverLetter(currentReviewTab).address}</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRow}>
                      <View style={styles.fieldDisplay}>
                        <Text style={styles.fieldDisplayLabel}>Subject</Text>
                        <Text style={styles.fieldDisplayValue}>{getCoverLetter(currentReviewTab).subject}</Text>
                      </View>
                    </View>

                    {/* Cover Letter Preview */}
                    <View style={styles.coverLetterPreviewContainer}>
                      <Text style={styles.coverLetterPreviewLabel}>Cover Letter Preview</Text>
                      <View style={{ height: 400 }}>
                        <HTMLContentViewer 
                          htmlContent={getCoverLetter(currentReviewTab).coverLetterHtml || 'Cover letter content'}
                        />
                      </View>
                    </View>

                    {/* Action Buttons */}
                    <View style={styles.reviewModernActionButtons}>
                      {/* Regenerate Button */}
                      <TouchableOpacity
                        style={styles.reviewActionButtonFull}
                        onPress={() => generateCoverLetterForReview(currentReviewTab)}
                        disabled={reviewGeneratingIndex === currentReviewTab || reviewLoading || reviewGeneratingAll || reviewGeneratingAndSendingAll}
                        activeOpacity={0.8}
                      >
                        <LinearGradient
                          colors={['#fb923c', '#f97316']}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 0, y: 1 }}
                          style={styles.reviewActionButtonGradient}
                        >
                          <View style={styles.reviewActionButtonContent}>
                            <View style={styles.reviewActionIconCircle}>
                              <Text style={styles.reviewActionButtonIcon}>⟳</Text>
                            </View>
                            <Text style={styles.reviewActionButtonText} numberOfLines={1}>Regenerate</Text>
                          </View>
                        </LinearGradient>
                      </TouchableOpacity>
                      
                      {/* Download Button */}
                      <TouchableOpacity
                        style={styles.reviewActionButtonFull}
                        onPress={() => {
                          if (creditBalance <= 0) {
                            Alert.alert(
                              'Insufficient Credits',
                              'Remaining credits are 0. Please recharge to continue downloading.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Recharge Now', onPress: () => setScreen('packages') }
                              ]
                            );
                            return;
                          }
                          Alert.alert(
                            'Download Cover Letter',
                            'Choose a format',
                            [
                              { text: 'PDF', onPress: () => downloadCoverLetterPDFFromReview(currentReviewTab, 'pdf') },
                              { text: 'Word (.docx)', onPress: () => downloadCoverLetterPDFFromReview(currentReviewTab, 'docx') },
                              { text: 'Cancel', style: 'cancel' },
                            ]
                          );
                        }}
                        disabled={reviewDownloading}
                        activeOpacity={0.8}
                      >
                        <LinearGradient
                          colors={['#06b6d4', '#0891b2']}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 0, y: 1 }}
                          style={styles.reviewActionButtonGradient}
                        >
                          <View style={styles.reviewActionButtonContent}>
                            <View style={styles.reviewActionIconCircle}>
                              <Text style={styles.reviewActionButtonIcon}>↓</Text>
                            </View>
                            <Text style={styles.reviewActionButtonText} numberOfLines={1}>Download</Text>
                          </View>
                        </LinearGradient>
                      </TouchableOpacity>
                      
                      {/* Send Button */}
                      <TouchableOpacity
                        style={styles.reviewActionButtonFull}
                        onPress={() => {
                          if (creditBalance <= 0) {
                            Alert.alert(
                              'Insufficient Credits',
                              'Remaining credits are 0. Please recharge to continue sending applications.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Recharge Now', onPress: () => setScreen('packages') }
                              ]
                            );
                            return;
                          }
                          sendApplicationFromReview(currentReviewTab);
                        }}
                        disabled={reviewLoading || reviewSendingAll || reviewGeneratingAndSendingAll || getCoverLetter(currentReviewTab).sent}
                        activeOpacity={0.8}
                      >
                        {!getCoverLetter(currentReviewTab).sent ? (
                          <LinearGradient
                            colors={['#a78bfa', '#8b5cf6']}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 0, y: 1 }}
                            style={styles.reviewActionButtonGradient}
                          >
                            <View style={styles.reviewActionButtonContent}>
                              <View style={styles.reviewActionIconCircle}>
                                <Text style={styles.reviewActionButtonIcon}>✉</Text>
                              </View>
                              <Text style={styles.reviewActionButtonText} numberOfLines={1}>Send</Text>
                            </View>
                          </LinearGradient>
                        ) : (
                          <View style={styles.reviewActionButtonSentGradient}>
                            <View style={styles.reviewActionButtonContent}>
                              <View style={styles.reviewActionIconCircle}>
                                <Text style={styles.reviewActionButtonIcon}>✓</Text>
                              </View>
                              <Text style={styles.reviewActionButtonText} numberOfLines={1}>Sent</Text>
                            </View>
                          </View>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                </>
              )}
              </LinearGradient>
            </View>
          ) : (
            <View style={styles.reviewEmptyCardModern}>
              <View style={styles.reviewEmptyIconBox}>
                <Text style={styles.reviewEmptyIconText}>CL</Text>
              </View>
              <Text style={styles.reviewEmptyTitle}>No Cover Letter Generated</Text>
              <Text style={styles.reviewEmptySubtitle}>Generate a professional cover letter to review and send to this recipient</Text>
              <TouchableOpacity
                style={styles.reviewEmptyActionBtn}
                onPress={() => {
                  if (creditBalance <= 0) {
                    Alert.alert(
                      'Insufficient Credits',
                      'Remaining credits are 0. Please recharge to continue generating cover letters.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Recharge Now', onPress: () => setScreen('packages') }
                      ]
                    );
                    return;
                  }
                  generateCoverLetterForReview(currentReviewTab);
                }}
                disabled={reviewGeneratingIndex === currentReviewTab || reviewGeneratingAll || reviewGeneratingAndSendingAll}
                activeOpacity={0.8}
              >
                <LinearGradient
                  colors={['#667eea', '#764ba2']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.reviewEmptyActionGradient}
                >
                  <Text style={styles.reviewEmptyActionText}>Generate Cover Letter</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* Bulk Actions Card - Modern Design */}
          <View style={styles.reviewBulkActionsCard}>
            <LinearGradient
              colors={['#1e293b', '#334155', '#475569']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.reviewBulkActionsGradient}
            >
              {/* Header Section */}
              <View style={styles.reviewBulkActionsHeaderSection}>
                <View>
                  <Text style={styles.reviewBulkActionsTitle}>Batch Operations</Text>
                  <Text style={styles.reviewBulkActionsSubtitle}>Manage all {recipients.length} applications at once</Text>
                </View>
                <View style={styles.reviewBulkActionsStatusBadge}>
                  <View style={styles.reviewBulkActionsStatusDot} />
                  <Text style={styles.reviewBulkActionsStatusText}>Ready</Text>
                </View>
              </View>

              {/* Action Grid */}
              <View style={styles.reviewBulkActionsGrid}>
                {/* Generate All Button */}
                <TouchableOpacity
                  onPress={generateAllCoverLettersForReview}
                  disabled={false}
                  activeOpacity={0.85}
                  style={styles.reviewBulkActionCard}
                >
                  <LinearGradient
                    colors={['#10b981', '#059669', '#047857']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.reviewBulkActionCardGradient}
                  >
                    <View style={styles.reviewBulkActionIconContainer}>
                      <View style={styles.reviewBulkActionIconOuter}>
                        <Text style={styles.reviewBulkActionIconSymbol}>↻</Text>
                      </View>
                    </View>
                    <View style={styles.reviewBulkActionTextContainer}>
                      <Text style={styles.reviewBulkActionTitle}>Generate All</Text>
                      <Text style={styles.reviewBulkActionDesc}>Create cover letters</Text>
                    </View>
                  </LinearGradient>
                </TouchableOpacity>

                {/* Send All Button */}
                <TouchableOpacity
                  onPress={sendAllApplicationsFromReview}
                  disabled={false}
                  activeOpacity={0.85}
                  style={styles.reviewBulkActionCard}
                >
                  {allApplicationsSent ? (
                    <View style={styles.reviewBulkActionCardCompleted}>
                      <View style={styles.reviewBulkActionIconContainer}>
                        <View style={styles.reviewBulkActionIconOuter}>
                          <Text style={styles.reviewBulkActionIconSymbol}>✓</Text>
                        </View>
                      </View>
                      <View style={styles.reviewBulkActionTextContainer}>
                        <Text style={styles.reviewBulkActionTitle}>All Sent</Text>
                        <Text style={styles.reviewBulkActionDesc}>Task completed</Text>
                      </View>
                    </View>
                  ) : (
                    <LinearGradient
                      colors={['#3b82f6', '#2563eb', '#1d4ed8']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.reviewBulkActionCardGradient}
                    >
                      <View style={styles.reviewBulkActionIconContainer}>
                        <View style={styles.reviewBulkActionIconOuter}>
                          <Text style={styles.reviewBulkActionIconSymbol}>↑</Text>
                        </View>
                      </View>
                      <View style={styles.reviewBulkActionTextContainer}>
                        <Text style={styles.reviewBulkActionTitle}>Send All</Text>
                        <Text style={styles.reviewBulkActionDesc}>Email applications</Text>
                      </View>
                    </LinearGradient>
                  )}
                </TouchableOpacity>

                {/* Generate & Send All Button */}
                <TouchableOpacity
                  onPress={generateAndSendAllApplications}
                  disabled={false}
                  activeOpacity={0.85}
                  style={styles.reviewBulkActionCard}
                >
                  {allApplicationsSent ? (
                    <View style={styles.reviewBulkActionCardCompleted}>
                      <View style={styles.reviewBulkActionIconContainer}>
                        <View style={styles.reviewBulkActionIconOuter}>
                          <Text style={styles.reviewBulkActionIconSymbol}>✓</Text>
                        </View>
                      </View>
                      <View style={styles.reviewBulkActionTextContainer}>
                        <Text style={styles.reviewBulkActionTitle}>Completed</Text>
                        <Text style={styles.reviewBulkActionDesc}>All processed</Text>
                      </View>
                    </View>
                  ) : (
                    <LinearGradient
                      colors={['#8b5cf6', '#7c3aed', '#6d28d9']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.reviewBulkActionCardGradient}
                    >
                      <View style={styles.reviewBulkActionIconContainer}>
                        <View style={styles.reviewBulkActionIconOuter}>
                          <Text style={styles.reviewBulkActionIconSymbol}>▶</Text>
                        </View>
                      </View>
                      <View style={styles.reviewBulkActionTextContainer}>
                        <Text style={styles.reviewBulkActionTitle}>Auto Process</Text>
                        <Text style={styles.reviewBulkActionDesc}>Generate & send</Text>
                      </View>
                    </LinearGradient>
                  )}
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </View>

          <View style={{ height: 30 }} />
        </ScrollView>
        
        {/* Full Screen Loading Overlay - Modern Design */}
        <Modal
          visible={isAnyLoadingActive}
          transparent={true}
          animationType="fade"
        >
          <View style={styles.loadingModalOverlay}>
            <View style={styles.loadingModalContainer}>
              <LinearGradient
                colors={['#1e293b', '#334155', '#475569']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.loadingModalGradient}
              >
                {/* Animated Loader */}
                <View style={styles.loadingAnimationContainer}>
                  <View style={styles.loadingSpinnerOuter}>
                    <ActivityIndicator size="large" color="#ffffff" />
                  </View>
                  <View style={styles.loadingGlowEffect} />
                </View>
                
                {/* Status Text */}
                <View style={styles.loadingTextContainer}>
                  <Text style={styles.loadingTitleText}>
                    {reviewGeneratingAll ? 'Generating Cover Letters' :
                     reviewSendingAll ? 'Sending Applications' :
                     reviewGeneratingAndSendingAll ? 'Auto Processing' :
                     reviewDownloading ? 'Preparing Download' :
                     reviewLoading ? 'Sending Application' :
                     'Processing Request'}
                  </Text>
                  <Text style={styles.loadingSubtitleText}>
                    {progressiveLoadingMessage ? progressiveLoadingMessage :
                     reviewGeneratingAll ? 'Creating professional cover letters for all recipients' :
                     reviewSendingAll ? 'Delivering applications to all recipients' :
                     reviewGeneratingAndSendingAll ? 'Generating and sending to all recipients' :
                     reviewDownloading ? 'Generating your PDF document' :
                     reviewLoading ? 'Delivering your application via email' :
                     'Please wait while we process your request'}
                  </Text>
                </View>
                
                {/* Progress Bar */}
                {(progressiveLoadingProgress > 0 || reviewGeneratingAll || reviewSendingAll || reviewGeneratingAndSendingAll) && (
                  <View style={styles.loadingProgressSection}>
                    <View style={styles.loadingProgressBarContainer}>
                      <View style={styles.loadingProgressBarBackground}>
                        <Animated.View style={[
                          styles.loadingProgressBarFill,
                          {
                            width: progressAnimValue.interpolate({
                              inputRange: [0, 100],
                              outputRange: ['0%', '100%']
                            })
                          }
                        ]}>
                          <LinearGradient
                            colors={['#10b981', '#059669', '#047857']}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 0 }}
                            style={styles.loadingProgressGradient}
                          />
                        </Animated.View>
                      </View>
                    </View>
                    <View style={styles.loadingProgressTextContainer}>
                      <Text style={styles.loadingProgressPercentage}>{progressiveLoadingProgress}%</Text>
                      <Text style={styles.loadingProgressLabel}>Complete</Text>
                    </View>
                  </View>
                )}
                
                {/* Cancel Button */}
                <TouchableOpacity 
                  style={styles.loadingCancelButton}
                  onPress={cancelOperation}
                  activeOpacity={0.85}
                >
                  <View style={styles.loadingCancelButtonInner}>
                    <Text style={styles.loadingCancelIcon}>✕</Text>
                    <Text style={styles.loadingCancelText}>Cancel Operation</Text>
                  </View>
                </TouchableOpacity>
              </LinearGradient>
            </View>
          </View>
        </Modal>

        {/* Payment WebView Modal */}
        <Modal
          visible={showPaymentModal}
          animationType="slide"
          onRequestClose={() => {
            setShowPaymentModal(false);
            setPaymentUrl('');
          }}
        >
          <SafeAreaViewContext style={{flex: 1, backgroundColor: '#fff'}}>
            <View style={{flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb'}}>
              <TouchableOpacity 
                onPress={() => {
                  setShowPaymentModal(false);
                  setPaymentUrl('');
                }}
                style={{padding: 8}}
              >
                <Text style={{fontSize: 16, color: '#3b82f6'}}>✕ Close</Text>
              </TouchableOpacity>
              <Text style={{flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600'}}>Complete Payment</Text>
              <View style={{width: 50}} />
            </View>
            <WebView
              source={{ uri: paymentUrl }}
              style={{flex: 1}}
              onNavigationStateChange={(navState) => {
                // Check if payment was successful or failed
                if (navState.url.includes('/payment-success.html')) {
                  setTimeout(() => {
                    setShowPaymentModal(false);
                    setPaymentUrl('');
                    // Reload credits
                    fetch(`${API_BASE}/user/credits`, {
                      method: 'GET',
                      headers: {
                        'Authorization': `Bearer ${user.token}`,
                        'Content-Type': 'application/json',
                      }
                    })
                    .then(res => res.json())
                    .then(data => {
                      if (data.success) {
                        setCreditBalance(data.balance || 0);
                        Alert.alert('Success', 'Payment completed! Your credits have been added.');
                      }
                    })
                    .catch(err => console.error('Failed to reload credits:', err));
                  }, 1000);
                } else if (navState.url.includes('/payment-failure.html')) {
                  setTimeout(() => {
                    setShowPaymentModal(false);
                    setPaymentUrl('');
                    Alert.alert('Payment Failed', 'Payment was not completed. Please try again.');
                  }, 1000);
                }
              }}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={true}
              scalesPageToFit={true}
            />
          </SafeAreaViewContext>
        </Modal>

        {/* Review Date Picker — Android renders the native dialog directly (tap
            selects, applies, and closes). iOS modal below is unchanged. */}
        {Platform.OS === 'android' && showReviewDatePicker && (
          <DateTimePicker
            value={selectedReviewDate}
            mode="date"
            display="default"
            onChange={(event, date) => {
              setShowReviewDatePicker(false);
              if (event.type === 'set' && date) {
                setEditedCoverLetterData({
                  ...editedCoverLetterData,
                  date: date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                });
              }
            }}
          />
        )}
        {/* Review Date Picker Modal (iOS) */}
        {Platform.OS === 'ios' && (
        <Modal
          transparent={true}
          visible={showReviewDatePicker}
          animationType="slide"
          onRequestClose={() => setShowReviewDatePicker(false)}
        >
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => setShowReviewDatePicker(false)}>
              <View style={{ flex: 1 }} />
            </TouchableWithoutFeedback>
            <SafeAreaViewContext style={styles.datePickerModalWrapper}>
              <View style={styles.datePickerModal}>
                {/* Header */}
                <View style={styles.datePickerHeader}>
                  <View style={styles.datePickerHeaderLine} />
                  <Text style={styles.datePickerTitle}>Cover Letter Date</Text>
                </View>
                
                {/* Date Picker Container */}
                <View style={styles.datePickerContainer}>
                  <DateTimePicker
                    value={selectedReviewDate}
                    mode="date"
                    display="spinner"
                    onChange={(event, date) => {
                      const currentDate = date || selectedReviewDate;
                      setSelectedReviewDate(currentDate);
                      selectedReviewDateRef.current = currentDate;
                    }}
                    themeVariant="light"
                    style={{ height: 216, width: '100%' }}
                  />
                </View>
                
                {/* Buttons */}
                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => setShowReviewDatePicker(false)}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity
                    style={styles.modalConfirmButton}
                    onPress={() => {
                      const formattedDate = selectedReviewDateRef.current.toLocaleDateString('en-US', { 
                        month: 'long', 
                        day: 'numeric', 
                        year: 'numeric' 
                      });
                      setEditedCoverLetterData({ 
                        ...editedCoverLetterData, 
                        date: formattedDate 
                      });
                      setShowReviewDatePicker(false);
                    }}
                  >
                    <View style={styles.confirmButtonWrapper}>
                      <LinearGradient
                        colors={['#667eea', '#764ba2']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.modalConfirmGradient}
                      >
                        <Text style={styles.modalConfirmText}>Confirm</Text>
                      </LinearGradient>
                    </View>
                  </TouchableOpacity>
                </View>
              </View>
            </SafeAreaViewContext>
          </View>
        </Modal>
        )}
      </SafeAreaViewContext>
    );
  }

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  modernContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  gradientContainer: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },

  // ===== MODERN HEADER CARD =====
  modernHeaderCard: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 20,
    borderRadius: 24,
    padding: 20,
    paddingTop: 24,
    paddingBottom: 24,
    shadowColor: '#667eea',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerLeft: {
    flex: 1,
  },
  headerRightActions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  notificationButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  notificationIconWrapper: {
    position: 'relative',
  },
  bellIconContainer: {
    width: 20,
    height: 20,
    position: 'relative',
    alignItems: 'center',
  },
  bellHandle: {
    width: 4,
    height: 2,
    backgroundColor: '#ffffff',
    borderRadius: 2,
    marginBottom: 1,
  },
  bellBody: {
    width: 16,
    height: 14,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  bellOpening: {
    width: 18,
    height: 2,
    backgroundColor: '#ffffff',
    borderRadius: 1,
    marginTop: 1,
  },
  notificationBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: '#ef4444',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  notificationBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  modernMenuButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modernMenuIcon: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '700',
  },
  headerGreeting: {
    marginBottom: 20,
  },
  modernGreeting: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.85)',
    fontWeight: '500',
    marginBottom: 4,
    letterSpacing: 0.3,
  },
  modernUserName: {
    fontSize: 26,
    color: '#ffffff',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  modernCreditBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  creditBadgeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  creditBadgeIcon: {
    fontSize: 28,
  },
  creditBadgeLabel: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.85)',
    fontWeight: '500',
    marginBottom: 2,
  },
  creditBadgeAmount: {
    fontSize: 24,
    color: '#ffffff',
    fontWeight: '800',
  },
  creditBadgeArrow: {
    fontSize: 24,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '300',
  },
  
  // ===== HEADER CREDITS BADGE =====
  headerCreditsBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  creditsIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  creditsIcon: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '700',
  },
  creditsInfo: {
    flex: 1,
  },
  creditsLabel: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.85)',
    fontWeight: '600',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  creditsValue: {
    fontSize: 26,
    color: '#ffffff',
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  creditsArrow: {
    fontSize: 20,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '600',
  },

  // ===== STATS GRID =====
  statsGridContainer: {
    paddingHorizontal: 0,
    marginTop: -24,
    marginBottom: 20,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 0,
  },
  statTileWrapper: {
    width: '48.5%',
    height: 130,
    borderRadius: 16,
    overflow: 'hidden',
  },
  statTile: {
    width: '100%',
    height: 130,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: {
        elevation: 0,
      },
    }),
    borderWidth: 1,
    borderColor: '#f0f0f0',
    overflow: 'hidden',
  },
  statTileBackContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 130,
  },
  statTileBack: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 98,
  },
  statBackTitle: {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  statBackDate: {
    fontSize: 12,
    color: '#667eea',
    fontWeight: '600',
    marginBottom: 3,
  },
  statBackCompany: {
    fontSize: 13,
    color: '#1a1a2e',
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.2,
    lineHeight: 18,
  },
  statBackValue: {
    fontSize: 28,
    color: '#667eea',
    fontWeight: '900',
    marginBottom: 3,
    lineHeight: 32,
  },
  statBackLabel: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 15,
  },
  statBackEmpty: {
    fontSize: 12,
    color: '#9ca3af',
    fontWeight: '500',
    fontStyle: 'italic',
    marginTop: 4,
  },
  statTileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  statIconBox: {
    width: 54,
    height: 54,
    borderRadius: 15,
    backgroundColor: '#f5f7ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statIconText: {
    fontSize: 27,
    color: '#667eea',
    fontWeight: '600',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '900',
    color: '#1a1a2e',
    letterSpacing: 0.5,
  },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    lineHeight: 14,
  },

  // ===== MODERN PAGE HEADER =====
  modernPageHeader: {
    paddingHorizontal: 20,
    marginBottom: 24,
  },
  modernPageTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1a1a2e',
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  modernPageSubtitle: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '500',
    letterSpacing: 0.2,
    lineHeight: 20,
  },

  // ===== MODERN WELCOME SECTION =====
  modernWelcomeSection: {
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  modernWelcomeTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a2e',
    marginBottom: 6,
  },
  modernWelcomeSubtitle: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '400',
  },

  // ===== MODERN STATS GRID =====
  modernStatsGrid: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 24,
  },
  modernStatCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  statCardIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#f5f7ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  statCardIcon: {
    fontSize: 28,
  },
  statCardNumber: {
    fontSize: 28,
    fontWeight: '800',
    color: '#667eea',
    marginBottom: 4,
  },
  statCardLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
    textAlign: 'center',
  },

  // ===== MODERN RECIPIENTS SECTION =====
  modernRecipientsSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  modernSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 12,
  },
  modernSectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a1a2e',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  modernSectionSubtitle: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '500',
    letterSpacing: 0.2,
    lineHeight: 20,
  },
  modernCountBadge: {
    flexDirection: 'row',
    backgroundColor: '#667eea',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    gap: 6,
    shadowColor: '#667eea',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  modernCountBadgeIcon: {
    fontSize: 12,
    color: '#ffffff',
    fontWeight: '700',
  },
  modernCountBadgeText: {
    fontSize: 15,
    color: '#ffffff',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  
  // Refresh button styles
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  refreshButtonIcon: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: '700',
  },
  refreshButtonIconSpinning: {
    opacity: 0.7,
  },
  refreshButtonText: {
    fontSize: 14,
    color: '#ffffff',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  
  // ===== MODERN RECIPIENT CARD =====
  modernRecipientCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  modernFormHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  recipientNumberBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#667eea',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    shadowColor: '#667eea',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  recipientNumberText: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  recipientHeaderInfo: {
    flex: 1,
  },
  recipientHeaderTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  modernFormTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1a1a2e',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  recipientSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6b7280',
    letterSpacing: 0.2,
  },
  modernRemoveBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  modernRemoveIcon: {
    fontSize: 22,
    color: '#dc2626',
    fontWeight: '700',
  },
  modernFormGroup: {
    marginBottom: 18,
  },
  modernFormLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  required: {
    color: '#ef4444',
  },
  modernFormInput: {
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    fontSize: 15,
    color: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    letterSpacing: 0.2,
  },
  modernFormInputError: {
    borderColor: '#ef4444',
    borderWidth: 1.5,
  },
  modernErrorMessage: {
    fontSize: 12,
    color: '#ef4444',
    marginTop: 6,
    fontWeight: '500',
  },
  
  // ===== MODERN BUTTONS =====
  modernAddRecipientBtn: {
    backgroundColor: '#f9fafb',
    borderRadius: 16,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#d1d5db',
  },
  addBtnIconBox: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#667eea',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    shadowColor: '#667eea',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  modernAddIcon: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '700',
  },
  modernAddText: {
    fontSize: 15,
    color: '#374151',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  modernActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 24,
    shadowColor: '#667eea',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
    gap: 12,
  },
  modernActionBtnIcon: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '600',
  },
  modernActionBtnText: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '800',
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  modernActionBtnArrow: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: '800',
  },
  
  // ===== MODERN RECENT APPLICATIONS =====
  modernRecentSection: {
    paddingHorizontal: 16,
    marginTop: 20,
    marginBottom: 24,
  },
  modernEmptyState: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 40,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  emptyStateIconBox: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#f5f7fa',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  modernEmptyIcon: {
    fontSize: 32,
    color: '#9ca3af',
    fontWeight: '300',
  },
  modernEmptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 6,
    letterSpacing: 0.3,
  },
  modernEmptySubtitle: {
    fontSize: 13,
    color: '#9ca3af',
    textAlign: 'center',
    letterSpacing: 0.2,
    lineHeight: 18,
  },
  modernApplicationsList: {
    gap: 14,
  },
  modernApplicationCard: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#667eea',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#f0f0f0',
    marginBottom: 2,
  },
  applicationAccentBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  accentBarPending: {
    backgroundColor: '#f59e0b',
  },
  accentBarReplied: {
    backgroundColor: '#10b981',
  },
  applicationCardInner: {
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 14,
  },
  applicationTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  applicationNumberBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f5f7ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 2,
    borderColor: '#e0e7ff',
  },
  applicationNumberText: {
    fontSize: 15,
    color: '#667eea',
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  applicationMainInfo: {
    flex: 1,
    marginRight: 10,
  },
  applicationCompany: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1a1a2e',
    marginBottom: 4,
    letterSpacing: 0.3,
  },
  applicationPosition: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  modernStatusBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modernStatusPending: {
    backgroundColor: '#fef3c7',
  },
  modernStatusReplied: {
    backgroundColor: '#d1fae5',
  },
  modernStatusText: {
    fontSize: 16,
    fontWeight: '700',
  },
  statusTextPending: {
    color: '#f59e0b',
  },
  statusTextReplied: {
    color: '#10b981',
  },
  clockIcon: {
    width: 16,
    height: 16,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockCircle: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#f59e0b',
  },
  clockHourHand: {
    position: 'absolute',
    width: 2,
    height: 5,
    backgroundColor: '#f59e0b',
    borderRadius: 1,
    top: 3,
  },
  clockMinuteHand: {
    position: 'absolute',
    width: 2,
    height: 7,
    backgroundColor: '#f59e0b',
    borderRadius: 1,
    top: 1,
    transform: [{ rotate: '90deg' }],
  },
  applicationDatesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    padding: 12,
    gap: 16,
  },
  dateItem: {
    flex: 1,
  },
  dateLabel: {
    fontSize: 10,
    color: '#9ca3af',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  dateValue: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  dateValueReplied: {
    color: '#10b981',
  },
  dateSeparator: {
    width: 1,
    height: 24,
    backgroundColor: '#e5e7eb',
  },
  modernActionHint: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  modernActionHintText: {
    fontSize: 11,
    color: '#667eea',
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  
  // ===== LOADING OVERLAY =====
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  loadingContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 30,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 15,
    width: '85%',
    borderWidth: 2,
    borderColor: '#e5e7eb',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
    marginBottom: 10,
  },
  progressBarContainer: {
    width: '100%',
    marginTop: 15,
    marginBottom: 10,
  },
  progressBar: {
    width: '100%',
    height: 8,
  },
  progressBarWrapper: {
    width: '100%',
    marginBottom: 8,
  },
  progressBarTrack: {
    width: '100%',
    height: 8,
    backgroundColor: '#e5e7eb',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#0d9488',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    marginTop: 5,
  },
  cancelButton: {
    marginTop: 20,
    backgroundColor: '#ef4444',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  cancelButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  
  // ===== LOGIN/REGISTER STYLES =====
  gradientHeader: {
    backgroundColor: '#1E40AF',
    paddingTop: 60,
    paddingBottom: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 12,
  },
  logo: {
    fontSize: 48,
    marginBottom: 8,
  },
  logoText: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
    fontWeight: '500',
  },
  
  mainCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: -30,
    marginBottom: 20,
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  cardTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 8,
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 20,
  },
  
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
  },
  inputIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 15,
    color: '#1F2937',
  },
  
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#DC2626',
  },
  errorIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: '#991B1B',
    fontWeight: '500',
  },
  
  primaryButton: {
    backgroundColor: '#1E40AF',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#1E40AF',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 3,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e5e7eb',
  },
  dividerText: {
    fontSize: 12,
    color: '#9CA3AF',
    marginHorizontal: 12,
    fontWeight: '500',
  },
  
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#8C8C8C',
    borderRadius: 10,
    paddingVertical: 12,
    marginBottom: 16,
  },
  googleButtonIcon: {
    fontSize: 22,
    marginRight: 10,
    fontWeight: '700',
  },
  googleButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
  },
  
  footerText: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  footerLabel: {
    fontSize: 14,
    color: '#6B7280',
  },
  footerLink: {
    fontSize: 14,
    color: '#1E40AF',
    fontWeight: '700',
  },

  // ===== DASHBOARD STYLES =====
  dashboardHeader: {
    backgroundColor: '#1E40AF',
    paddingTop: 60,
    paddingBottom: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  avatarContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatar: {
    fontSize: 44,
  },
  welcomeTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
    textAlign: 'center',
  },
  welcomeSubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
  },
  
  infoCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: -30,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  infoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
  },
  infoBadge: {
    backgroundColor: '#DCFCE7',
    color: '#166534',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    fontSize: 12,
    fontWeight: '600',
  },
  infoItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  infoLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 6,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1F2937',
  },
  
  actionsCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  actionsTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 16,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginBottom: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  actionIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  actionContent: {
    flex: 1,
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 2,
  },
  actionDescription: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  actionArrow: {
    fontSize: 18,
    color: '#D1D5DB',
    marginLeft: 8,
  },
  
  logoutButton: {
    backgroundColor: '#EF4444',
    marginHorizontal: 16,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 3,
  },
  logoutIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  logoutButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

  // ===== RECIPIENTS DASHBOARD STYLES =====
  premiumHeader: {
    backgroundColor: '#f8fafc',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 0,
  },
  premiumGradientHeader: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingTop: 50,
  },
  compactCreditBadgeGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
    gap: 6,
  },
  creditNumberWhite: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  menuIconButtonGradient: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -19,
  },
  menuIconWhite: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '700',
  },
  headerContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  logoSection: {
    alignItems: 'flex-start',
    flex: 1,
    marginLeft: -18,
  },
  headerRightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerLargeLogo: {
    fontSize: 40,
    marginRight: 12,
  },
  headerBrandName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1F2937',
    letterSpacing: -0.5,
  },
  headerBrandSubtext: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
    fontWeight: '500',
  },
  compactCreditBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
    gap: 6,
  },
  creditIcon: {
    fontSize: 16,
  },
  creditNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  headerMenuButton: {
    marginLeft: 12,
  },
  menuIconButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -19,
  },
  menuIcon: {
    fontSize: 20,
    color: '#374151',
    fontWeight: '700',
  },

  quickMenu: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 16,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  menuItemIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  menuItemContent: {
    flex: 1,
  },
  menuItemTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 2,
  },
  menuItemDesc: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#f3f4f6',
    marginHorizontal: 14,
  },

  // ===== SIDE MENU MODAL STYLES =====
  modalMenuContainer: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  modalMenuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalMenuContent: {
    width: 280,
    height: '100%',
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: -4, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 10,
  },
  sideMenuContent: {
    flex: 1,
    paddingTop: 50,
  },
  closeMenuButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
    marginRight: 16,
    marginBottom: 20,
  },
  closeMenuIcon: {
    fontSize: 24,
    color: '#6B7280',
    fontWeight: '600',
  },
  sideMenuItems: {
    flex: 1,
  },
  sideMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  sideMenuItemIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#f5f7ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  sideMenuItemIconText: {
    fontSize: 18,
    color: '#667eea',
    fontWeight: '600',
  },
  sideMenuItemIcon: {
    fontSize: 28,
    marginRight: 14,
  },
  sideMenuItemContent: {
    flex: 1,
  },
  sideMenuItemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 2,
    letterSpacing: 0.2,
  },
  sideMenuItemDesc: {
    fontSize: 13,
    color: '#9CA3AF',
    letterSpacing: 0.1,
  },
  sideMenuDivider: {
    height: 1,
    backgroundColor: '#f3f4f6',
    marginVertical: 8,
  },

  dashboardHeaderNew: {
    backgroundColor: '#059669',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#047857',
  },
  headerLogoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },

  welcomeSection: {
    paddingHorizontal: 20,
    paddingVertical: 8.2,
  },
  welcomeSectionGradient: {
    paddingHorizontal: 20,
    paddingVertical: 8.2,
  },
  welcomeTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 4,
  },
  welcomeTitleWhite: {
    fontSize: 21,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 4,
  },
  welcomeSubtitle: {
    fontSize: 11,
    color: '#6B7280',
  },
  welcomeSubtitleWhite: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.9)',
  },

  recipientsSection: {
    paddingHorizontal: 16,
    paddingTop: 5.76,
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
  },
  addButton: {
    backgroundColor: '#059669',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  addButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },

  emptyState: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 4,
  },
  emptyDescription: {
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 16,
    textAlign: 'center',
  },

  recipientCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },

  // ===== COMPACT CREDIT BADGE STYLES =====
  compactCreditBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
    gap: 6,
  },
  creditIcon: {
    fontSize: 16,
  },
  creditNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },

  // ===== STATISTICS SECTION STYLES =====
  statsOnlySection: {
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  statsOnlySectionGradient: {
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  statisticsSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  statsCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#0d9488',
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  statsCardGradient: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 18.36,
    paddingHorizontal: 16,
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statNumber: {
    fontSize: 24.48,
    fontWeight: '700',
    color: '#0d9488',
    marginBottom: 6.12,
  },
  statNumberWhite: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 9.945,
    color: '#6B7280',
    fontWeight: '500',
  },
  statLabelWhite: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.9)',
    textAlign: 'center',
  },
  countriesCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  countriesTitle: {
    fontSize: 12.6,
    fontWeight: '700',
    color: '#1F2937',
    paddingHorizontal: 16,
    paddingTop: 14.4,
    paddingBottom: 10.8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10.8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  countryRank: {
    fontSize: 12.6,
    fontWeight: '700',
    color: '#0d9488',
    marginRight: 12,
    width: 24,
  },
  countryContent: {
    flex: 1,
  },
  countryName: {
    fontSize: 12.6,
    fontWeight: '600',
    color: '#1F2937',
  },
  countryCount: {
    fontSize: 12.6,
    fontWeight: '700',
    color: '#0d9488',
    backgroundColor: '#D1F2EB',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  countriesSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  
  // ===== EMPLOYERS SECTION (REDESIGNED) =====
  employersSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  employersSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  employersSectionTitle: {
    fontSize: 16.5,
    fontWeight: '800',
    color: '#111827',
    letterSpacing: -0.3,
  },
  employersBadge: {
    backgroundColor: '#0d9488',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    minWidth: 28,
    alignItems: 'center',
  },
  employersBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  
  // Empty State
  emptyStateContainer: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#E5E7EB',
    borderStyle: 'dashed',
  },
  emptyStateIcon: {
    fontSize: 42,
    marginBottom: 12,
  },
  emptyStateTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 6,
  },
  emptyStateSubtitle: {
    fontSize: 12.5,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
  },
  
  // Employers List
  employersListContainer: {
    gap: 12,
  },
  employerCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    marginBottom: 12,
  },
  statusIndicator: {
    height: 4,
    width: '100%',
  },
  statusPending: {
    backgroundColor: '#FCA5A5',
  },
  statusReplied: {
    backgroundColor: '#6EE7B7',
  },
  employerCardContent: {
    padding: 14,
  },
  employerMainInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  employerNumberBadge: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#F0FDFA',
    borderWidth: 1.5,
    borderColor: '#99F6E4',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  employerNumber: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0d9488',
  },
  employerDetails: {
    flex: 1,
  },
  employerCompanyName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  employerJobPosition: {
    fontSize: 12.5,
    color: '#6B7280',
    fontWeight: '500',
  },
  
  // Status & Dates Row
  employerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusBadgePending: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  statusBadgeReplied: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusBadgeTextPending: {
    color: '#DC2626',
  },
  statusBadgeTextReplied: {
    color: '#059669',
  },
  datesContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dateItem: {
    alignItems: 'flex-end',
  },
  dateLabelSmall: {
    fontSize: 9,
    color: '#9CA3AF',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  dateValueSmall: {
    fontSize: 11.5,
    color: '#374151',
    fontWeight: '700',
    marginTop: 2,
  },
  dateValueReplied: {
    fontSize: 11.5,
    color: '#059669',
    fontWeight: '800',
    marginTop: 2,
  },
  dateSeparator: {
    fontSize: 12,
    color: '#D1D5DB',
    marginHorizontal: 8,
    fontWeight: '600',
  },
  
  // Action Hint
  actionHintContainer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    alignItems: 'center',
  },
  actionHintText: {
    fontSize: 11,
    color: '#0d9488',
    fontWeight: '600',
  },

  // ===== RECIPIENT FORM STYLES =====
  recipientFormCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#0d9488',
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  formHeaderBar: {
    backgroundColor: '#0d9488',
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 0,
    borderBottomColor: '#e5e7eb',
  },
  formHeaderNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    marginRight: 10,
    backgroundColor: '#0f766e',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  formHeaderTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    flex: 1,
  },
  removeRecipientBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  removeRecipientIcon: {
    fontSize: 20,
    color: '#ef4444',
    fontWeight: 'bold',
  },
  formGroup: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  formLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  required: {
    color: '#dc2626',
  },
  formInput: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1F2937',
  },
  datePickerButton: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
    justifyContent: 'center',
  },
  datePickerText: {
    fontSize: 14,
    color: '#1F2937',
  },
  formInputError: {
    borderColor: '#ef4444',
    backgroundColor: '#fee2e2',
  },
  errorMessage: {
    fontSize: 12,
    color: '#ef4444',
    marginTop: 6,
    fontWeight: '500',
    paddingHorizontal: 16,
  },
  addRecipientBtn: {
    backgroundColor: '#f0f9ff',
    borderWidth: 2,
    borderColor: '#0ea5e9',
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  addRecipientIcon: {
    fontSize: 24,
    color: '#0ea5e9',
    fontWeight: '700',
    marginRight: 8,
  },
  addRecipientText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0ea5e9',
  },

  actionButtonsGroup: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  fullWidthActionBtn: {
    width: '100%',
    backgroundColor: '#10b981',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
    flexDirection: 'row',
    marginBottom: 20,
  },
  fullWidthActionBtnIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  fullWidthActionBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.3,
  },
  secondaryActionBtn: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
    flexDirection: 'row',
  },
  secondaryActionBtnIcon: {
    fontSize: 18,
    marginRight: 6,
  },
  secondaryActionBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
  },
  primaryActionBtn: {
    flex: 1,
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
    flexDirection: 'row',
  },
  primaryActionBtnIcon: {
    fontSize: 18,
    marginRight: 6,
  },
  primaryActionBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  recipientInfo: {
    flex: 1,
  },
  recipientName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 4,
  },
  recipientDetails: {
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 2,
  },
  recipientEmail: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  recipientActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionIconButton: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },

  settingsSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  settingItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  settingLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  settingValue: {
    fontSize: 14,
    color: '#1F2937',
    fontWeight: '500',
  },
  settingValueActive: {
    fontSize: 14,
    color: '#059669',
    fontWeight: '600',
  },

  // ===== USAGE & CREDITS SCREEN STYLES =====
  usageHeader: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    marginBottom: 16,
  },
  usageHeaderTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
    textAlign: 'center',
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '500',
  },
  usageCreditCard: {
    backgroundColor: '#8B5CF6',
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 24,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  usageCreditLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#F3E8FF',
    marginBottom: 8,
  },
  usageCreditNumber: {
    fontSize: 56,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 12,
  },
  usageExpiryWarning: {
    backgroundColor: '#FCD34D',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 8,
  },
  usageExpiryText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#78350F',
  },
  usageMonthCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  usageCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 16,
  },
  usageCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  usageCardIcon: {
    fontSize: 24,
  },
  chartPlaceholder: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 32,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#E5E7EB',
    borderStyle: 'dashed',
  },
  chartPlaceholderText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 8,
  },
  chartPlaceholderSubtext: {
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  chartContainer: {
    paddingVertical: 16,
  },
  chartWithAxis: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  chartYAxis: {
    justifyContent: 'space-between',
    height: 140,
    paddingRight: 8,
    paddingTop: 10,
  },
  chartYAxisLabel: {
    fontSize: 10,
    color: '#6B7280',
    fontWeight: '500',
    textAlign: 'right',
    minWidth: 25,
  },
  chartBars: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 140,
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  chartBarGroup: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  chartBarContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    height: 120,
    marginBottom: 4,
  },
  chartBar: {
    width: 8,
    borderRadius: 3,
    minHeight: 3,
  },
  chartLabel: {
    fontSize: 9,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 4,
  },
  chartLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  chartLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 8,
    marginVertical: 4,
  },
  chartLegendDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 6,
  },
  chartLegendText: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '500',
  },
  usageProgressSection: {
    marginBottom: 16,
  },
  usageProgressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  usageProgressLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  usageProgressValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1F2937',
  },
  usageProgressBar: {
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  usageProgressFill: {
    height: '100%',
    borderRadius: 4,
  },
  usageHistoryCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  usageHistoryItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  usageHistoryLeft: {
    flex: 1,
  },
  usageHistoryType: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  usageHistoryDesc: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '500',
  },
  usageHistoryRight: {
    alignItems: 'flex-end',
  },
  usageHistoryDate: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 4,
  },
  usageHistoryBalance: {
    fontSize: 13,
    color: '#1F2937',
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyStateIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyStateText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  activityTableHeader: {
    flexDirection: 'row',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    marginHorizontal: -20,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  activityTableHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
  },
  activityTableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  activityTableCell: {
    fontSize: 13,
    color: '#6B7280',
  },
  activityHighlight: {
    color: '#8B5CF6',
    fontWeight: '600',
  },
  buyCreditsButton: {
    backgroundColor: '#8B5CF6',
    marginHorizontal: 16,
    marginBottom: 24,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  buyCreditsButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },

  // ===== PROFILE SCREEN STYLES =====
  profileHeader: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    marginBottom: 24,
  },
  backButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0d9488',
  },
  profileHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1F2937',
    flex: 1,
    textAlign: 'center',
  },
  profileCardHeader: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 20,
    marginHorizontal: 16,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  profileAvatarLarge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#0d9488',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  profileAvatarText: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
  },
  editOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editOverlayText: {
    fontSize: 24,
    color: '#fff',
  },
  profileImageContent: {
    width: '100%',
    height: '100%',
    borderRadius: 40,
  },
  profileBasicInfo: {
    flex: 1,
  },
  profileNameLarge: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 4,
  },
  profileEmail: {
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 8,
  },
  profileBadge: {
    backgroundColor: '#D1F2EB',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  profileBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0d9488',
  },
  profileDetailCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    marginHorizontal: 16,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  cardTitleProfile: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1F2937',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  detailLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
    width: 120,
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1F2937',
    flexShrink: 1,
    textAlign: 'right',
  },
  detailValueVerified: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0d9488',
  },
  editFormGroup: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  formLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  formInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1F2937',
    backgroundColor: '#F9FAFB',
  },
  uploadZone: {
    borderWidth: 2,
    borderColor: '#D1D5DB',
    borderStyle: 'dashed',
    borderRadius: 12,
    marginHorizontal: 16,
    marginVertical: 12,
    paddingVertical: 24,
    paddingHorizontal: 16,
    backgroundColor: '#F9FAFB',
  },
  uploadZoneActive: {
    borderColor: '#0d9488',
    backgroundColor: '#e0f2f1',
  },
  uploadPreview: {
    width: '100%',
    height: 150,
    borderRadius: 8,
    resizeMode: 'contain',
  },
  profilePhotoPreview: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignSelf: 'center',
    resizeMode: 'cover',
  },
  uploadPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  uploadText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  uploadHint: {
    fontSize: 11,
    fontWeight: '400',
    color: '#0d9488',
    marginTop: 4,
  },

  // ── Generate Signature button ────────────────────────────────────────────
  generateSigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#F3EEFF',
    borderWidth: 1,
    borderColor: 'rgba(124,107,255,0.25)',
  },
  generateSigBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7C6BFF',
    letterSpacing: 0.2,
  },

  // ── Signature Generator Modal ────────────────────────────────────────────
  sigGenOverlay: {
    flex: 1,
    backgroundColor: 'rgba(11,15,34,0.55)',
    justifyContent: 'flex-end',
  },
  sigGenSheet: {
    backgroundColor: '#E5EAF3',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    maxHeight: '90%',
  },
  sigGenHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(11,15,34,0.15)',
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  sigGenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(11,15,34,0.07)',
  },
  sigGenTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0B0F22',
    letterSpacing: 0.2,
  },
  sigGenSub: {
    fontSize: 12,
    color: '#5B6B8A',
    fontWeight: '500',
    marginTop: 2,
  },
  sigGenCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(11,15,34,0.08)',
  },
  sigGenWebViewWrap: {
    height: 520,
  },
  sigGenWebView: {
    flex: 1,
    backgroundColor: '#E5EAF3',
  },

  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  statItemProfile: {
    alignItems: 'center',
  },
  statValueProfile: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0d9488',
    marginBottom: 4,
  },
  statLabelProfile: {
    fontSize: 11,
    fontWeight: '500',
    color: '#6B7280',
  },
  actionButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1F2937',
  },
  actionButtonIcon: {
    fontSize: 14,
    color: '#D1D5DB',
  },
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    padding: 20,
  },
  modalKeyboardView: {
    width: '100%',
    maxWidth: 400,
    justifyContent: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '85%',
    maxWidth: 400,
    maxHeight: '80%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  modalContentScrollable: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxHeight: Dimensions.get('window').height * 0.75,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  modalScrollContent: {
    paddingBottom: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
  },
  modalCloseBtn: {
    fontSize: 28,
    color: '#9ca3af',
    padding: 5,
    fontWeight: '300',
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    fontSize: 15,
    color: '#1f2937',
    backgroundColor: '#f9fafb',
  },
  modalButton: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    padding: 14,
    marginTop: 8,
    marginBottom: 8,
    alignItems: 'center',
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    marginBottom: 8,
  },
  settingTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 13,
    color: '#6b7280',
    lineHeight: 18,
  },
  toggle: {
    width: 52,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#d1d5db',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 3,
  },
  toggleActive: {
    backgroundColor: '#6366f1',
    alignItems: 'flex-end',
  },
  toggleCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleCircleActive: {
    backgroundColor: '#fff',
  },
  // ACCOUNT MODAL STYLES
  accountModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  accountModalKeyboardView: {
    width: '100%',
  },
  accountModalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    paddingHorizontal: 24,
    maxHeight: Dimensions.get('window').height * 0.85,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  accountModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  accountModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
  },
  accountModalCloseBtn: {
    fontSize: 28,
    color: '#9ca3af',
    padding: 4,
    fontWeight: '300',
  },
  accountModalScrollContent: {
    paddingBottom: 8,
  },
  accountModalInput: {
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    fontSize: 15,
    color: '#1f2937',
    backgroundColor: '#f9fafb',
  },
  accountModalButton: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    marginBottom: 10,
    alignItems: 'center',
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  accountModalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  accountModalButtonSecondary: {
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    alignItems: 'center',
  },
  accountModalButtonSecondaryText: {
    color: '#6b7280',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteWarningText: {
    fontSize: 15,
    color: '#374151',
    lineHeight: 22,
    marginBottom: 16,
  },
  deleteWarningList: {
    fontSize: 14,
    color: '#ef4444',
    lineHeight: 22,
    marginBottom: 20,
    backgroundColor: '#fef2f2',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fee2e2',
  },
  deleteConfirmInstructions: {
    fontSize: 15,
    color: '#374151',
    marginBottom: 12,
    fontWeight: '500',
  },
  deleteConfirmKeyword: {
    fontWeight: '700',
    color: '#ef4444',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  // REVIEW SCREEN STYLES
  reviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  reviewHeaderEnhanced: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  reviewHeaderCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backButton: {
    paddingHorizontal: 8,
  },
  backIcon: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6366f1',
  },
  reviewTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
  },
  reviewTabsContainer: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingVertical: 12,
  },
  reviewTabsScroll: {
    paddingHorizontal: 16,
  },
  reviewTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
  },
  reviewTabActive: {
    backgroundColor: '#6366f1',
  },
  reviewTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  reviewTabTextActive: {
    color: '#fff',
  },
  reviewDetailCard: {
    marginHorizontal: 16,
    marginVertical: 16,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#6366f1',
  },
  reviewDetailTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 12,
  },
  reviewDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'flex-start',
  },
  reviewDetailLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    width: '30%',
    flexShrink: 0,
  },
  reviewDetailValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1f2937',
    width: '68%',
    flexWrap: 'wrap',
  },
  reviewCoverLetterCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  reviewCoverLetterGradient: {
    paddingTop: 0,
  },
  coverLetterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sentBadge: {
    backgroundColor: '#d1fae5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  sentBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#059669',
  },
  coverLetterPreview: {
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  previewLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
  },
  previewContent: {
    maxHeight: 200,
  },
  previewText: {
    fontSize: 13,
    lineHeight: 20,
    color: '#1f2937',
  },
  locationCard: {
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
  },
  locationTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#059669',
    marginBottom: 8,
  },
  locationList: {
    maxHeight: 120,
  },
  locationItem: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  locationText: {
    fontSize: 12,
    color: '#047857',
  },
  reviewActionButtons: {
    flexDirection: 'column',
    gap: 10,
    marginTop: 16,
  },
  reviewActionBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  regenerateBtn: {
    backgroundColor: '#dbeafe',
  },
  downloadBtn: {
    backgroundColor: '#fef3c7',
  },
  sendBtn: {
    backgroundColor: '#6366f1',
  },
  sentBtn: {
    backgroundColor: '#d1d5db',
  },
  reviewActionBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
  },
  reviewEmptyCard: {
    marginHorizontal: 16,
    marginVertical: 16,
    padding: 24,
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#d1d5db',
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#666',
    marginBottom: 16,
    textAlign: 'center',
  },
  generateBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: '#6366f1',
    borderRadius: 8,
    alignItems: 'center',
  },
  generateBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  generateAllBtn: {
    marginHorizontal: 16,
    marginVertical: 16,
    paddingVertical: 14,
    backgroundColor: '#059669',
    borderRadius: 8,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  generateAllBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // ===== REVIEW EDIT MODE STYLES =====
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    backgroundColor: 'transparent',
  },
  reviewRecipientHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  reviewRecipientNumberBadge: {
    fontSize: 13,
    fontWeight: '800',
    color: '#ffffff',
    backgroundColor: '#3b82f6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
    letterSpacing: 0.5,
  },
  reviewCoverLetterTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1e293b',
    letterSpacing: 0.3,
  },
  editButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#e0f2f1',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#0d9488',
    overflow: 'hidden',
    shadowColor: '#0d9488',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  editButtonGradient: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  editModeContainer: {
    backgroundColor: '#f8fafc',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 16,
    marginBottom: 16,
  },
  viewModeContainer: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 4,
  },
  editFieldSection: {
    marginBottom: 16,
  },
  editFieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 10,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  hirngManagerName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#1a1a1a',
    paddingVertical: 12,
    paddingHorizontal: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 6,
  },
  editFieldInput: {
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: '#1e293b',
    backgroundColor: '#ffffff',
    fontWeight: '500',
    shadowColor: '#94a3b8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  readOnlyField: {
    backgroundColor: '#f1f5f9',
    borderColor: '#e2e8f0',
    color: '#64748b',
  },
  addressDropdown: {
    borderWidth: 1,
    borderColor: '#17a2b8',
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  pickerStyle: {
    height: 50,
    color: '#333',
  },
  richTextToolbar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 6,
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 4,
  },
  toolbarBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  toolbarBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
  },
  toolbarDivider: {
    width: 1,
    backgroundColor: '#ddd',
    marginHorizontal: 4,
  },
  richTextInput: {
    height: 220,
    textAlignVertical: 'top',
    borderColor: '#17a2b8',
  },
  editFieldHint: {
    fontSize: 12,
    color: '#888',
    fontStyle: 'italic',
    marginTop: 8,
    paddingHorizontal: 4,
  },
  editButtonGroup: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  editActionBtn: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#64748b',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  editActionGradient: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editActionBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  
  // ===== MODERN REVIEW PAGE STYLES =====
  reviewHeaderCard: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  reviewHeaderGradient: {
    padding: 20,
    position: 'relative',
  },
  reviewBackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  reviewBackIcon: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '700',
    marginRight: 6,
  },
  reviewBackText: {
    fontSize: 15,
    color: '#ffffff',
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  reviewHeaderContent: {
    marginBottom: 8,
  },
  reviewHeaderTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  reviewHeaderSubtitle: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.9)',
    fontWeight: '500',
  },
  reviewCreditBadge: {
    position: 'absolute',
    top: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  reviewCreditIconBox: {
    marginRight: 6,
  },
  reviewDiamondIcon: {
    width: 16,
    height: 16,
  },
  reviewDiamondTop: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#ffffff',
  },
  reviewDiamondBottom: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#ffffff',
  },
  reviewCreditText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  
  // ===== NEW RECIPIENTS CARDS SECTION =====
  recipientsCardsSection: {
    paddingTop: 12,
    paddingBottom: 16,
    marginBottom: 16,
  },
  recipientsCardsSectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    marginBottom: 14,
    marginHorizontal: 20,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  recipientsCardsScroll: {
    paddingLeft: 16,
  },
  recipientsCardsContent: {
    paddingRight: 16,
  },
  recipientCardWrapper: {
    marginRight: 16,
  },
  recipientCardTouchable: {
    width: 260,
    height: 180,
  },
  recipientCardAnimated: {
    width: 260,
    height: 180,
    borderRadius: 24,
    overflow: 'visible',
    shadowColor: '#94a3b8',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  recipientCardBackPosition: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  recipientCardGradient: {
    flex: 1,
    padding: 20,
    paddingTop: 16,
    paddingBottom: 14,
    justifyContent: 'space-between',
    borderRadius: 24,
    overflow: 'hidden',
  },
  recipientCardBottomIndicator: {
    position: 'absolute',
    bottom: 0,
    left: '20%',
    right: '20%',
    height: 4,
    backgroundColor: '#3b82f6',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  recipientCardBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  recipientCardBadgeText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#78350f',
  },
  recipientCardContent: {
    flex: 1,
    justifyContent: 'center',
    paddingRight: 16,
  },
  recipientCardSection: {
    marginBottom: 10,
  },
  recipientCardLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#92400e',
    marginBottom: 3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  recipientCardPosition: {
    fontSize: 15,
    fontWeight: '700',
    color: '#78350f',
    lineHeight: 20,
  },
  recipientCardCompany: {
    fontSize: 14,
    fontWeight: '800',
    color: '#422006',
    lineHeight: 19,
    letterSpacing: 0.3,
  },
  recipientCardEmail: {
    fontSize: 13,
    fontWeight: '600',
    color: '#78350f',
    lineHeight: 18,
  },
  recipientCardFlipHint: {
    fontSize: 9,
    fontWeight: '600',
    color: 'rgba(66, 32, 6, 0.35)',
    textAlign: 'center',
    fontStyle: 'italic',
    letterSpacing: 0.3,
  },
  recipientCardNarrative: {
    fontSize: 13,
    fontWeight: '500',
    color: '#78350f',
    lineHeight: 20,
    textAlign: 'left',
  },
  recipientCardNarrativeBold: {
    fontWeight: '800',
    color: '#422006',
  },
  
  // ===== OLD REVIEW TAB STYLES (KEPT FOR COMPATIBILITY) =====
  reviewTabsWrapper: {
    backgroundColor: '#ffffff',
    paddingTop: 16,
    paddingBottom: 12,
    marginBottom: 16,
  },
  reviewTabsLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#6b7280',
    marginBottom: 12,
    marginHorizontal: 20,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  reviewTabsScroll: {
    paddingHorizontal: 20,
  },
  reviewTab: {
    marginRight: 10,
    borderRadius: 12,
    overflow: 'hidden',
  },
  reviewTabGradient: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  reviewTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
  },
  reviewTabTextActive: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  reviewDetailCardModern: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  reviewDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  reviewDetailAccent: {
    width: 4,
    height: 24,
    borderRadius: 2,
    marginRight: 12,
    background: 'linear-gradient(180deg, #667eea 0%, #764ba2 100%)',
    backgroundColor: '#667eea',
  },
  reviewDetailTitleModern: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    letterSpacing: 0.3,
  },
  reviewDetailContent: {
    padding: 20,
  },
  reviewDetailItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  reviewDetailIconBox: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  reviewDetailIconText: {
    fontSize: 18,
  },
  reviewDetailInfo: {
    flex: 1,
  },
  reviewDetailLabelModern: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9ca3af',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reviewDetailValueModern: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1f2937',
    lineHeight: 22,
  },
  reviewModernActionButtons: {
    marginTop: 24,
    paddingBottom: 28,
    flexDirection: 'row',
    gap: 10,
  },
  reviewActionButtonFull: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  reviewActionButtonGradient: {
    paddingVertical: 16,
    paddingHorizontal: 6,
  },
  reviewActionButtonSentGradient: {
    paddingVertical: 16,
    paddingHorizontal: 6,
    backgroundColor: '#9ca3af',
  },
  reviewActionButtonContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  reviewActionIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.5)',
  },
  reviewActionButtonIcon: {
    fontSize: 17,
    color: '#ffffff',
    fontWeight: '700',
  },
  reviewActionButtonText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  reviewEmptyCardModern: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 32,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  reviewEmptyIconBox: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e0e7ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  reviewEmptyIconText: {
    fontSize: 28,
    fontWeight: '800',
    color: '#4f46e5',
    letterSpacing: 1,
  },
  reviewEmptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  reviewEmptySubtitle: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    paddingHorizontal: 12,
  },
  reviewEmptyActionBtn: {
    borderRadius: 12,
    overflow: 'hidden',
    width: '100%',
  },
  reviewEmptyActionGradient: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  reviewEmptyActionIcon: {
    fontSize: 18,
  },
  reviewEmptyActionText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  reviewBulkActionsCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  reviewBulkActionsGradient: {
    padding: 24,
  },
  reviewBulkActionsHeaderSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  reviewBulkActionsTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  reviewBulkActionsSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#cbd5e1',
    letterSpacing: 0.2,
  },
  reviewBulkActionsStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
  },
  reviewBulkActionsStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
  },
  reviewBulkActionsStatusText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ffffff',
  },
  reviewBulkActionsGrid: {
    gap: 14,
  },
  reviewBulkActionCard: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  reviewBulkActionCardGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 20,
    gap: 16,
  },
  reviewBulkActionCardCompleted: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 20,
    gap: 16,
    backgroundColor: '#64748b',
  },
  reviewBulkActionIconContainer: {
    position: 'relative',
  },
  reviewBulkActionIconOuter: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: 3,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewBulkActionIconSymbol: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
  },
  reviewBulkActionTextContainer: {
    flex: 1,
  },
  reviewBulkActionTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  reviewBulkActionDesc: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.85)',
    letterSpacing: 0.2,
  },
  
  // Loading Modal Styles
  loadingModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  loadingModalContainer: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 28,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 20,
  },
  loadingModalGradient: {
    paddingVertical: 40,
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  loadingAnimationContainer: {
    position: 'relative',
    width: 100,
    height: 100,
    marginBottom: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingSpinnerOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    zIndex: 2,
  },
  loadingGlowEffect: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    top: 0,
    left: 0,
    zIndex: 1,
  },
  loadingTextContainer: {
    width: '100%',
    marginBottom: 32,
    alignItems: 'center',
  },
  loadingTitleText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  loadingSubtitleText: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.75)',
    textAlign: 'center',
    lineHeight: 20,
    letterSpacing: 0.2,
  },
  loadingProgressSection: {
    width: '100%',
    marginBottom: 28,
  },
  loadingProgressBarContainer: {
    width: '100%',
    marginBottom: 12,
  },
  loadingProgressBarBackground: {
    width: '100%',
    height: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  loadingProgressBarFill: {
    height: '100%',
    borderRadius: 6,
    overflow: 'hidden',
  },
  loadingProgressGradient: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  loadingProgressTextContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  loadingProgressPercentage: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  loadingProgressLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.7)',
    letterSpacing: 0.3,
  },
  loadingCancelButton: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(239, 68, 68, 0.5)',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  loadingCancelButtonInner: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    paddingVertical: 16,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingCancelIcon: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fca5a5',
  },
  loadingCancelText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  
  newSocBtn: {
    flex: 1,
    height: 44,
    backgroundColor: '#131A30',
    borderWidth: 0.5,
    borderColor: '#243153',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newInputWrap: {
    backgroundColor: '#0A1226',
    borderWidth: 0.5,
    borderColor: '#1F2A4A',
    borderRadius: 11,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
    marginBottom: 0,
  },
  newInput: {
    flex: 1,
    fontSize: 16,
    color: '#E5EAF5',
    paddingVertical: 0,
  },

  // Login Screen Styles
  loginContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  loginGradientBg: {
    flex: 1,
  },
  loginInnerContainer: {
    flex: 1,
    paddingHorizontal: 28,
  },
  loginLogoSection: {
    alignItems: 'center',
    marginBottom: 60,
    marginTop: 8,
  },
  loginTagline: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.5)',
    fontWeight: '500',
    letterSpacing: 0.3,
    marginTop: 10,
  },
  loginLogoImage: {
    width: 220,
    height: 66,
  },
  loginWelcomeSection: {
    marginBottom: 28,
  },
  loginCardTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  loginCardSubtitle: {
    fontSize: 16,
    fontWeight: '400',
    color: 'rgba(255, 255, 255, 0.5)',
    letterSpacing: 0.1,
  },
  loginErrorContainer: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#ef4444',
    padding: 14,
    marginBottom: 20,
  },
  loginErrorText: {
    fontSize: 14,
    color: '#fecaca',
    fontWeight: '500',
    lineHeight: 20,
  },
  loginFormSection: {
    marginBottom: 24,
  },
  loginInputGroup: {
    marginBottom: 18,
  },
  loginInputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.7)',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  loginInput: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 18,
    paddingVertical: Platform.OS === 'ios' ? 17 : 14,
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '400',
  },
  loginSignInButton: {
    marginTop: 6,
    borderRadius: 14,
    overflow: 'hidden',
  },
  loginButtonDisabled: {
    opacity: 0.6,
  },
  loginSignInGradient: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 17,
  },
  loginSignInText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  loginDividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  loginDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  loginDividerText: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.35)',
    marginHorizontal: 14,
  },
  loginSocialButtonsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 32,
  },
  loginSocialButton: {
    width: 60,
    height: 60,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginSocialButtonDisabled: {
    opacity: 0.5,
  },
  loginSocialIcon: {
    width: 26,
    height: 26,
  },
  loginAppleButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  loginAppleIcon: {
    fontSize: 26,
    color: '#ffffff',
  },
  loginFooter: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loginFooterText: {
    fontSize: 15,
    color: 'rgba(255, 255, 255, 0.45)',
    fontWeight: '400',
  },
  loginFooterLink: {
    fontSize: 15,
    color: '#e94560',
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  
  fieldDisplayRow: {
    marginBottom: 14,
  },
  fieldDisplayRowDouble: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
  },
  fieldDisplay: {
    backgroundColor: '#f8fafc',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  fieldDisplayHalf: {
    flex: 1,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  fieldDisplayLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 6,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  fieldDisplayValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1e293b',
    lineHeight: 22,
  },
  coverLetterPreviewContainer: {
    marginTop: 16,
    marginBottom: 20,
  },
  coverLetterPreviewLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  coverLetterPreviewBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    height: 200,
    padding: 16,
  },
  coverLetterPreviewText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#1e293b',
    fontWeight: '400',
  },
  dropdownButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#ffffff',
    shadowColor: '#94a3b8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  dropdownButtonText: {
    fontSize: 15,
    color: '#1e293b',
    fontWeight: '500',
    flex: 1,
  },
  dropdownArrow: {
    fontSize: 14,
    color: '#64748b',
    marginLeft: 8,
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dropdownMenu: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    width: '85%',
    maxHeight: 300,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
    overflow: 'hidden',
  },
  dropdownItem: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  dropdownItemText: {
    fontSize: 15,
    color: '#1e293b',
    fontWeight: '500',
    lineHeight: 22,
  },
  // ==================== ADMIN PANEL STYLES ====================
  adminModalContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  adminHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 50,
    paddingHorizontal: 20,
    paddingBottom: 20,
    backgroundColor: '#8B5CF6',
  },
  adminHeaderLeft: {
    flex: 1,
  },
  adminHeaderTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  adminHeaderSubtitle: {
    fontSize: 14,
    color: '#E9D5FF',
  },
  adminCloseButton: {
    fontSize: 28,
    color: '#FFFFFF',
    fontWeight: '300',
    paddingHorizontal: 10,
  },
  adminActions: {
    padding: 20,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  createPackageButton: {
    backgroundColor: '#8B5CF6',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
  },
  createPackageButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  adminLoadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  adminLoadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#6B7280',
  },
  adminPackagesList: {
    flex: 1,
    padding: 16,
  },
  adminEmptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  adminEmptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  adminEmptyText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  adminEmptySubtext: {
    fontSize: 14,
    color: '#6B7280',
  },
  packageCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  packageCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  packageName: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  popularBadge: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  popularBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#92400E',
  },
  statusBadgeActive: {
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeTextActive: {
    fontSize: 12,
    fontWeight: '600',
    color: '#065F46',
  },
  statusBadgeInactive: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeTextInactive: {
    fontSize: 12,
    fontWeight: '600',
    color: '#991B1B',
  },
  packageDescription: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 12,
    lineHeight: 20,
  },
  packageDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    marginBottom: 12,
  },
  packageDetailItem: {
    flex: 1,
    alignItems: 'center',
  },
  packageDetailLabel: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 4,
  },
  packageDetailValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  packageActions: {
    flexDirection: 'row',
    gap: 8,
  },
  packageActionButton: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  packageActionButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
  },
  packageActionButtonDanger: {
    backgroundColor: '#FEE2E2',
  },
  packageActionButtonDangerText: {
    color: '#991B1B',
  },
  // Form Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  packageFormModal: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    width: '90%',
    maxWidth: 500,
    overflow: 'hidden',
  },
  packageFormHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  packageFormTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  packageFormClose: {
    fontSize: 28,
    color: '#9CA3AF',
    fontWeight: '300',
    lineHeight: 28,
  },
  packageFormBody: {
    padding: 20,
  },
  adminFormGroup: {
    marginBottom: 20,
  },
  formRowGroup: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  formGroupHalf: {
    flex: 1,
  },
  adminFormLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  adminFormInput: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111827',
  },
  formTextArea: {
    height: 80,
    textAlignVertical: 'top',
    paddingTop: 10,
  },
  formCheckboxContainer: {
    marginBottom: 8,
  },
  formCheckboxRow: {
    flexDirection: 'row',
    gap: 16,
  },
  formCheckboxWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    flex: 1,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    borderRadius: 4,
    marginRight: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  checkboxChecked: {
    backgroundColor: '#8B5CF6',
    borderColor: '#8B5CF6',
  },
  checkboxCheck: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  checkboxLabel: {
    fontSize: 14,
    color: '#374151',
    fontWeight: '500',
  },
  packageFormFooter: {
    flexDirection: 'row',
    gap: 12,
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  formCancelButton: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  formCancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
  },
  formSaveButton: {
    flex: 1,
    backgroundColor: '#8B5CF6',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  formSaveButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // New Admin Package Styles
  adminPageHeader: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 20,
  },
  adminPageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  adminPageSubtitle: {
    fontSize: 14,
    color: '#6B7280',
  },
  adminCreateButton: {
    marginHorizontal: 16,
    marginBottom: 20,
    backgroundColor: '#8B5CF6',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  adminCreateButtonIcon: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginRight: 8,
  },
  adminCreateButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  adminPackageCard: {
    marginHorizontal: 16,
    marginBottom: 20,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 24,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
    position: 'relative',
  },
  adminPopularBadge: {
    position: 'absolute',
    top: -10,
    right: 20,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
  },
  adminPopularBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  adminPackageName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 8,
  },
  adminPackageDescription: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 21,
    marginBottom: 16,
  },
  adminPackagePrice: {
    fontSize: 32,
    fontWeight: '700',
    color: '#6366F1',
    textAlign: 'center',
    marginVertical: 16,
  },
  adminPackageDetails: {
    marginTop: 20,
    marginBottom: 16,
  },
  adminDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  adminDetailLabel: {
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '500',
  },
  adminDetailValue: {
    fontSize: 14,
    color: '#1F2937',
    fontWeight: '600',
  },
  adminStatusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  adminStatusActive: {
    backgroundColor: '#D1FAE5',
  },
  adminStatusInactive: {
    backgroundColor: '#FEE2E2',
  },
  adminStatusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  adminStatusTextActive: {
    color: '#065F46',
  },
  adminStatusTextInactive: {
    color: '#991B1B',
  },
  adminPackageActions: {
    flexDirection: 'row',
    gap: 8,
  },
  adminActionButton: {
    flex: 1,
    backgroundColor: '#DBEAFE',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  adminActionButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E40AF',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
    marginHorizontal: 16,
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#D1D5DB',
  },
  emptyStateIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyStateText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
  
  // PACKAGES SCREEN STYLES
  packagesPageHeader: {
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 20,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  packagesPageTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 8,
  },
  packagesPageSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
  packagesCreditCard: {
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginBottom: 20,
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 2,
    borderColor: '#E0E7FF',
  },
  packagesCreditLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 12,
    letterSpacing: 1,
  },
  packagesCreditNumber: {
    fontSize: 48,
    fontWeight: '800',
    color: '#8B5CF6',
    marginBottom: 8,
  },
  packagesCreditSubtext: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  packagesSectionHeader: {
    marginHorizontal: 16,
    marginBottom: 16,
    alignItems: 'center',
  },
  packagesSectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 6,
  },
  packagesSectionSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
  packagesGrid: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  packageCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
    position: 'relative',
    overflow: 'hidden',
  },
  packageCardPopular: {
    borderColor: '#8B5CF6',
    borderWidth: 3,
    backgroundColor: '#FAF5FF',
  },
  popularBadge: {
    position: 'absolute',
    top: 12,
    right: -35,
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 40,
    paddingVertical: 6,
    transform: [{ rotate: '45deg' }],
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 5,
  },
  popularBadgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  packageCardHeader: {
    marginBottom: 20,
    paddingBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: '#E5E7EB',
  },
  packageName: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 10,
  },
  packageDescriptionText: {
    fontSize: 17,
    color: '#6B7280',
    lineHeight: 24,
    marginTop: 8,
  },
  packagePriceSection: {
    alignItems: 'center',
    marginBottom: 28,
    paddingVertical: 16,
  },
  packagePriceContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  packageCurrency: {
    fontSize: 26,
    fontWeight: '600',
    color: '#8B5CF6',
    marginTop: 8,
    marginRight: 6,
  },
  packagePrice: {
    fontSize: 52,
    fontWeight: '800',
    color: '#8B5CF6',
  },
  packageDetailsSection: {
    marginBottom: 28,
    backgroundColor: '#F9FAFB',
    padding: 20,
    borderRadius: 12,
  },
  packageDetailRowNew: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  packageDetailLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  packageDetailIconNew: {
    fontSize: 28,
    marginRight: 14,
  },
  packageDetailLabel: {
    fontSize: 19,
    color: '#374151',
    fontWeight: '600',
  },
  packageDetailValue: {
    fontSize: 22,
    color: '#8B5CF6',
    fontWeight: '700',
  },
  packageDetails: {
    marginBottom: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  packageDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  packageDetailIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  packageDetailText: {
    fontSize: 15,
    color: '#4B5563',
    flex: 1,
  },
  packageBuyButton: {
    backgroundColor: '#8B5CF6',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  packageBuyButtonPopular: {
    backgroundColor: '#7C3AED',
  },
  packageBuyButtonText: {
    color: 'white',
    fontSize: 17,
    fontWeight: '700',
  },
  emptyPackagesContainer: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyPackagesIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyPackagesText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  emptyPackagesSubtext: {
    fontSize: 14,
    color: '#6B7280',
  },

  // ===== LEGAL PAGES STYLES =====
  legalContentCard: {
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginBottom: 20,
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  legalUpdateText: {
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 20,
    fontStyle: 'italic',
  },
  legalSection: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1F2937',
    marginTop: 20,
    marginBottom: 12,
  },
  legalParagraph: {
    fontSize: 15,
    color: '#4B5563',
    lineHeight: 24,
    marginBottom: 12,
  },
  importantNotice: {
    backgroundColor: '#FEF3C7',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#F59E0B',
    marginBottom: 20,
  },
  importantNoticeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#92400E',
    marginBottom: 8,
  },
  importantNoticeText: {
    fontSize: 14,
    color: '#78350F',
    lineHeight: 20,
  },
  
  // Reply Date Picker Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end',
  },
  datePickerModalWrapper: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  datePickerModalWrapper2: {
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
  },
  datePickerModal: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 20,
  },
  datePickerHeader: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  datePickerHeaderLine: {
    width: 40,
    height: 4,
    backgroundColor: '#d1d5db',
    borderRadius: 2,
    marginBottom: 12,
  },
  datePickerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    letterSpacing: 0.3,
  },
  datePickerContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: '#fff',
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6b7280',
    textAlign: 'center',
  },
  modalConfirmButton: {
    flex: 1,
  },
  confirmButtonWrapper: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  modalConfirmGradient: {
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalConfirmText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  
  // Notification Modal Styles
  notificationModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  notificationModalWrapper: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -5 },
    shadowOpacity: 0.15,
    shadowRadius: 25,
    elevation: 20,
  },
  notificationModal: {
    maxHeight: '100%',
  },
  notificationHeader: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    position: 'relative',
  },
  notificationHeaderLine: {
    width: 40,
    height: 4,
    backgroundColor: '#d1d5db',
    borderRadius: 2,
    marginBottom: 12,
  },
  notificationTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
    letterSpacing: 0.3,
  },
  notificationHeaderBadge: {
    position: 'absolute',
    top: 30,
    right: 20,
    backgroundColor: '#ef4444',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  notificationHeaderBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  notificationBody: {
    maxHeight: 450,
  },
  notificationLoading: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationLoadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '500',
  },
  notificationEmpty: {
    paddingVertical: 60,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyBellContainer: {
    width: 56,
    height: 56,
    marginBottom: 16,
    alignItems: 'center',
    justifyContent: 'flex-start',
    opacity: 0.3,
  },
  emptyBellHandle: {
    width: 6,
    height: 3,
    backgroundColor: '#9ca3af',
    borderRadius: 2,
    marginBottom: 1,
  },
  emptyBellBody: {
    width: 24,
    height: 22,
    backgroundColor: '#9ca3af',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    marginBottom: 1,
  },
  emptyBellOpening: {
    width: 28,
    height: 3,
    backgroundColor: '#9ca3af',
    borderRadius: 2,
  },
  notificationEmptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  notificationEmptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  notificationItem: {
    flexDirection: 'row',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    backgroundColor: '#ffffff',
  },
  notificationItemUnread: {
    backgroundColor: '#f0f9ff',
  },
  notificationItemLast: {
    borderBottomWidth: 0,
  },
  notificationIconBox: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  notificationIconEmail: {
    backgroundColor: '#dbeafe',
  },
  notificationIconLetter: {
    backgroundColor: '#fce7f3',
  },
  notificationIconCredits: {
    backgroundColor: '#fef3c7',
  },
  notificationIconProfile: {
    backgroundColor: '#e0e7ff',
  },
  notificationItemIcon: {
    fontSize: 20,
  },
  notificationContent: {
    flex: 1,
    position: 'relative',
  },
  notificationTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  notificationItemTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    marginRight: 8,
    letterSpacing: 0.2,
  },
  notificationTime: {
    fontSize: 12,
    color: '#9ca3af',
    fontWeight: '500',
  },
  notificationMessage: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
    marginBottom: 4,
  },
  notificationUnreadDot: {
    position: 'absolute',
    top: 4,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3b82f6',
  },
  notificationFooter: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    backgroundColor: '#ffffff',
  },
  viewAllButton: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  viewAllGradient: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewAllText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  
  // Notifications Page Styles
  // ── Notifications page (redesigned to match Home / Letters design language) ──
  notifPageContainer:     { flex: 1, backgroundColor: '#E5EAF3' },
  notifScrollContent:     { paddingBottom: 20 },

  // Top bar — mirrors ReviewScreen topBar
  notifTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  notifBackPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(11,15,34,0.10)',
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  notifBackPillText:      { fontSize: 13, fontWeight: '600', color: '#0B0F22' },
  notifWordmark: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  notifWordmarkLogo:      { width: 22, height: 22 },
  notifWordmarkText:      { fontSize: 21, fontWeight: '800', color: '#0B0F22', letterSpacing: 0.5 },
  notifWordmarkBlue:      { color: '#4F8DFF' },
  notifMarkReadPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.25)',
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  notifMarkReadText:      { fontSize: 12, fontWeight: '700', color: '#4F8DFF' },

  // Hero card — mirrors ReviewScreen heroCard
  notifHeroCard: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: 'hidden',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    marginBottom: 14,
    position: 'relative',
  },
  notifMeshBlob: {
    position: 'absolute',
    borderRadius: 999,
  },
  notifHeroEyeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  notifHeroEyebrow: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.4,
  },
  notifHeroCountChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(239,68,68,0.20)',
    borderRadius: 100,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
  },
  notifHeroCountDot:      { width: 6, height: 6, borderRadius: 3, backgroundColor: '#EF4444' },
  notifHeroCountText:     { fontSize: 11, fontWeight: '700', color: '#FCA5A5' },
  notifHeroTitle:         { fontSize: 26, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.2, marginBottom: 4 },
  notifHeroSub:           { fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 18, marginBottom: 18 },

  // Stats strip inside hero
  notifStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  notifStatChip:          { flex: 1, alignItems: 'center' },
  notifStatNum:           { fontSize: 20, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.3 },
  notifStatLabel:         { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.45)', marginTop: 2, letterSpacing: 0.5 },
  notifStatDivider:       { width: 1, height: 32, backgroundColor: 'rgba(255,255,255,0.12)' },

  // Filter chips row
  notifFiltersRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 14,
  },
  notifFilterChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(11,15,34,0.08)',
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  notifFilterChipActive: {
    backgroundColor: '#0B0F22',
    borderColor: '#0B0F22',
  },
  notifFilterChipText:        { fontSize: 12, fontWeight: '700', color: '#5B6B8A' },
  notifFilterChipTextActive:  { color: '#FFFFFF' },
  notifFilterBadge: {
    backgroundColor: '#F1F4FA',
    borderRadius: 20,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifFilterBadgeActive:     { backgroundColor: 'rgba(255,255,255,0.15)' },
  notifFilterBadgeText:       { fontSize: 10, fontWeight: '800', color: '#5B6B8A' },
  notifFilterBadgeTextActive: { color: '#FFFFFF' },

  // Loading / Empty states
  notifLoadingBox: {
    paddingVertical: 80,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  notifLoadingText:       { fontSize: 14, fontWeight: '600', color: '#5B6B8A' },
  notifEmptyBox: {
    paddingVertical: 60,
    paddingHorizontal: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifEmptyIconRing: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    borderWidth: 1,
    borderColor: 'rgba(11,15,34,0.08)',
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  notifEmptyTitle:        { fontSize: 18, fontWeight: '800', color: '#0B0F22', marginBottom: 8, letterSpacing: 0.2, textAlign: 'center' },
  notifEmptySub:          { fontSize: 13, color: '#5B6B8A', textAlign: 'center', lineHeight: 19 },

  // Notification cards
  notifList: {
    paddingHorizontal: 16,
    gap: 10,
  },
  notifCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(11,15,34,0.06)',
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    overflow: 'hidden',
  },
  notifCardUnread: {
    backgroundColor: '#F5F8FF',
    borderColor: 'rgba(79,141,255,0.25)',
    borderWidth: 1.5,
  },
  notifCardAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: '#4F8DFF',
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
  },
  notifCardIconBox: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  notifCardBody:          { flex: 1 },
  notifCardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  notifCardTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
    color: '#0B0F22',
    lineHeight: 20,
    marginRight: 8,
    letterSpacing: 0.1,
  },
  notifUnreadDot:         { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4F8DFF', marginTop: 5 },
  notifCardMessage:       { fontSize: 13, color: '#5B6B8A', lineHeight: 18, marginBottom: 8 },
  notifCardFooter:        { flexDirection: 'row', alignItems: 'center', gap: 4 },
  notifCardTime:          { fontSize: 11, fontWeight: '600', color: '#8896B0', letterSpacing: 0.3 },

  // Load more
  notifLoadMoreWrapper: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  notifLoadMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.25)',
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  notifLoadMoreText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4F8DFF',
  },
  notifLoadMoreSpinner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  notifLoadMoreSpinnerText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#5B6B8A',
  },
  // Reply Details Modal Styles
  showReplyButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginTop: 8,
    alignItems: 'center',
  },
  showReplyButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  replyModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  replyDetailsModalContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    width: '100%',
    maxWidth: 600,
    maxHeight: '85%',
    flexShrink: 1,
  },
  replyDetailsModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  replyDetailsModalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1e293b',
    flex: 1,
  },
  closeModalButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeModalButtonText: {
    fontSize: 16,
    color: '#64748b',
    fontWeight: '600',
  },
  replyMetaSection: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  replyMetaFrom: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 4,
  },
  replyMetaSubject: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 6,
  },
  replyMetaCount: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  replyDetailsContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    flexGrow: 0,
  },
  replyCard: {
    backgroundColor: '#dbeafe',
    borderLeftWidth: 3,
    borderLeftColor: '#2563eb',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  replyCardDate: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '500',
    marginBottom: 8,
  },
  replyPreviewText: {
    fontSize: 13,
    color: '#1f2937',
    lineHeight: 20,
  },
  replyDetailsCloseButton: {
    backgroundColor: '#3b82f6',
    marginHorizontal: 16,
    marginVertical: 12,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  replyDetailsCloseButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
