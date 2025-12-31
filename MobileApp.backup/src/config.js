// Configuration file for Lettrico Mobile App

export const config = {
  // App Information
  APP_NAME: 'Lettrico',
  APP_VERSION: '1.0.0',
  APP_DESCRIPTION: 'Turn applications into opportunities',

  // API Configuration
  API_BASE_URL: __DEV__ 
    ? 'http://localhost:3000'  // Development
    : 'https://api.lettrico.com', // Production
  
  // API Timeouts (in milliseconds)
  API_TIMEOUT: 10000,
  
  // Google OAuth Configuration
  GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
  GOOGLE_SCOPES: ['profile', 'email'],
  
  // Session Management
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  AUTO_LOGOUT_WARNING: 15 * 60 * 1000,   // 15 minutes warning
  
  // Pagination
  DEFAULT_PAGE_SIZE: 10,
  
  // File Upload Configuration
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_FILE_TYPES: ['application/pdf', 'application/msword'],
  
  // Color Scheme
  COLORS: {
    primary: '#1e40af',
    secondary: '#f3f4f6',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#3b82f6',
    text: {
      primary: '#1f2937',
      secondary: '#6b7280',
      tertiary: '#9ca3af',
      light: '#d1d5db',
    },
    background: {
      default: '#f8fafc',
      surface: '#ffffff',
    },
    border: '#e2e8f0',
  },
  
  // Typography
  FONTS: {
    sizes: {
      xs: 12,
      sm: 14,
      base: 16,
      lg: 18,
      xl: 20,
      '2xl': 24,
      '3xl': 30,
      '4xl': 36,
    },
    weights: {
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
  },
  
  // Spacing
  SPACING: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    '2xl': 32,
  },
  
  // Border Radius
  BORDER_RADIUS: {
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
  
  // Cover Letter Settings
  COVER_LETTER: {
    MAX_LENGTH: 1500,
    MIN_LENGTH: 200,
    DEFAULT_TEMPLATE: `Dear Hiring Manager,

I am writing to express my strong interest in the [POSITION] role at [COMPANY]. With my background in [FIELD] and proven track record of [KEY_ACHIEVEMENT], I am confident in my ability to contribute significantly to your team.

[BODY_PARAGRAPH]

I am excited about the opportunity to bring my [KEY_SKILLS] to [COMPANY] and would welcome the chance to discuss how I can add value to your organization.

Thank you for considering my application.

Sincerely,
[YOUR_NAME]`,
  },
  
  // Application Settings
  APPLICATION: {
    STATUSES: ['Applied', 'Interviewing', 'Offered', 'Rejected', 'Withdrawn'],
    DEFAULT_STATUS: 'Applied',
  },
  
  // Validation Rules
  VALIDATION: {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    password: {
      minLength: 6,
      requireUppercase: false,
      requireNumbers: false,
      requireSpecialChar: false,
    },
    phone: /^[\d\s\-\+\(\)]+$/,
  },
  
  // Security
  SECURITY: {
    ENABLE_BIOMETRIC: true,
    REQUIRE_PIN: false,
    PIN_LENGTH: 4,
  },
  
  // Feature Flags
  FEATURES: {
    GOOGLE_LOGIN: true,
    LINKEDIN_LOGIN: false,
    COVER_LETTER_AI: true,
    RESUME_UPLOAD: false,
    INTERVIEW_PREP: false,
    SALARY_NEGOTIATION: false,
  },
  
  // Links
  LINKS: {
    PRIVACY_POLICY: 'https://lettrico.com/privacy',
    TERMS_OF_SERVICE: 'https://lettrico.com/terms',
    SUPPORT_EMAIL: 'support@lettrico.com',
    WEBSITE: 'https://lettrico.com',
    GITHUB: 'https://github.com/lettrico',
    TWITTER: 'https://twitter.com/lettrico',
  },
  
  // Notifications
  NOTIFICATIONS: {
    ENABLE_PUSH: true,
    ENABLE_EMAIL: true,
    ENABLE_SMS: false,
  },
};

export const API_BASE_URL = config.API_BASE_URL;
export const APP_NAME = config.APP_NAME;

export default config;
