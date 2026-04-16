import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Dimensions, StatusBar, Image, SafeAreaView, Animated, Modal, ActivityIndicator, KeyboardAvoidingView, Platform, TouchableWithoutFeedback, Keyboard, Linking, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView as SafeAreaViewContext, SafeAreaProvider } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { API_BASE } from './config';
import SplashScreen from './components/SplashScreen';
import DateTimePicker from '@react-native-community/datetimepicker';

const GOOGLE_CLIENT_ID_IOS = '151384459549-3rm4atu5eu3ekh9h4rhds6gbd9ecgeb6.apps.googleusercontent.com';
const GOOGLE_CLIENT_ID_ANDROID = '151384459549-ro8tqemri24dc3n2lh7ak5t3fjr365nl.apps.googleusercontent.com';
const GOOGLE_CLIENT_ID_WEB = '151384459549-ujnpfbck9e0q2jkmt2q4l0lv1s41lp04.apps.googleusercontent.com';

// Microsoft OAuth Client ID from Azure Portal
const MICROSOFT_CLIENT_ID = '9205782b-1a57-4c2f-bbfd-8136b5378e96';

const { width, height} = Dimensions.get('window');

WebBrowser.maybeCompleteAuthSession();

// Component to render formatted HTML cover letter with bold text
// Helper function to normalize HTML - convert <br><br> to proper paragraphs
const normalizeHTML = (html) => {
  if (!html) return '<p></p>';
  
  // Remove wrapping <p> tags if the entire content is in one <p>
  let content = html.trim();
  if (content.startsWith('<p>') && content.endsWith('</p>')) {
    content = content.slice(3, -4); // Remove opening <p> and closing </p>
  }
  
  // Split by <br><br> or <br/><br/> or <br /><br /> to create paragraphs
  const paragraphs = content.split(/<br\s*\/?>\s*<br\s*\/?>/gi);
  
  // Wrap each paragraph in <p> tags, preserving internal formatting
  const normalized = paragraphs
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => `<p>${p}</p>`)
    .join('\n');
  
  console.log('Normalized HTML (first 300 chars):', normalized.substring(0, 300));
  return normalized || '<p></p>';
};

// HTML Content Display Component
const HTMLContentViewer = ({ htmlContent, onEdit }) => {
  const webViewRef = useRef(null);

  // Debug log to see what HTML we're receiving
  console.log('HTMLContentViewer - Raw HTML Content:', htmlContent?.substring(0, 500));
  
  // Normalize the HTML to have proper paragraph structure
  const normalizedContent = normalizeHTML(htmlContent);

  const htmlTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
          line-height: 1.7;
          margin: 0;
          padding: 0px 12px 12px 12px;
          font-size: 15px;
          color: #333;
          background: white;
        }
        p {
          display: block;
          margin: 0 0 20px 0;
          padding: 0;
          line-height: 1.7;
        }
        p:last-child {
          margin-bottom: 0;
        }
        strong {
          font-weight: 700;
          color: #1e40af;
        }
        br {
          display: block;
          content: "";
        }
        /* Style consecutive br tags as paragraph breaks */
        br + br {
          display: block;
          margin-bottom: 16px;
          content: "";
        }
        ul, ol {
          margin: 12px 0;
          padding-left: 24px;
        }
        li {
          margin: 6px 0;
        }
        em, i {
          font-style: italic;
        }
        u {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      ${normalizedContent || '<p>No content available</p>'}
    </body>
    </html>
  `;

  return (
    <View style={{ flex: 1, borderRadius: 12, borderWidth: 1.5, borderColor: '#e2e8f0', overflow: 'hidden', backgroundColor: '#f8fafc' }}>
      <WebView
        ref={webViewRef}
        source={{ html: htmlTemplate }}
        scrollEnabled={true}
        bounces={false}
        style={{ flex: 1, backgroundColor: 'white' }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        contentInset={{ top: 0, left: 0, bottom: 0, right: 0 }}
      />
      {onEdit && (
        <TouchableOpacity
          onPress={onEdit}
          style={{
            padding: 12,
            backgroundColor: '#1e40af',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Text style={{ color: 'white', fontWeight: '600', fontSize: 14 }}>✏️ Edit</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

// Rich Text Editor Component using WebView + contenteditable
const RichTextEditorWebView = ({ initialHtml, onContentChange, height = 400 }) => {
  const webViewRef = useRef(null);

  // Debug log
  console.log('RichTextEditorWebView - Initial HTML:', initialHtml?.substring(0, 300));
  
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

function AppContent() {
  const [showSplash, setShowSplash] = useState(true);
  const [screen, setScreen] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);
  const userRef = useRef(null);
  const sessionRestoredRef = useRef(false);
  // Keep ref in sync so link handlers always have the latest token
  useEffect(() => { userRef.current = user; }, [user]);

  // Save user session to SecureStore whenever user changes
  useEffect(() => {
    if (user?.token && user?.id) {
      SecureStore.setItemAsync('userSession', JSON.stringify(user)).catch(err => 
        console.log('Failed to save session:', err)
      );
    }
  }, [user]);

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
          const profileData = await response.json();
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
      appStateRef.current = nextAppState;
    });
    return () => subscription?.remove();
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
    profileImage: null,
    resume: null,
    signature: null,
    createdAt: new Date(),
  });
  const [isEditingProfile, setIsEditingProfile] = useState(false);
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
  // iOS-ONLY: expo-auth-session Google hook builds the auth URL + PKCE code verifier.
  // Android does NOT use this — it uses backend-mediated OAuth flow.
  // The redirect URI is set only for iOS (reverse client ID scheme).
  const iosRedirectUri = `com.googleusercontent.apps.${GOOGLE_CLIENT_ID_IOS.split('.apps.googleusercontent.com')[0]}:/oauth2redirect/google`;
  const [googleRequest, googleResponse, googlePromptAsync] = Google.useAuthRequest({
    iosClientId: GOOGLE_CLIENT_ID_IOS,
    androidClientId: GOOGLE_CLIENT_ID_ANDROID,
    webClientId: GOOGLE_CLIENT_ID_WEB,
    redirectUri: Platform.OS === 'ios' ? iosRedirectUri : undefined,
    scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'], // gmail.readonly removed — re-enable after CASA
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
  
  // Packages screen state
  const [userPackages, setUserPackages] = useState([]);
  const [loadingUserPackages, setLoadingUserPackages] = useState(false);
  
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
      new URL(url);
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
    setRecipients([...recipients, { id: newId, email: '', website: '', position: '', error: '' }]);
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
          error = 'Invalid URL (use https://...)';
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

  const handleReview = () => {
    if (validateAllRecipients()) {
      // Don't clear existing cover letters - preserve sent/generated status
      setCurrentReviewTab(0);
      setScreen('review');
    }
  };

  // Handle Razorpay payment
  const handleBuyPackage = async (pkg) => {
    console.log('💳 Buy package clicked:', pkg);
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

      // 🔥 Use prefill data from backend (fetched from database)
      const prefillData = orderData.prefill || {};
      console.log('👤 Prefill data from backend:', prefillData);

      // Open Razorpay payment page in WebView modal with prefill data
      const url = `${API_BASE.replace('/api', '')}/payment.html?orderId=${orderData.orderId}&amount=${orderData.amount}&currency=${orderData.currency}&keyId=${orderData.keyId}&packageName=${encodeURIComponent(pkg.name)}&credits=${pkg.credits}&email=${encodeURIComponent(prefillData.email || '')}&name=${encodeURIComponent(prefillData.name || '')}&phone=${encodeURIComponent(prefillData.contact || '')}`;
      
      console.log('🌐 Opening payment URL with backend prefill data');
      console.log('🔑 Key ID:', orderData.keyId);
      console.log('📱 Current modal state before:', showPaymentModal);
      setPaymentUrl(url);
      setShowPaymentModal(true);
      console.log('✅ Payment modal state updated');
    } catch (error) {
      console.error('❌ Payment error:', error);
      Alert.alert(
        'Payment Error',
        error.message || 'Failed to initiate payment. Please try again.',
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

  // Fetch profile when screen changes to profile
  useEffect(() => {
    if (screen === 'profile') {
      fetchProfileData();
    }
  }, [screen]);

  // Handle password change
  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
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
          currentPassword,
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
    const companyName = companyUrl ? companyUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].split('.')[0] : 'the company';
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
    if (!profileData?.profileImage) missing.push('Photo');
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
          websiteUrl: recipient.website,
          position: recipient.position
        })
      });

      console.log(`⏳ [${requestId}] Waiting for response (may take 30-90 seconds)...`);
      const startTime = Date.now();
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      const elapsedTime = Date.now() - startTime;
      
      console.log(`✅ [${requestId}] Response received in ${elapsedTime}ms`);
      console.log(`   Status: ${response.status}, Ok: ${response.ok}`);
      
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
      let data;
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
      let updatedCoverLetters = {};
      setReviewCoverLetters(prev => {
        updatedCoverLetters = {
          ...prev,
          [recipientIndex]: {
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
      
      // Generate all cover letters simultaneously
      const promises = recipients
        .map((recipient, index) => {
          if (recipient.email && recipient.website) {
            return generateCoverLetterForReview(index);
          }
          return Promise.resolve();
        });
      
      await Promise.all(promises);
      
      // Only show alert if not cancelled
      if (!isCancelledRef.current) {
        Alert.alert('Success', 'All cover letters generated');
      }
    } catch (error) {
      if (!isCancelledRef.current) {
        Alert.alert('Error', error.message);
      }
    } finally {
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
        const coverLetter = reviewCoverLetters[index];
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
      
      // Send all applications simultaneously (silent mode to avoid multiple alerts)
      const promises = recipients
        .map((recipient, index) => {
          const coverLetter = reviewCoverLetters[index];
          if (recipient.email && recipient.website && coverLetter) {
            return sendApplicationFromReview(index, true);
          }
          return Promise.resolve();
        });
      
      await Promise.all(promises);
      
      // Only show alert if not cancelled
      if (!isCancelledRef.current) {
        Alert.alert('Success', 'All applications sent');
      }
    } catch (error) {
      if (!isCancelledRef.current) {
        Alert.alert('Error', error.message);
      }
    } finally {
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
      
      // First, generate all cover letters sequentially to ensure state updates
      console.log('🚀 Starting Generate and Send All...');
      console.log('Total recipients:', recipients.length);
      
      for (let index = 0; index < recipients.length; index++) {
        // Check if cancelled
        if (isCancelledRef.current) {
          console.log('🛑 Operation cancelled during generation phase');
          return;
        }
        
        const recipient = recipients[index];
        if (recipient.email && recipient.website) {
          console.log(`Generating cover letter for recipient ${index}...`);
          await generateCoverLetterForReview(index);
          // Wait for state to update
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      console.log('✅ All cover letters generated');
      
      // Wait for final state updates to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Now send all applications - use a callback to get the latest state
      console.log('📧 Starting to send all applications...');
      
      // Get the current state snapshot
      let coverLettersSnapshot = {};
      setReviewCoverLetters(current => {
        coverLettersSnapshot = { ...current };
        console.log('📦 Current cover letters in state:', Object.keys(current).length);
        return current;
      });
      
      // Wait for state callback to execute
      await new Promise(resolve => setTimeout(resolve, 100));
      
      let sentCount = 0;
      let failedCount = 0;
      
      for (let index = 0; index < recipients.length; index++) {
        // Check if cancelled
        if (isCancelledRef.current) {
          console.log('🛑 Operation cancelled during send phase');
          return;
        }
        
        const recipient = recipients[index];
        const coverLetter = coverLettersSnapshot[index];
        
        if (recipient.email && recipient.website && coverLetter) {
          console.log(`\n📤 Attempting to send application for recipient ${index}...`);
          // Pass the cover letter directly to avoid state access issues
          const success = await sendApplicationFromReview(index, true, coverLetter);
          if (success) {
            sentCount++;
            console.log(`✅ Sent ${sentCount}/${recipients.length}`);
            // Wait a bit between sends to avoid overwhelming the backend
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            failedCount++;
            console.log(`❌ Failed to send to recipient ${index}`);
          }
        } else {
          console.log(`⚠️ Skipping recipient ${index}: hasEmail=${!!recipient.email}, hasWebsite=${!!recipient.website}, hasCoverLetter=${!!coverLetter}`);
          failedCount++;
        }
      }
      
      console.log(`\n✅ Completed: Sent ${sentCount} applications, Failed: ${failedCount}`);
      
      // Only show alerts if not cancelled
      if (!isCancelledRef.current) {
        if (sentCount > 0) {
          Alert.alert('Success', `Generated and sent ${sentCount} application${sentCount > 1 ? 's' : ''}${failedCount > 0 ? `. ${failedCount} failed.` : ''}`);
        } else {
          Alert.alert('Error', 'Failed to send any applications. Check console logs.');
        }
      }
    } catch (error) {
      console.error('❌ Generate and Send All error:', error);
      if (!isCancelledRef.current) {
        Alert.alert('Error', error.message);
      }
    } finally {
      setReviewGeneratingAndSendingAll(false);
    }
  };

  const sendApplicationFromReview = async (recipientIndex, silent = false, coverLetterOverride = null) => {
    const recipient = recipients[recipientIndex];
    const coverLetter = coverLetterOverride || reviewCoverLetters[recipientIndex];
    
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
      
      const requestBody = {
        recipientEmail: recipient.email,
        websiteUrl: recipient.website,
        position: recipient.position,
        coverLetterText: coverLetter.coverLetterHtml,
        companyName: coverLetter.companyName,
        companyAddress: coverLetter.address || ''
      };
      console.log('Request body companyAddress:', requestBody.companyAddress);
      console.log('Request body:', JSON.stringify(requestBody, null, 2));
      
      console.log(`⏱️  [SEND ${recipientIndex}] Starting fetch request...`);
      
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout after 60 seconds')), 60000)
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

      console.log(`✅ [SEND ${recipientIndex}] Updating state to mark as sent`);
      setReviewCoverLetters(prev => ({
        ...prev,
        [recipientIndex]: {
          ...prev[recipientIndex],
          sent: true,
          sentDate: new Date().toISOString()
        }
      }));
      
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

      if (!silent) Alert.alert('Error', error.message || 'Failed to send application');
      return false;
    } finally {
      requestInProgressRef.current = false;
      deactivateKeepAwake();
      setReviewLoading(false);
    }
  };

  const downloadCoverLetterPDFFromReview = async (recipientIndex) => {
    const coverLetter = reviewCoverLetters[recipientIndex];
    
    if (!coverLetter) {
      Alert.alert('Error', 'Generate cover letter first');
      return;
    }

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
          companyAddress: coverLetter.address || ''
        })
      });

      if (!response.ok) throw new Error('Failed to generate PDF');
      
      // Check if operation was cancelled
      if (isCancelledRef.current) {
        console.log('🛑 Download cancelled - aborting');
        return;
      }
      
      // Get the response JSON with download URL
      const data = await response.json();
      
      if (!data.downloadUrl) {
        throw new Error('No download URL received');
      }
      
      // Save to file system using FileSystem.downloadAsync
      const fileName = data.fileName || `${coverLetter.companyName.replace(/[^a-z0-9]/gi, '_')}_CoverLetter.pdf`;
      const fileUri = FileSystem.documentDirectory + fileName;
      
      const downloadResult = await FileSystem.downloadAsync(
        `${API_BASE}${data.downloadUrl}`,
        fileUri,
        {
          headers: {
            'Authorization': `Bearer ${user.token}`
          }
        }
      );
      
      // Share the file
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri);
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
      console.log('💡 Using local state to preserve recent mark-as-read updates');
      return;
    }
    
    console.log('📥 Loading ALL notifications... Force:', force, 'Time since last update:', timeSinceLastUpdate);
    setLoadingNotifications(true);
    try {
      const response = await fetch(`${API_BASE}/notifications`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        console.log('✅ All notifications loaded:', data.notifications?.length || 0, 'unread:', data.unreadCount);
        if (data.success) {
          setNotifications(data.notifications || []);
          setUnreadCount(data.unreadCount || 0);
        }
      } else {
        console.log('❌ Failed to load all notifications:', response.status);
      }
    } catch (err) {
      console.log('Error loading all notifications:', err.message);
    } finally {
      setLoadingNotifications(false);
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
        // Also save to AsyncStorage for offline access
        await AsyncStorage.setItem(`reviewCoverLetters_${user.email}`, JSON.stringify(dataToSave));
      } else {
        console.error('❌ Failed to save cover letters to backend:', response.status);
      }
    } catch (error) {
      console.error('Failed to save review cover letters to backend:', error);
    }
  };

  const loadReviewCoverLettersFromStorage = async () => {
    try {
      if (!user?.email) {
        console.log('⚠️ Cannot load review cover letters - no user email');
        return;
      }
      
      // Try to load from backend API first (sync with web)
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
            setReviewCoverLetters(data.reviewCoverLetters);
            console.log('📖 Review cover letters loaded from backend database:', Object.keys(data.reviewCoverLetters).length, 'items');
            
            // Cache in AsyncStorage for offline access
            await AsyncStorage.setItem(`reviewCoverLetters_${user.email}`, JSON.stringify(data.reviewCoverLetters));
            return;
          }
        } else {
          console.log('⚠️ Backend returned error for cover letters, trying AsyncStorage fallback');
        }
      } catch (apiError) {
        console.log('⚠️ Backend API error, trying AsyncStorage fallback:', apiError.message);
      }
      
      // Fallback to AsyncStorage if backend is unavailable
      const stored = await AsyncStorage.getItem(`reviewCoverLetters_${user.email}`);
      console.log('🔍 Attempting to load review cover letters from AsyncStorage for:', user.email);
      
      if (stored) {
        const parsed = JSON.parse(stored);
        setReviewCoverLetters(parsed);
        console.log('📖 Review cover letters loaded from AsyncStorage (offline):', Object.keys(parsed).length, 'items');
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
      if (user.provider === 'microsoft') {
        console.log('🔄 Microsoft OAuth user detected - starting auto-check for replies...');
        // Initial check after 10 seconds
        setTimeout(() => autoCheckForReplies(false), 10000);
      }
    }
  }, [user?.token, user?.email]);

  // Periodic reply checking (every 10 minutes) for OAuth users
  useEffect(() => {
    let replyCheckInterval = null;
    
    if (user?.token && (user.provider === 'microsoft')) { // Gmail auto-check disabled until CASA
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

  // Load usage data when screen changes to 'usage'
  useEffect(() => {
    if (screen === 'usage' && user?.token) {
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
      console.log('🔔 Navigated to notifications screen - checking if fetch needed...');
      // Don't force fetch - let the smart fetching mechanism decide based on timestamp
      // This prevents overwriting recently marked-as-read notifications
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
      
      // Check if any recipient data has changed compared to saved cover letters
      let needsRegeneration = false;
      
      recipients.forEach((recipient, index) => {
        const savedCoverLetter = reviewCoverLetters[index];
        
        // Only check if we have stored recipient data to compare against
        if (savedCoverLetter && savedCoverLetter.storedRecipientEmail && savedCoverLetter.storedRecipientWebsite) {
          const emailChanged = savedCoverLetter.storedRecipientEmail !== recipient.email;
          const websiteChanged = savedCoverLetter.storedRecipientWebsite !== recipient.website;
          
          if (emailChanged || websiteChanged) {
            console.log(`🔄 Recipient ${index} data changed - needs regeneration`);
            console.log(`  Old: ${savedCoverLetter.storedRecipientEmail} / ${savedCoverLetter.storedRecipientWebsite}`);
            console.log(`  New: ${recipient.email} / ${recipient.website}`);
            needsRegeneration = true;
          }
        }
      });
      
      if (needsRegeneration) {
        console.log('🔄 Recipient data changed - auto-regenerating all cover letters...');
        Alert.alert(
          'Recipient Data Changed',
          'Recipient information has been updated. Cover letters will be regenerated automatically.',
          [
            {
              text: 'OK',
              onPress: () => generateAllCoverLettersForReview()
            }
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
    if (user.provider === 'google') {
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
        await AsyncStorage.removeItem(`reviewCoverLetters_${user.email}`);
        await AsyncStorage.removeItem(`recipients_${user.email}`);
        console.log('🗑️ Cleared user cache on logout');
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

  const handleGoogleAuthResponse = async (code, codeVerifier, redirectUri) => {
    setLoading(true);
    setError('');
    try {
      console.log('Google Auth Response - Code length:', code?.length || 0);
      console.log('Google Auth Response - Verifier length:', codeVerifier?.length || 0);
      console.log('Google Auth Response - Redirect URI:', redirectUri);
      console.log('API Base:', API_BASE);
      
      // Send authorization code and PKCE verifier to backend for token exchange
      const response = await fetch(`${API_BASE}/auth/google`, {
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
      const data = await response.json();
      console.log('Backend Response Data:', data);

      if (!response.ok) {
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
      Alert.alert('Error', err.message || 'Google login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMicrosoftAuthResponse = async (accessToken) => {
    setLoading(true);
    setError('');
    try {
      console.log('Microsoft Auth Response - Token length:', accessToken?.length || 0);
      console.log('API Base:', API_BASE);
      
      // Send access token to backend
      const response = await fetch(`${API_BASE}/auth/microsoft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken })
      });

      console.log('Backend Response Status:', response.status);
      const data = await response.json();
      console.log('Backend Response Data:', data);

      if (!response.ok) {
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
  // ANDROID Google OAuth — Backend-mediated flow
  // Uses WebBrowser.openAuthSessionAsync (Chrome Custom Tab, stays in-app)
  // Backend handles Google OAuth and redirects back via deep link
  // ==========================================
  const handleGoogleLoginAndroid = async () => {
    // Derive backend URL from API_BASE so it always uses the correct IP
    const baseUrl = API_BASE.replace('/api', '');
    const mobileAuthUrl = `${baseUrl}/auth/google/mobile`;
    // Return URL must match the deep link the backend redirects to after OAuth
    const devIp = API_BASE.match(/\/\/([^:]+):/)?.[1] || '192.168.1.10';
    const returnUrl = __DEV__
      ? `exp://${devIp}:8081`
      : 'cvapplyr://oauth-success';
    console.log('Android: Opening Google OAuth via backend Custom Tab...');
    console.log('Android: Auth URL:', mobileAuthUrl);
    console.log('Android: Return URL:', returnUrl);
    try {
      const result = await WebBrowser.openAuthSessionAsync(mobileAuthUrl, returnUrl);
      console.log('Android: Auth result type:', result.type);
      if (result.type === 'success' && result.url) {
        console.log('Android: Success URL received, parsing...');
        try {
          const urlObj = new URL(result.url);
          const token = urlObj.searchParams.get('token');
          const userStr = urlObj.searchParams.get('user');
          if (token && userStr) {
            const userData = JSON.parse(decodeURIComponent(userStr));
            console.log('✅ Android Google auth complete:', userData.email);
            setUser({ ...userData, token });
            setScreen('dashboard');
            Alert.alert('Success', `Welcome ${userData.fullName}!`);
          } else {
            Alert.alert('OAuth Error', 'Missing token or user data in response');
          }
        } catch (parseErr) {
          console.error('Android OAuth parse error:', parseErr);
          Alert.alert('OAuth Error', 'Failed to parse auth response');
        }
      } else if (result.type === 'cancel' || result.type === 'dismiss') {
        console.log('Android: Google login cancelled/dismissed');
      } else {
        console.log('Android: Unexpected result type:', result.type);
      }
    } catch (err) {
      console.error('Android Google login error:', err);
      Alert.alert('Error', 'Google login failed: ' + err.message);
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
          const data = await response.json();
          setLoading(false);
          if (response.ok) {
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
      const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
        `client_id=${MICROSOFT_CLIENT_ID}` +
        `&response_type=token` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent('user.read Mail.Read Mail.Send offline_access')}` +
        `&response_mode=fragment`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);

      if (result.type === 'success') {
        const url = result.url;
        const accessTokenMatch = url.match(/access_token=([^&]+)/);

        if (accessTokenMatch && accessTokenMatch[1]) {
          const accessToken = accessTokenMatch[1];
          setLoading(true);
          const response = await fetch(`${API_BASE}/auth/link-microsoft`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${userRef.current?.token}`,
            },
            body: JSON.stringify({ accessToken }),
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
          Alert.alert('Error', 'No access token received from Microsoft');
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

      const data = await response.json();
      console.log('Apple backend response status:', response.status);
      console.log('Apple backend response:', JSON.stringify(data));

      if (!response.ok) {
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
      // Microsoft OAuth URL for mobile
      const redirectUri = `msauth://com.cvapplyr.app/callback`;
      const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
        `client_id=${MICROSOFT_CLIENT_ID}` +
        `&response_type=token` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent('user.read Mail.Read Mail.Send offline_access')}` +
        `&response_mode=fragment`;
      
      console.log('Opening Microsoft auth URL...');
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
      
      console.log('Microsoft auth result:', result);
      
      if (result.type === 'success') {
        // Extract access token from URL fragment
        const url = result.url;
        const accessTokenMatch = url.match(/access_token=([^&]+)/);
        
        if (accessTokenMatch && accessTokenMatch[1]) {
          const accessToken = accessTokenMatch[1];
          console.log('Microsoft access token received');
          await handleMicrosoftAuthResponse(accessToken);
        } else {
          throw new Error('No access token received from Microsoft');
        }
      } else if (result.type === 'cancel') {
        setError('Microsoft login cancelled');
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
        <View style={styles.loginContainer}>
          <StatusBar barStyle={showSplash ? 'dark-content' : 'light-content'} backgroundColor="transparent" translucent={true} />
          <LinearGradient
            colors={['#1a1a2e', '#16213e', '#0f3460']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.loginGradientBg}
          >
            <SafeAreaViewContext style={{ flex: 1 }} edges={['top', 'bottom']}>
              <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={{ flex: 1 }}
              >
                <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                  <View style={styles.loginInnerContainer}>
                {/* Logo Section */}
                <View style={styles.loginLogoSection}>
                  <Image 
                    source={require('./assets/images/logo_hd_no_background_white_small.png')} 
                    style={styles.loginLogoImage}
                    resizeMode="contain"
                  />
                  <Text style={styles.loginTagline}>Turn applications into opportunities</Text>
                </View>

                {/* Welcome Text */}
                <View style={styles.loginWelcomeSection}>
                  <Text style={styles.loginCardTitle}>Welcome back</Text>
                  <Text style={styles.loginCardSubtitle}>Sign in to your account</Text>
                </View>

                {/* Error Message */}
                {error ? (
                  <View style={styles.loginErrorContainer}>
                    <Text style={styles.loginErrorText}>{error}</Text>
                  </View>
                ) : null}

                {/* Form Section */}
                <View style={styles.loginFormSection}>
                  {/* Email Input */}
                  <View style={styles.loginInputGroup}>
                    <Text style={styles.loginInputLabel}>Email</Text>
                    <TextInput
                      style={styles.loginInput}
                      placeholder="you@example.com"
                      value={email}
                      onChangeText={setEmail}
                      editable={!loading}
                      keyboardType="email-address"
                      placeholderTextColor="rgba(255, 255, 255, 0.3)"
                      autoCapitalize="none"
                    />
                  </View>

                  {/* Password Input */}
                  <View style={styles.loginInputGroup}>
                    <Text style={styles.loginInputLabel}>Password</Text>
                    <TextInput
                      style={styles.loginInput}
                      placeholder="Enter your password"
                      value={password}
                      onChangeText={setPassword}
                      editable={!loading}
                      secureTextEntry
                      placeholderTextColor="rgba(255, 255, 255, 0.3)"
                      autoCapitalize="none"
                    />
                  </View>

                  {/* Sign In Button */}
                  <TouchableOpacity
                    style={[styles.loginSignInButton, loading && styles.loginButtonDisabled]}
                    onPress={handleLogin}
                    disabled={loading}
                    activeOpacity={0.85}
                  >
                    <LinearGradient
                      colors={loading ? ['#64748b', '#475569'] : ['#e94560', '#c81d4e']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.loginSignInGradient}
                    >
                      <Text style={styles.loginSignInText}>
                        {loading ? 'Signing in...' : 'Sign In'}
                      </Text>
                    </LinearGradient>
                  </TouchableOpacity>
                </View>

                {/* Divider */}
                <View style={styles.loginDividerContainer}>
                  <View style={styles.loginDividerLine} />
                  <Text style={styles.loginDividerText}>or continue with</Text>
                  <View style={styles.loginDividerLine} />
                </View>

                {/* Social buttons — horizontal row */}
                <View style={styles.loginSocialButtonsContainer}>
                  <TouchableOpacity
                    style={[styles.loginSocialButton, loading && styles.loginSocialButtonDisabled]}
                    onPress={handleGoogleLogin}
                    disabled={loading}
                    activeOpacity={0.7}
                  >
                    <Image 
                      source={require('./assets/images/google.png')} 
                      style={styles.loginSocialIcon}
                      resizeMode="contain"
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.loginSocialButton, loading && styles.loginSocialButtonDisabled]}
                    onPress={() => handleMicrosoftLogin()}
                    disabled={loading}
                    activeOpacity={0.7}
                  >
                    <Image 
                      source={require('./assets/images/microsoft.png')} 
                      style={styles.loginSocialIcon}
                      resizeMode="contain"
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.loginSocialButton, styles.loginAppleButton, loading && styles.loginSocialButtonDisabled]}
                    onPress={handleAppleLogin}
                    disabled={loading}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="logo-apple" size={26} color="#ffffff" />
                  </TouchableOpacity>
                </View>

                {/* Register Link */}
                <View style={styles.loginFooter}>
                  <Text style={styles.loginFooterText}>Don't have an account? </Text>
                  <TouchableOpacity onPress={() => { setScreen('register'); setError(''); }}>
                    <Text style={styles.loginFooterLink}>Sign up</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
          </SafeAreaViewContext>
        </LinearGradient>
        {splashOverlay}
      </View>
    );
  }

  // REGISTER SCREEN
  if (screen === 'register') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#059669" translucent={false} />
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header with gradient effect */}
          <View style={[styles.gradientHeader, { backgroundColor: '#059669' }]}>
            <View style={styles.logoContainer}>
              <Image 
                source={require('./assets/images/logo_hd_no_background_white_small.png')} 
                style={{ width: 200, height: 60 }}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.headerSubtitle}>Join the community</Text>
          </View>

          {/* Main Content Card */}
          <View style={styles.mainCard}>
            <Text style={styles.cardTitle}>Create Account</Text>
            <Text style={styles.cardSubtitle}>Get started in seconds</Text>

            {error ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorIcon}>⚠️</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Full Name Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Full Name</Text>
              <View style={styles.inputWrapper}>
                <Text style={styles.inputIcon}>👤</Text>
                <TextInput
                  style={styles.input}
                  placeholder="John Doe"
                  value={fullName}
                  onChangeText={setFullName}
                  editable={!loading}
                  placeholderTextColor="#a0aec0"
                />
              </View>
            </View>

            {/* Email Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Email Address</Text>
              <View style={styles.inputWrapper}>
                <Text style={styles.inputIcon}>📧</Text>
                <TextInput
                  style={styles.input}
                  placeholder="you@example.com"
                  value={email}
                  onChangeText={setEmail}
                  editable={!loading}
                  keyboardType="email-address"
                  placeholderTextColor="#a0aec0"
                />
              </View>
            </View>

            {/* Password Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Password</Text>
              <View style={styles.inputWrapper}>
                <Text style={styles.inputIcon}>🔐</Text>
                <TextInput
                  style={styles.input}
                  placeholder="••••••••"
                  value={password}
                  onChangeText={setPassword}
                  editable={!loading}
                  secureTextEntry
                  placeholderTextColor="#a0aec0"
                />
              </View>
            </View>

            {/* Register Button */}
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: '#059669' }, loading && styles.buttonDisabled]}
              onPress={handleRegister}
              disabled={loading}
            >
              <Text style={styles.primaryButtonText}>
                {loading ? '⏳ Creating account...' : '→ Create Account'}
              </Text>
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.dividerContainer}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or continue with</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Google Sign Up Button */}
            <TouchableOpacity
              style={styles.googleButton}
              onPress={handleGoogleLogin}
              disabled={loading}
            >
              <Text style={styles.googleButtonIcon}>🔐</Text>
              <Text style={styles.googleButtonText}>Sign up with Google</Text>
            </TouchableOpacity>

            {/* Login Link */}
            <View style={styles.footerText}>
              <Text style={styles.footerLabel}>Already have an account? </Text>
              <TouchableOpacity onPress={() => { setScreen('login'); setError(''); }}>
                <Text style={styles.footerLink}>Sign In</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>

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
      <SafeAreaViewContext style={styles.modernContainer}>
        {renderCompleteProfileModal()}
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" translucent={false} />
        
        <ScrollView 
          contentContainerStyle={styles.scrollContent} 
          showsVerticalScrollIndicator={false}
          onScroll={resetAllFlips}
          scrollEventThrottle={16}
        >
          {/* Modern Header Card */}
          <TouchableWithoutFeedback onPress={resetAllFlips}>
            <View>
              <LinearGradient
                colors={['#667eea', '#764ba2']}
                style={styles.modernHeaderCard}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
            <View style={styles.headerTop}>
              <View style={styles.headerLeft}>
                <Image 
                  source={require('./assets/images/logo_hd_no_background_white_small.png')} 
                  style={{ width: 140, height: 40 }}
                  resizeMode="contain"
                />
              </View>
              <View style={styles.headerRightActions}>
                <TouchableOpacity 
                  style={styles.notificationButton}
                  onPress={async () => {
                    setShowNotifications(!showNotifications);
                    if (!showNotifications) {
                      await loadNotifications();
                    }
                  }}
                >
                  <View style={styles.notificationIconWrapper}>
                    <View style={styles.bellIconContainer}>
                      <View style={styles.bellHandle} />
                      <View style={styles.bellBody} />
                      <View style={styles.bellOpening} />
                    </View>
                    {unreadCount > 0 && (
                      <View style={styles.notificationBadge}>
                        <Text style={styles.notificationBadgeText}>
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.modernMenuButton}
                  onPress={() => setShowSettings(!showSettings)}
                >
                  <Text style={styles.modernMenuIcon}>☰</Text>
                </TouchableOpacity>
              </View>
            </View>
            
            <View style={styles.headerGreeting}>
              <Text style={styles.modernGreeting}>Welcome back,</Text>
              <Text style={styles.modernUserName}>{user?.fullName || user?.name || 'User'}</Text>
            </View>

            {/* Credits Display */}
            <TouchableOpacity 
              style={styles.headerCreditsBadge}
              onPress={() => setScreen('usage')}
              activeOpacity={0.8}
            >
              <View style={styles.creditsIconBox}>
                <Text style={styles.creditsIcon}>◆</Text>
              </View>
              <View style={styles.creditsInfo}>
                <Text style={styles.creditsLabel}>Available Credits</Text>
                <Text style={styles.creditsValue}>{creditBalance}</Text>
              </View>
              <Text style={styles.creditsArrow}>→</Text>
            </TouchableOpacity>
          </LinearGradient>
            </View>
          </TouchableWithoutFeedback>

          {/* Side Menu Modal - slides in from right */}
          <Modal
            visible={showSettings}
            transparent={true}
            animationType="none"
            onRequestClose={() => setShowSettings(false)}
          >
            <View style={styles.modalMenuContainer}>
              {/* Backdrop */}
              <TouchableOpacity 
                style={styles.modalMenuBackdrop}
                activeOpacity={1}
                onPress={() => setShowSettings(false)}
              />
              
              {/* Menu Content - Animated from right */}
              <Animated.View style={[
                styles.modalMenuContent,
                {
                  transform: [{ translateX: slideAnim }]
                }
              ]}>
                <View style={styles.sideMenuContent}>
                  {/* Close button */}
                  <TouchableOpacity 
                    style={styles.closeMenuButton}
                    onPress={() => {
                      console.log('Close button pressed');
                      setShowSettings(false);
                    }}
                  >
                    <Text style={styles.closeMenuIcon}>✕</Text>
                  </TouchableOpacity>

                  {/* Menu Items */}
                  <View style={styles.sideMenuItems}>
                    <TouchableOpacity 
                      style={styles.sideMenuItem} 
                      onPress={() => {
                        setShowSettings(false);
                        setScreen('profile');
                      }}
                    >
                      <View style={styles.sideMenuItemIconBox}>
                        <Text style={styles.sideMenuItemIconText}>⚙</Text>
                      </View>
                      <View style={styles.sideMenuItemContent}>
                        <Text style={styles.sideMenuItemTitle}>Account Settings</Text>
                        <Text style={styles.sideMenuItemDesc}>View your profile</Text>
                      </View>
                    </TouchableOpacity>

                    {isAdmin && (
                      <TouchableOpacity 
                        style={styles.sideMenuItem} 
                        onPress={() => {
                          setShowSettings(false);
                          setScreen('admin');
                        }}
                      >
                        <View style={styles.sideMenuItemIconBox}>
                          <Text style={styles.sideMenuItemIconText}>★</Text>
                        </View>
                        <View style={styles.sideMenuItemContent}>
                          <Text style={styles.sideMenuItemTitle}>Admin Panel</Text>
                          <Text style={styles.sideMenuItemDesc}>Manage credit packages</Text>
                        </View>
                      </TouchableOpacity>
                    )}

                    <View style={styles.sideMenuDivider} />

                    <TouchableOpacity 
                      style={styles.sideMenuItem} 
                      onPress={() => {
                        setShowSettings(false);
                        setScreen('terms');
                      }}
                    >
                      <View style={styles.sideMenuItemIconBox}>
                        <Text style={styles.sideMenuItemIconText}>§</Text>
                      </View>
                      <View style={styles.sideMenuItemContent}>
                        <Text style={styles.sideMenuItemTitle}>Terms & Conditions</Text>
                        <Text style={styles.sideMenuItemDesc}>View terms of service</Text>
                      </View>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={styles.sideMenuItem} 
                      onPress={() => {
                        setShowSettings(false);
                        setScreen('privacy');
                      }}
                    >
                      <View style={styles.sideMenuItemIconBox}>
                        <Text style={styles.sideMenuItemIconText}>◈</Text>
                      </View>
                      <View style={styles.sideMenuItemContent}>
                        <Text style={styles.sideMenuItemTitle}>Privacy Policy</Text>
                        <Text style={styles.sideMenuItemDesc}>How we protect your data</Text>
                      </View>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={styles.sideMenuItem} 
                      onPress={() => {
                        setShowSettings(false);
                        setScreen('refund');
                      }}
                    >
                      <View style={styles.sideMenuItemIconBox}>
                        <Text style={styles.sideMenuItemIconText}>$</Text>
                      </View>
                      <View style={styles.sideMenuItemContent}>
                        <Text style={styles.sideMenuItemTitle}>Refund Policy</Text>
                        <Text style={styles.sideMenuItemDesc}>Credit refund information</Text>
                      </View>
                    </TouchableOpacity>

                    <View style={styles.sideMenuDivider} />

                    <TouchableOpacity 
                      style={styles.sideMenuItem}
                      onPress={() => {
                        setShowSettings(false);
                        handleLogout();
                      }}
                    >
                      <View style={styles.sideMenuItemIconBox}>
                        <Text style={styles.sideMenuItemIconText}>→</Text>
                      </View>
                      <View style={styles.sideMenuItemContent}>
                        <Text style={styles.sideMenuItemTitle}>Sign Out</Text>
                        <Text style={styles.sideMenuItemDesc}>Logout from your account</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </View>
              </Animated.View>
            </View>
          </Modal>

          {/* Stats Grid */}
          <View style={styles.statsGridContainer}>
            <View style={styles.statsRow}>
              {/* Applications Sent Tile */}
              <TouchableOpacity 
                style={styles.statTileWrapper}
                activeOpacity={0.9}
                onPress={() => handleTileFlip(flipAnimSent)}
              >
                <View style={{ position: 'relative' }}>
                  {/* Front side */}
                  <Animated.View style={[
                    styles.statTile,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimSent.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['0deg', '180deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileTop}>
                      <View style={styles.statIconBox}>
                        <Text style={styles.statIconText}>↑</Text>
                      </View>
                      <Text style={styles.statValue}>{totalSent}</Text>
                    </View>
                    <Text style={styles.statLabel}>Applications Sent</Text>
                  </Animated.View>
                  
                  {/* Back side */}
                  <Animated.View style={[
                    styles.statTile,
                    styles.statTileBackContainer,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimSent.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['180deg', '360deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileBack}>
                      <Text style={styles.statBackTitle}>Last Application</Text>
                      {applicationHistory.length > 0 && applicationHistory[0] ? (
                        <>
                          <Text style={styles.statBackDate}>
                            {new Date(applicationHistory[0].sentDate).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric'
                            })}
                          </Text>
                          <Text style={styles.statBackCompany} numberOfLines={2}>
                            {applicationHistory[0].companyName}
                          </Text>
                        </>
                      ) : (
                        <Text style={styles.statBackEmpty}>No applications yet</Text>
                      )}
                    </View>
                  </Animated.View>
                </View>
              </TouchableOpacity>

              {/* Letters Generated Tile */}
              <TouchableOpacity 
                style={styles.statTileWrapper}
                activeOpacity={0.9}
                onPress={() => handleTileFlip(flipAnimGenerated)}
              >
                <View style={{ position: 'relative' }}>
                  {/* Front side */}
                  <Animated.View style={[
                    styles.statTile,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimGenerated.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['0deg', '180deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileTop}>
                      <View style={styles.statIconBox}>
                        <Text style={styles.statIconText}>✎</Text>
                      </View>
                      <Text style={styles.statValue}>{totalGenerated}</Text>
                    </View>
                    <Text style={styles.statLabel}>Letters Generated</Text>
                  </Animated.View>
                  
                  {/* Back side */}
                  <Animated.View style={[
                    styles.statTile,
                    styles.statTileBackContainer,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimGenerated.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['180deg', '360deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileBack}>
                      <Text style={styles.statBackTitle}>Total Letters</Text>
                      <Text style={styles.statBackValue}>{totalGenerated}</Text>
                      <Text style={styles.statBackLabel}>
                        {totalGenerated <= totalSent ? 'All letters sent' : `${totalGenerated - totalSent} pending`}
                      </Text>
                    </View>
                  </Animated.View>
                </View>
              </TouchableOpacity>
            </View>

            <View style={[styles.statsRow, { marginTop: -26 }]}>
              {/* Pending Response Tile */}
              <TouchableOpacity 
                style={styles.statTileWrapper}
                activeOpacity={0.9}
                onPress={() => handleTileFlip(flipAnimPending)}
              >
                <View style={{ position: 'relative' }}>
                  {/* Front side */}
                  <Animated.View style={[
                    styles.statTile,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimPending.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['0deg', '180deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileTop}>
                      <View style={styles.statIconBox}>
                        <Text style={styles.statIconText}>○</Text>
                      </View>
                      <Text style={styles.statValue}>
                        {Math.max(0, totalSent - totalReplied)}
                      </Text>
                    </View>
                    <Text style={styles.statLabel}>Pending Response</Text>
                  </Animated.View>
                  
                  {/* Back side */}
                  <Animated.View style={[
                    styles.statTile,
                    styles.statTileBackContainer,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimPending.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['180deg', '360deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileBack}>
                      <Text style={styles.statBackTitle}>Awaiting Reply</Text>
                      <Text style={styles.statBackValue}>
                        {Math.max(0, totalSent - totalReplied)}
                      </Text>
                      <Text style={styles.statBackLabel}>
                        applications pending
                      </Text>
                    </View>
                  </Animated.View>
                </View>
              </TouchableOpacity>

              {/* Reply Rate Tile */}
              <TouchableOpacity 
                style={styles.statTileWrapper}
                activeOpacity={0.9}
                onPress={() => handleTileFlip(flipAnimReply)}
              >
                <View style={{ position: 'relative' }}>
                  {/* Front side */}
                  <Animated.View style={[
                    styles.statTile,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimReply.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['0deg', '180deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileTop}>
                      <View style={styles.statIconBox}>
                        <Text style={styles.statIconText}>✓</Text>
                      </View>
                      <Text style={styles.statValue}>
                        {totalSent > 0 
                          ? Math.round((totalReplied / totalSent) * 100)
                          : 0}%
                      </Text>
                    </View>
                    <Text style={styles.statLabel}>Reply Rate</Text>
                  </Animated.View>
                  
                  {/* Back side */}
                  <Animated.View style={[
                    styles.statTile,
                    styles.statTileBackContainer,
                    {
                      backfaceVisibility: 'hidden',
                      transform: [{
                        rotateY: flipAnimReply.interpolate({
                          inputRange: [0, 180],
                          outputRange: ['180deg', '360deg']
                        })
                      }]
                    }
                  ]}>
                    <View style={styles.statTileBack}>
                      <Text style={styles.statBackTitle}>Success Rate</Text>
                      <Text style={styles.statBackValue}>
                        {totalReplied}/{totalSent}
                      </Text>
                      <Text style={styles.statBackLabel}>
                        replies received
                      </Text>
                    </View>
                  </Animated.View>
                </View>
              </TouchableOpacity>
            </View>
          </View>

          {/* Recipients Section */}
          <View style={styles.modernRecipientsSection}>
            <TouchableWithoutFeedback onPress={resetAllFlips}>
              <View style={styles.modernSectionHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.modernSectionTitle}>Companies</Text>
                  <Text style={styles.modernSectionSubtitle}>Manage your application recipients</Text>
                </View>
                <View style={styles.modernCountBadge}>
                  <Text style={styles.modernCountBadgeIcon}>◆</Text>
                  <Text style={styles.modernCountBadgeText}>{recipients.length}</Text>
                </View>
              </View>
            </TouchableWithoutFeedback>

            {/* Render all recipient forms */}
            {recipients.map((recipient, index) => (
              <View key={recipient.id} style={styles.modernRecipientCard}>
                <View style={styles.modernFormHeader}>
                  <View style={styles.recipientNumberBadge}>
                    <Text style={styles.recipientNumberText}>{index + 1}</Text>
                  </View>
                  <View style={styles.recipientHeaderInfo}>
                    <Text style={styles.modernFormTitle}>
                      {recipient.website 
                        ? recipient.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].substring(0, 25)
                        : recipient.email
                        ? recipient.email.split('@')[1] || 'New Company'
                        : 'New Company'}
                    </Text>
                    <Text style={styles.recipientSubtitle}>
                      {recipient.position || 'No position specified'}
                    </Text>
                  </View>
                  {recipients.length > 1 && (
                    <TouchableOpacity 
                      style={styles.modernRemoveBtn}
                      onPress={() => removeRecipient(recipient.id)}
                    >
                      <Text style={styles.modernRemoveIcon}>×</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Email Field */}
                <View style={styles.modernFormGroup}>
                  <Text style={styles.modernFormLabel}>
                    Hiring Manager Email <Text style={styles.required}>*</Text>
                  </Text>
                  <TextInput
                    style={[styles.modernFormInput, recipient.error && recipient.email && !isValidEmail(recipient.email) ? styles.modernFormInputError : {}]}
                    placeholder="hiring@company.com"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    value={recipient.email}
                    onChangeText={(text) => updateRecipient(recipient.id, 'email', text)}
                  />
                  {recipient.error && recipient.email && !isValidEmail(recipient.email) && (
                    <Text style={styles.errorMessage}>{recipient.error}</Text>
                  )}
                </View>

                {/* Website Field */}
                <View style={styles.modernFormGroup}>
                  <Text style={styles.modernFormLabel}>
                    Company Website <Text style={styles.required}>*</Text>
                  </Text>
                  <TextInput
                    style={[styles.modernFormInput, recipient.error && recipient.website && !isValidURL(recipient.website) ? styles.modernFormInputError : {}]}
                    placeholder="https://www.company.com"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="url"
                    autoCapitalize="none"
                    value={recipient.website}
                    onChangeText={(text) => updateRecipient(recipient.id, 'website', text)}
                  />
                  {recipient.error && recipient.website && !isValidURL(recipient.website) && (
                    <Text style={styles.modernErrorMessage}>{recipient.error}</Text>
                  )}
                </View>

                {/* Position Field */}
                <View style={styles.modernFormGroup}>
                  <Text style={styles.modernFormLabel}>Position / Job Title</Text>
                  <TextInput
                    style={styles.modernFormInput}
                    placeholder="e.g., Software Engineer, Marketing Manager"
                    placeholderTextColor="#9CA3AF"
                    value={recipient.position}
                    onChangeText={(text) => updateRecipient(recipient.id, 'position', text)}
                  />
                </View>
              </View>
            ))}

            {/* Add Another Button */}
            <TouchableOpacity style={styles.modernAddRecipientBtn} onPress={addRecipient}>
              <View style={styles.addBtnIconBox}>
                <Text style={styles.modernAddIcon}>+</Text>
              </View>
              <Text style={styles.modernAddText}>Add Company</Text>
            </TouchableOpacity>

            {/* Action Button */}
            <TouchableOpacity 
              onPress={handleReview}
              activeOpacity={0.85}
            >
              <LinearGradient
                colors={['#667eea', '#764ba2']}
                style={styles.modernActionBtn}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                <Text style={styles.modernActionBtnIcon}>✎</Text>
                <Text style={styles.modernActionBtnText}>Generate Cover Letters</Text>
                <Text style={styles.modernActionBtnArrow}>→</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* Recent Applications Section */}
          <View style={styles.modernRecentSection}>
            <View style={styles.modernSectionHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modernSectionTitle}>Recent Applications</Text>
                <Text style={styles.modernSectionSubtitle}>
                  {applicationHistory.length > 0 
                    ? `Showing ${Math.min(5, applicationHistory.length)} of ${totalSent} total sent`
                    : 'Your latest job applications'}
                </Text>
              </View>
              {applicationHistory.length > 0 && (user.provider === 'google' || user.provider === 'microsoft') && (
                <TouchableOpacity 
                  style={styles.refreshButton}
                  onPress={checkEmailReplies}
                  disabled={isCheckingReplies}
                >
                  <Text style={[styles.refreshButtonIcon, isCheckingReplies && styles.refreshButtonIconSpinning]}>
                    ↻
                  </Text>
                  <Text style={styles.refreshButtonText}>
                    {isCheckingReplies ? 'Checking...' : 'Check Replies'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            
            {applicationHistory.length === 0 ? (
              <View style={styles.modernEmptyState}>
                <View style={styles.emptyStateIconBox}>
                  <Text style={styles.modernEmptyIcon}>—</Text>
                </View>
                <Text style={styles.modernEmptyTitle}>No Applications Yet</Text>
                <Text style={styles.modernEmptySubtitle}>Your recent job applications will appear here</Text>
              </View>
            ) : (
              <View style={styles.modernApplicationsList}>
                {applicationHistory.slice(0, 5).map((app, index) => (
                  <TouchableOpacity 
                    key={app.id}
                    style={styles.modernApplicationCard}
                    disabled={app.replyReceived}
                    activeOpacity={!app.replyReceived ? 0.7 : 1}
                    onPress={() => {
                      if (!app.replyReceived) {
                        setReplyAppId(app.id);
                        const now = new Date();
                        setSelectedReplyDate(now);
                        selectedReplyDateRef.current = now;
                        setShowReplyDatePicker(true);
                      }
                    }}
                  >
                    {/* Left accent bar */}
                    <View style={[
                      styles.applicationAccentBar,
                      app.replyReceived ? styles.accentBarReplied : styles.accentBarPending
                    ]} />
                    
                    {/* Content Container */}
                    <View style={styles.applicationCardInner}>
                      {/* Header Row: Number + Company + Status */}
                      <View style={styles.applicationTopRow}>
                        <View style={styles.applicationNumberBadge}>
                          <Text style={styles.applicationNumberText}>{index + 1}</Text>
                        </View>
                        
                        <View style={styles.applicationMainInfo}>
                          <Text style={styles.applicationCompany} numberOfLines={1}>{app.companyName}</Text>
                          <Text style={styles.applicationPosition} numberOfLines={1}>
                            {app.position || 'Position not specified'}
                          </Text>
                        </View>
                        
                        <View style={[
                          styles.modernStatusBadge,
                          app.replyReceived ? styles.modernStatusReplied : styles.modernStatusPending
                        ]}>
                          {app.replyReceived ? (
                            <Text style={[styles.modernStatusText, styles.statusTextReplied]}>✓</Text>
                          ) : (
                            <View style={styles.clockIcon}>
                              <View style={styles.clockCircle} />
                              <View style={styles.clockHourHand} />
                              <View style={styles.clockMinuteHand} />
                            </View>
                          )}
                        </View>
                      </View>
                      
                      {/* Dates Row */}
                      <View style={styles.applicationDatesRow}>
                        <View style={styles.dateItem}>
                          <Text style={styles.dateLabel}>Sent</Text>
                          <Text style={styles.dateValue}>
                            {new Date(app.sentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </Text>
                        </View>
                        
                        {app.replyReceived && app.replyDate && (
                          <>
                            <View style={styles.dateSeparator} />
                            <View style={styles.dateItem}>
                              <Text style={styles.dateLabel}>Latest Reply</Text>
                              <Text style={[styles.dateValue, styles.dateValueReplied]}>
                                {new Date(app.replyDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </Text>
                            </View>
                          </>
                        )}
                      </View>
                      
                      {/* Action hint or reply preview */}
                      {!app.replyReceived ? (
                        <View style={styles.modernActionHint}>
                          <Text style={styles.modernActionHintText}>✓ Tap to mark as replied</Text>
                        </View>
                      ) : app.replySnippet ? (
                        <TouchableOpacity 
                          style={styles.showReplyButton}
                          onPress={() => showAllReplies(app.id, app.companyName)}
                        >
                          <Text style={styles.showReplyButtonText}>
                            📬 Show {app.replyCount > 1 ? `${app.replyCount} Replies` : 'Reply'}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {/* Settings Section - Show when toggle is on */}
          {showSettings && (
            <View style={styles.settingsSection}>
              <Text style={styles.sectionTitle}>Account Settings</Text>
              
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Email</Text>
                <Text style={styles.settingValue}>{user?.email}</Text>
              </View>

              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Full Name</Text>
                <Text style={styles.settingValue}>{user?.fullName || user?.name}</Text>
              </View>

              {user?.provider === 'google' && (
                <View style={styles.settingItem}>
                  <Text style={styles.settingLabel}>Login Method</Text>
                  <Text style={styles.settingValue}>Google Account</Text>
                </View>
              )}

              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Account Status</Text>
                <Text style={styles.settingValueActive}>Active ✓</Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Reply Details Modal */}
        <Modal
          transparent={true}
          visible={showReplyDetailsModal}
          animationType="fade"
          onRequestClose={() => setShowReplyDetailsModal(false)}
        >
          <View style={styles.replyModalOverlay}>
            <View style={styles.replyDetailsModalContainer}>
              {/* Header */}
              <View style={styles.replyDetailsModalHeader}>
                <Text style={styles.replyDetailsModalTitle}>
                  📬 {selectedReplyDetails?.companyName || 'Reply Details'}
                </Text>
                <TouchableOpacity 
                  onPress={() => setShowReplyDetailsModal(false)}
                  style={styles.closeModalButton}
                >
                  <Text style={styles.closeModalButtonText}>✕</Text>
                </TouchableOpacity>
              </View>

              {selectedReplyDetails && selectedReplyDetails.replies && selectedReplyDetails.replies.length > 0 && (() => {
                const firstReply = selectedReplyDetails.replies[0];
                return (
                  <>
                    {/* Common meta: from + subject */}
                    <View style={styles.replyMetaSection}>
                      <Text style={styles.replyMetaFrom} numberOfLines={1}>✉️  {firstReply.replyFromEmail}</Text>
                      <Text style={styles.replyMetaSubject} numberOfLines={2}>{firstReply.replySubject || '(No Subject)'}</Text>
                      <Text style={styles.replyMetaCount}>
                        {selectedReplyDetails.count} {selectedReplyDetails.count === 1 ? 'reply' : 'replies'} received
                      </Text>
                    </View>

                    {/* Reply list — single ScrollView, no inner scroll */}
                    <ScrollView
                      style={styles.replyDetailsContent}
                      contentContainerStyle={{ paddingBottom: 16 }}
                      showsVerticalScrollIndicator={true}
                      nestedScrollEnabled={true}
                    >
                      {[...selectedReplyDetails.replies].sort((a, b) => new Date(b.replyDate) - new Date(a.replyDate)).map((reply, index) => (
                        <View key={reply.id || index} style={styles.replyCard}>
                          <Text style={styles.replyCardDate}>
                            {new Date(reply.replyDate).toLocaleString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                              hour: 'numeric', minute: '2-digit'
                            })}
                          </Text>
                          <Text style={styles.replyPreviewText}>{reply.replySnippet || '(No content available)'}</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </>
                );
              })()}

              <TouchableOpacity
                style={styles.replyDetailsCloseButton}
                onPress={() => setShowReplyDetailsModal(false)}
              >
                <Text style={styles.replyDetailsCloseButtonText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Reply Date Picker Modal */}
        <Modal
          transparent={true}
          visible={showReplyDatePicker}
          animationType="slide"
          onRequestClose={() => setShowReplyDatePicker(false)}
        >
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => setShowReplyDatePicker(false)}>
              <View style={{ flex: 1 }} />
            </TouchableWithoutFeedback>
              <SafeAreaViewContext style={styles.datePickerModalWrapper}>
                <View style={styles.datePickerModal}>
                    {/* Header */}
                    <View style={styles.datePickerHeader}>
                      <View style={styles.datePickerHeaderLine} />
                      <Text style={styles.datePickerTitle}>Reply Date</Text>
                    </View>
                    
                    {/* Date Picker Container */}
                    <View style={styles.datePickerContainer}>
                      <DateTimePicker
                        value={selectedReplyDate}
                        mode="date"
                        display="spinner"
                        onChange={(event, date) => {
                          const currentDate = date || selectedReplyDate;
                          setSelectedReplyDate(currentDate);
                          selectedReplyDateRef.current = currentDate;
                        }}
                        maximumDate={new Date()}
                        themeVariant="light"
                        style={{ height: 216, width: '100%' }}
                      />
                    </View>
                    
                    {/* Buttons */}
                    <View style={styles.modalButtons}>
                      <TouchableOpacity
                        style={styles.modalCancelButton}
                        onPress={() => setShowReplyDatePicker(false)}
                      >
                        <Text style={styles.modalCancelText}>Cancel</Text>
                      </TouchableOpacity>
                      
                      <TouchableOpacity
                        style={styles.modalConfirmButton}
                        onPress={async () => {
                          try {
                            // Save to server first
                            const response = await fetch(`${API_BASE}/users/application-history/${replyAppId}`, {
                              method: 'PATCH',
                              headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${userRef.current?.token}`,
                              },
                              body: JSON.stringify({
                                replyReceived: true,
                                replyDate: selectedReplyDateRef.current.toISOString(),
                              }),
                            });

                            if (response.ok) {
                              const replyDateISO = selectedReplyDateRef.current.toISOString();
                              // Update local application history
                              setApplicationHistory(prev => {
                                const updated = prev.map(item =>
                                  item.id === replyAppId
                                    ? { ...item, replyReceived: true, replyDate: replyDateISO }
                                    : item
                                );
                                // Also update AsyncStorage cache to survive page changes
                                if (user?.email) {
                                  AsyncStorage.setItem(`applicationHistory_${user.email}`, JSON.stringify(updated)).catch(() => {});
                                }
                                return updated;
                              });
                              // Update dashboard counters immediately
                              setTotalReplied(prev => prev + 1);
                              setShowReplyDatePicker(false);
                            } else {
                              const data = await response.json();
                              Alert.alert('Error', data.error || 'Failed to save reply status');
                            }
                          } catch (err) {
                            console.error('Mark as replied error:', err);
                            Alert.alert('Error', 'Failed to save reply. Please try again.');
                          }
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

        {/* Notifications Modal */}
        <Modal
          transparent={true}
          visible={showNotifications}
          animationType="slide"
          onRequestClose={() => setShowNotifications(false)}
        >
          <TouchableWithoutFeedback onPress={() => setShowNotifications(false)}>
            <View style={styles.notificationModalOverlay}>
              <TouchableWithoutFeedback>
                <SafeAreaViewContext style={styles.notificationModalWrapper}>
                  <View style={styles.notificationModal}>
                    {/* Header */}
                    <View style={styles.notificationHeader}>
                      <View style={styles.notificationHeaderLine} />
                      <Text style={styles.notificationTitle}>Notifications</Text>
                      {unreadCount > 0 && (
                        <View style={styles.notificationHeaderBadge}>
                          <Text style={styles.notificationHeaderBadgeText}>{unreadCount}</Text>
                        </View>
                      )}
                    </View>
                    
                    {/* Body */}
                    <ScrollView 
                      style={styles.notificationBody}
                      showsVerticalScrollIndicator={false}
                    >
                      {loadingNotifications ? (
                        <View style={styles.notificationLoading}>
                          <ActivityIndicator size="large" color="#667eea" />
                          <Text style={styles.notificationLoadingText}>Loading notifications...</Text>
                        </View>
                      ) : notifications.length === 0 ? (
                        <View style={styles.notificationEmpty}>
                          <View style={styles.emptyBellContainer}>
                            <View style={styles.emptyBellHandle} />
                            <View style={styles.emptyBellBody} />
                            <View style={styles.emptyBellOpening} />
                          </View>
                          <Text style={styles.notificationEmptyTitle}>No notifications yet</Text>
                          <Text style={styles.notificationEmptyText}>You'll be notified when something important happens</Text>
                        </View>
                      ) : (
                        notifications.map((notif, index) => (
                          <TouchableOpacity
                            key={notif.id || index}
                            activeOpacity={0.7}
                            onPress={() => {
                              if (!notif.is_read) {
                                markNotificationAsRead(notif.id);
                              }
                            }}
                            style={[
                              styles.notificationItem,
                              !notif.is_read && styles.notificationItemUnread,
                              index === notifications.length - 1 && styles.notificationItemLast
                            ]}
                          >
                            <View style={[
                              styles.notificationIconBox,
                              notif.type === 'email' && styles.notificationIconEmail,
                              notif.type === 'cover_letter' && styles.notificationIconLetter,
                              notif.type === 'credits' && styles.notificationIconCredits,
                              notif.type === 'profile' && styles.notificationIconProfile,
                            ]}>
                              <Text style={styles.notificationItemIcon}>
                                {notif.type === 'email' ? '✉' : 
                                 notif.type === 'cover_letter' ? '📄' : 
                                 notif.type === 'credits' ? '◆' : 
                                 notif.type === 'profile' ? '👤' : '🔔'}
                              </Text>
                            </View>
                            <View style={styles.notificationContent}>
                              <View style={styles.notificationTopRow}>
                                <Text style={styles.notificationItemTitle} numberOfLines={1}>
                                  {notif.title}
                                </Text>
                                <Text style={styles.notificationTime}>
                                  {getTimeAgo(notif.created_at)}
                                </Text>
                              </View>
                              <Text style={styles.notificationMessage} numberOfLines={2}>
                                {notif.message}
                              </Text>
                              {!notif.is_read && (
                                <View style={styles.notificationUnreadDot} />
                              )}
                            </View>
                          </TouchableOpacity>
                        ))
                      )}
                    </ScrollView>
                    
                    {/* Footer */}
                    {notifications.length > 0 && (
                      <View style={styles.notificationFooter}>
                        <TouchableOpacity 
                          style={styles.viewAllButton}
                          onPress={() => {
                            setShowNotifications(false);
                            setScreen('notifications');
                          }}
                        >
                          <LinearGradient
                            colors={['#667eea', '#764ba2']}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 0 }}
                            style={styles.viewAllGradient}
                          >
                            <Text style={styles.viewAllText}>View All Notifications</Text>
                          </LinearGradient>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                </SafeAreaViewContext>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      </SafeAreaViewContext>
    );
  }

  // USAGE & CREDITS SCREEN
  if (screen === 'usage') {
    return (
      <SafeAreaViewContext style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" translucent={false} />
        
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
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
      </SafeAreaViewContext>
    );
  }

  // NOTIFICATIONS SCREEN
  if (screen === 'notifications') {
    // Filter notifications based on selected filter
    const filteredNotifications = notifications.filter(notif => {
      if (notificationFilter === 'unread') return !notif.is_read;
      if (notificationFilter === 'read') return notif.is_read;
      return true; // 'all'
    });

    return (
      <SafeAreaViewContext style={styles.notificationsPageContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#667eea" translucent={false} />
        
        {/* Header with Gradient */}
        <LinearGradient
          colors={['#667eea', '#764ba2']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.notificationsHeader}
        >
          <View style={styles.notificationsHeaderTop}>
            <TouchableOpacity 
              style={styles.notificationsBackButton}
              onPress={() => setScreen('dashboard')}
            >
              <Text style={styles.notificationsBackIcon}>←</Text>
            </TouchableOpacity>
            <View style={styles.notificationsHeaderCenter}>
              <Text style={styles.notificationsHeaderTitle}>Notifications</Text>
              {unreadCount > 0 && (
                <View style={styles.notificationsHeaderBadge}>
                  <Text style={styles.notificationsHeaderBadgeText}>{unreadCount}</Text>
                </View>
              )}
            </View>
            {unreadCount > 0 && (
              <TouchableOpacity 
                style={styles.notificationsMarkReadButton}
                onPress={markAllNotificationsRead}
              >
                <Text style={styles.notificationsMarkReadText}>✓</Text>
              </TouchableOpacity>
            )}
            {unreadCount === 0 && <View style={{ width: 44 }} />}
          </View>
        </LinearGradient>

        {/* Filter Tabs */}
        <View style={styles.notificationsFilters}>
          <TouchableOpacity
            style={[
              styles.notificationsFilterTab,
              notificationFilter === 'all' && styles.notificationsFilterTabActive
            ]}
            onPress={() => setNotificationFilter('all')}
          >
            <Text style={[
              styles.notificationsFilterText,
              notificationFilter === 'all' && styles.notificationsFilterTextActive
            ]}>
              All ({notifications.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.notificationsFilterTab,
              notificationFilter === 'unread' && styles.notificationsFilterTabActive
            ]}
            onPress={() => setNotificationFilter('unread')}
          >
            <Text style={[
              styles.notificationsFilterText,
              notificationFilter === 'unread' && styles.notificationsFilterTextActive
            ]}>
              Unread ({unreadCount})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.notificationsFilterTab,
              notificationFilter === 'read' && styles.notificationsFilterTabActive
            ]}
            onPress={() => setNotificationFilter('read')}
          >
            <Text style={[
              styles.notificationsFilterText,
              notificationFilter === 'read' && styles.notificationsFilterTextActive
            ]}>
              Read ({notifications.length - unreadCount})
            </Text>
          </TouchableOpacity>
        </View>

        {/* Notifications List */}
        <ScrollView 
          style={styles.notificationsScrollView}
          contentContainerStyle={styles.notificationsScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {loadingNotifications ? (
            <View style={styles.notificationsLoading}>
              <ActivityIndicator size="large" color="#667eea" />
              <Text style={styles.notificationsLoadingText}>Loading notifications...</Text>
            </View>
          ) : filteredNotifications.length === 0 ? (
            <View style={styles.notificationsEmpty}>
              <View style={styles.notificationsEmptyIconBox}>
                <Text style={styles.notificationsEmptyIcon}>🔔</Text>
              </View>
              <Text style={styles.notificationsEmptyTitle}>
                {notificationFilter === 'unread' ? 'No unread notifications' :
                 notificationFilter === 'read' ? 'No read notifications' :
                 'No notifications yet'}
              </Text>
              <Text style={styles.notificationsEmptySubtitle}>
                {notificationFilter === 'all' 
                  ? "You'll be notified when something important happens"
                  : 'Check back later for updates'}
              </Text>
            </View>
          ) : (
            <View style={styles.notificationsListContainer}>
              {filteredNotifications.map((notif, index) => (
                <TouchableOpacity
                  key={notif.id || index}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (!notif.is_read) {
                      markNotificationAsRead(notif.id);
                    }
                  }}
                  style={[
                    styles.notificationsPageItem,
                    !notif.is_read && styles.notificationsPageItemUnread
                  ]}
                >
                  <View style={[
                    styles.notificationsPageIconBox,
                    notif.type === 'email' && styles.notificationsIconTypeEmail,
                    notif.type === 'cover_letter' && styles.notificationsIconTypeLetter,
                    notif.type === 'credits' && styles.notificationsIconTypeCredits,
                    notif.type === 'profile' && styles.notificationsIconTypeProfile,
                  ]}>
                    <Text style={styles.notificationsPageIcon}>
                      {notif.type === 'email' ? '✉' : 
                       notif.type === 'cover_letter' ? '📄' : 
                       notif.type === 'credits' ? '◆' : 
                       notif.type === 'profile' ? '👤' : '🔔'}
                    </Text>
                  </View>
                  <View style={styles.notificationsPageContent}>
                    <View style={styles.notificationsPageTopRow}>
                      <Text style={styles.notificationsPageTitle} numberOfLines={2}>
                        {notif.title}
                      </Text>
                      {!notif.is_read && (
                        <View style={styles.notificationsPageUnreadBadge}>
                          <View style={styles.notificationsPageUnreadDot} />
                        </View>
                      )}
                    </View>
                    <Text style={styles.notificationsPageMessage}>
                      {notif.message}
                    </Text>
                    <Text style={styles.notificationsPageTime}>
                      {getTimeAgo(notif.created_at)}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
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
                        <Text style={styles.packageCurrency}>$</Text>
                        <Text style={styles.packagePrice}>{pkg.amount}</Text>
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
        </ScrollView>

        {/* Payment WebView Modal */}
        <Modal
          visible={showPaymentModal}
          animationType="slide"
          transparent={false}
          onRequestClose={() => {
            console.log('🚫 Payment modal closed');
            setShowPaymentModal(false);
            setPaymentUrl('');
          }}
        >
          <SafeAreaViewContext style={{flex: 1, backgroundColor: '#fff'}}>
            <View style={{flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb', backgroundColor: '#fff'}}>
              <TouchableOpacity 
                onPress={() => {
                  console.log('❌ Close button pressed');
                  setShowPaymentModal(false);
                  setPaymentUrl('');
                }}
                style={{padding: 8}}
              >
                <Text style={{fontSize: 18, color: '#3b82f6', fontWeight: '600'}}>✕ Close</Text>
              </TouchableOpacity>
              <Text style={{flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: '#1f2937'}}>Complete Payment</Text>
              <View style={{width: 60}} />
            </View>
            {paymentUrl ? (
              <WebView
                source={{ uri: paymentUrl }}
                style={{flex: 1}}
                onNavigationStateChange={(navState) => {
                  console.log('📱 Navigation:', navState.url);
                  
                  // Check if payment was successful
                  if (navState.url.includes('/payment-success.html')) {
                    // Extract payment details from URL (Razorpay returns payment_id, order_id, signature)
                    const url = new URL(navState.url);
                    const razorpay_payment_id = url.searchParams.get('payment_id');
                    const razorpay_order_id = url.searchParams.get('order_id');
                    const razorpay_signature = url.searchParams.get('signature');
                    
                    console.log('💳 Payment details:', { razorpay_payment_id, razorpay_order_id, razorpay_signature });
                    
                    // ✅ CLOSE MODAL IMMEDIATELY (non-blocking)
                    setTimeout(async () => {
                      setShowPaymentModal(false);
                      setPaymentUrl('');
                      
                      try {
                        // Verify payment with backend
                        const verifyResponse = await fetch(`${API_BASE}/payment/verify`, {
                          method: 'POST',
                          headers: {
                            'Authorization': `Bearer ${user.token}`,
                            'Content-Type': 'application/json',
                          },
                          body: JSON.stringify({
                            razorpay_order_id,
                            razorpay_payment_id,
                            razorpay_signature
                          })
                        });
                        
                        const verifyData = await verifyResponse.json();
                        console.log('✅ Payment verification response:', verifyData);
                        
                        if (verifyData.success) {
                          // Update credit balance from verification response
                          // Also reload from API to ensure sync
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
                                console.log('💳 Reloaded credits after payment:', creditsData.balance);
                              }
                            }
                          } catch (reloadError) {
                            console.log('Failed to reload credits, using verification response');
                            setCreditBalance(verifyData.credits);
                          }
                          
                          // Force screen refresh by navigating away and back
                          setScreen('');
                          setTimeout(() => {
                            // Close processing alert and show success
                            Alert.alert(
                              '🎉 Payment Successful!',
                              `${verifyData.creditsAdded} credits have been added to your account!\n\nNew Balance: ${verifyData.credits} credits`,
                              [{ text: 'Awesome!', onPress: () => setScreen('dashboard') }]
                            );
                          }, 100);
                        } else {
                          throw new Error(verifyData.error || 'Verification failed');
                        }
                      } catch (error) {
                        console.error('❌ Payment verification error:', error);
                        Alert.alert(
                          'Verification Pending',
                          'Payment received! Credits will be added shortly. Please check your balance in a few minutes.',
                          [{ text: 'OK', onPress: () => setScreen('dashboard') }]
                        );
                      }
                    }, 10);
                  } else if (navState.url.includes('/payment-failure.html')) {
                    // Close modal immediately on failure too
                    setTimeout(() => {
                      setShowPaymentModal(false);
                      setPaymentUrl('');
                      Alert.alert('Payment Failed', 'Payment was not completed. Please try again.', [{ text: 'OK' }]);
                    }, 10);
                  }
                }}
                javaScriptEnabled={true}
                domStorageEnabled={true}
                startInLoadingState={true}
                scalesPageToFit={true}
              />
            ) : (
              <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
                <ActivityIndicator size="large" color="#3b82f6" />
                <Text style={{marginTop: 16, color: '#6b7280'}}>Loading payment...</Text>
              </View>
            )}
          </SafeAreaViewContext>
        </Modal>
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
                    style={styles.uploadPreview}
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
                      const initDate = profileData?.dateOfBirth ? new Date(profileData.dateOfBirth) : new Date();
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
            <TouchableOpacity 
              style={[
                styles.uploadZone,
                isEditingProfile && styles.uploadZoneActive
              ]}
              onPress={pickSignature}
              disabled={!isEditingProfile}
              activeOpacity={isEditingProfile ? 0.7 : 1}
            >
              {profileData?.signature ? (
                <Image 
                  source={{ uri: profileData.signature }}
                  style={styles.uploadPreview}
                />
              ) : (
                <View style={styles.uploadPlaceholder}>
                  <Text style={styles.uploadIcon}>✍️</Text>
                  <Text style={styles.uploadText}>{isEditingProfile ? 'Tap to upload signature' : 'No signature uploaded'}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

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
              <Text style={styles.actionButtonText}>Change Password</Text>
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
                      <Text style={styles.accountModalTitle}>🔒 Change Password</Text>
                      <TouchableOpacity onPress={() => setShowChangePassword(false)}>
                        <Text style={styles.accountModalCloseBtn}>✕</Text>
                      </TouchableOpacity>
                    </View>

                    <ScrollView 
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={styles.accountModalScrollContent}
                    >
                      <TextInput
                        style={styles.accountModalInput}
                        placeholder="Current Password"
                        placeholderTextColor="#9ca3af"
                        secureTextEntry
                        value={currentPassword}
                        onChangeText={setCurrentPassword}
                      />
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
                      <Text style={styles.accountModalButtonText}>Change Password</Text>
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

        {/* Date of Birth Picker Modal */}
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
      const currentData = reviewCoverLetters[index] || {};
      setEditingReviewIndex(index);
      setEditedCoverLetterData({
        hiringManager: currentData.hiringManager || '',
        companyName: currentData.companyName || '',
        email: recipients[index]?.email || '',
        address: currentData.address || (currentData.locations?.find(loc => loc.isHeadquarters)?.address || currentData.locations?.[0]?.address || ''),
        date: currentData.date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        position: recipients[index]?.position || '',
        subject: currentData.subject || '',
        coverLetterText: currentData.coverLetterText || ''
      });
    }
  };

  const saveReviewEdits = (index) => {
    // Update cover letter with edited data - use functional setState
    setReviewCoverLetters(prev => {
      const updated = {
        ...prev,
        [index]: {
          ...prev[index],
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
    const coverLetter = reviewCoverLetters[index];
    return coverLetter && coverLetter.sent;
  });
  
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
          {reviewCoverLetters[currentReviewTab] ? (
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
                    {reviewCoverLetters[currentReviewTab].locations && reviewCoverLetters[currentReviewTab].locations.length > 0 ? (
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
                                {reviewCoverLetters[currentReviewTab].locations.map((location, idx) => (
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
                      initialHtml={reviewCoverLetters[currentReviewTab]?.coverLetterHtml || editedCoverLetterData.coverLetterHtml || ''}
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
                        <Text style={styles.fieldDisplayValue}>{reviewCoverLetters[currentReviewTab].companyName}</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRowDouble}>
                      <View style={styles.fieldDisplayHalf}>
                        <Text style={styles.fieldDisplayLabel}>Position</Text>
                        <Text style={styles.fieldDisplayValue}>{recipients[currentReviewTab]?.position}</Text>
                      </View>
                      <View style={styles.fieldDisplayHalf}>
                        <Text style={styles.fieldDisplayLabel}>Date</Text>
                        <Text style={styles.fieldDisplayValue}>{reviewCoverLetters[currentReviewTab].date}</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRow}>
                      <View style={styles.fieldDisplay}>
                        <Text style={styles.fieldDisplayLabel}>Address</Text>
                        <Text style={styles.fieldDisplayValue}>{reviewCoverLetters[currentReviewTab].address}</Text>
                      </View>
                    </View>

                    <View style={styles.fieldDisplayRow}>
                      <View style={styles.fieldDisplay}>
                        <Text style={styles.fieldDisplayLabel}>Subject</Text>
                        <Text style={styles.fieldDisplayValue}>{reviewCoverLetters[currentReviewTab].subject}</Text>
                      </View>
                    </View>

                    {/* Cover Letter Preview */}
                    <View style={styles.coverLetterPreviewContainer}>
                      <Text style={styles.coverLetterPreviewLabel}>Cover Letter Preview</Text>
                      <View style={{ height: 400 }}>
                        <HTMLContentViewer 
                          htmlContent={reviewCoverLetters[currentReviewTab].coverLetterHtml || 'Cover letter content'}
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
                              'Remaining credits are 0. Please recharge to continue downloading PDFs.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Recharge Now', onPress: () => setScreen('packages') }
                              ]
                            );
                            return;
                          }
                          downloadCoverLetterPDFFromReview(currentReviewTab);
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
                        disabled={reviewLoading || reviewSendingAll || reviewGeneratingAndSendingAll || reviewCoverLetters[currentReviewTab].sent}
                        activeOpacity={0.8}
                      >
                        {!reviewCoverLetters[currentReviewTab].sent ? (
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
                {progressiveLoadingMessage && reviewGeneratingIndex !== null && !reviewGeneratingAll && (
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

        {/* Review Date Picker Modal */}
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
  notificationsPageContainer: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  notificationsHeader: {
    paddingTop: 16,
    paddingBottom: 20,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  notificationsHeaderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  notificationsBackButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationsBackIcon: {
    fontSize: 24,
    color: '#ffffff',
    fontWeight: '700',
  },
  notificationsHeaderCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  notificationsHeaderTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  notificationsHeaderBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  notificationsHeaderBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  notificationsMarkReadButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationsMarkReadText: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '700',
  },
  notificationsFilters: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  notificationsFilterTab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  notificationsFilterTabActive: {
    backgroundColor: '#667eea',
    borderColor: '#667eea',
  },
  notificationsFilterText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.3,
  },
  notificationsFilterTextActive: {
    color: '#ffffff',
  },
  notificationsScrollView: {
    flex: 1,
  },
  notificationsScrollContent: {
    paddingBottom: 20,
  },
  notificationsLoading: {
    paddingVertical: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationsLoadingText: {
    marginTop: 16,
    fontSize: 15,
    color: '#64748b',
    fontWeight: '600',
  },
  notificationsEmpty: {
    paddingVertical: 100,
    paddingHorizontal: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationsEmptyIconBox: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  notificationsEmptyIcon: {
    fontSize: 40,
    opacity: 0.4,
  },
  notificationsEmptyTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1e293b',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  notificationsEmptySubtitle: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 20,
  },
  notificationsListContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
  },
  notificationsPageItem: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#f1f5f9',
  },
  notificationsPageItemUnread: {
    backgroundColor: '#f0f9ff',
    borderColor: '#bae6fd',
    borderWidth: 1.5,
  },
  notificationsPageIconBox: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  notificationsIconTypeEmail: {
    backgroundColor: '#dbeafe',
  },
  notificationsIconTypeLetter: {
    backgroundColor: '#fce7f3',
  },
  notificationsIconTypeCredits: {
    backgroundColor: '#fef3c7',
  },
  notificationsIconTypeProfile: {
    backgroundColor: '#e0e7ff',
  },
  notificationsPageIcon: {
    fontSize: 24,
  },
  notificationsPageContent: {
    flex: 1,
  },
  notificationsPageTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  notificationsPageTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#1e293b',
    marginRight: 8,
    letterSpacing: 0.2,
    lineHeight: 22,
  },
  notificationsPageUnreadBadge: {
    marginLeft: 8,
  },
  notificationsPageUnreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3b82f6',
  },
  notificationsPageMessage: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
    marginBottom: 8,
  },
  notificationsPageTime: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '600',
    letterSpacing: 0.3,
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
