// Utility functions for Lettrico Mobile App

import * as SecureStore from 'expo-secure-store';

// Token Management
export const tokenUtils = {
  async saveToken(token) {
    try {
      await SecureStore.setItemAsync('authToken', token);
      return true;
    } catch (error) {
      console.error('Error saving token:', error);
      return false;
    }
  },

  async getToken() {
    try {
      return await SecureStore.getItemAsync('authToken');
    } catch (error) {
      console.error('Error retrieving token:', error);
      return null;
    }
  },

  async removeToken() {
    try {
      await SecureStore.deleteItemAsync('authToken');
      return true;
    } catch (error) {
      console.error('Error removing token:', error);
      return false;
    }
  },

  async isTokenValid() {
    const token = await this.getToken();
    return !!token;
  },
};

// User Management
export const userUtils = {
  async saveUserData(userData) {
    try {
      await SecureStore.setItemAsync('userData', JSON.stringify(userData));
      return true;
    } catch (error) {
      console.error('Error saving user data:', error);
      return false;
    }
  },

  async getUserData() {
    try {
      const data = await SecureStore.getItemAsync('userData');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error retrieving user data:', error);
      return null;
    }
  },

  async clearUserData() {
    try {
      await SecureStore.deleteItemAsync('userData');
      return true;
    } catch (error) {
      console.error('Error clearing user data:', error);
      return false;
    }
  },

  async logout() {
    const tokenRemoved = await tokenUtils.removeToken();
    const userRemoved = await this.clearUserData();
    return tokenRemoved && userRemoved;
  },
};

// Validation Utilities
export const validationUtils = {
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  isValidPassword(password) {
    // Minimum 6 characters
    return password && password.length >= 6;
  },

  isValidPhoneNumber(phone) {
    const phoneRegex = /^[\d\s\-\+\(\)]+$/;
    return phoneRegex.test(phone);
  },

  isValidUrl(url) {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  },

  getPasswordStrength(password) {
    let strength = 0;
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[!@#$%^&*]/.test(password)) strength++;
    
    if (strength <= 1) return 'Weak';
    if (strength <= 2) return 'Fair';
    if (strength <= 3) return 'Good';
    if (strength <= 4) return 'Strong';
    return 'Very Strong';
  },
};

// Date Utilities
export const dateUtils = {
  formatDate(date, format = 'MMM DD, YYYY') {
    if (!date) return '';
    const d = new Date(date);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const day = d.getDate().toString().padStart(2, '0');
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    
    return format
      .replace('DD', day)
      .replace('MMM', month)
      .replace('YYYY', year);
  },

  isDateInPast(date) {
    return new Date(date) < new Date();
  },

  isDateToday(date) {
    const today = new Date();
    const d = new Date(date);
    return d.toDateString() === today.toDateString();
  },

  getDaysUntil(date) {
    const today = new Date();
    const target = new Date(date);
    const diff = target - today;
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  },

  getRelativeTime(date) {
    const now = new Date();
    const d = new Date(date);
    const seconds = Math.floor((now - d) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return this.formatDate(date);
  },
};

// String Utilities
export const stringUtils = {
  truncate(str, length = 50, ending = '...') {
    if (!str) return '';
    if (str.length <= length) return str;
    return str.substring(0, length - ending.length) + ending;
  },

  capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  },

  capitalizeWords(str) {
    if (!str) return '';
    return str.replace(/\b\w/g, (char) => char.toUpperCase());
  },

  slugify(str) {
    if (!str) return '';
    return str.toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]/g, '');
  },

  highlightText(text, query) {
    if (!query) return text;
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  },
};

// Number Utilities
export const numberUtils = {
  formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  },

  formatNumber(num) {
    return new Intl.NumberFormat('en-US').format(num);
  },

  percentageChange(oldValue, newValue) {
    if (oldValue === 0) return 0;
    return ((newValue - oldValue) / oldValue) * 100;
  },
};

// Error Handling
export const errorUtils = {
  getErrorMessage(error) {
    if (error?.response?.data?.error) {
      return error.response.data.error;
    }
    if (error?.message) {
      return error.message;
    }
    return 'An unexpected error occurred';
  },

  getErrorCode(error) {
    return error?.response?.status || 'UNKNOWN';
  },

  isNetworkError(error) {
    return error?.message === 'Network Error' || !error?.response;
  },

  isValidationError(error) {
    return error?.response?.status === 400;
  },

  isUnauthorized(error) {
    return error?.response?.status === 401;
  },

  isForbidden(error) {
    return error?.response?.status === 403;
  },

  isNotFound(error) {
    return error?.response?.status === 404;
  },
};

// Storage Utilities
export const storageUtils = {
  async set(key, value) {
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      await SecureStore.setItemAsync(key, serialized);
      return true;
    } catch (error) {
      console.error(`Error setting ${key}:`, error);
      return false;
    }
  },

  async get(key) {
    try {
      const value = await SecureStore.getItemAsync(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`Error getting ${key}:`, error);
      return null;
    }
  },

  async remove(key) {
    try {
      await SecureStore.deleteItemAsync(key);
      return true;
    } catch (error) {
      console.error(`Error removing ${key}:`, error);
      return false;
    }
  },

  async clear() {
    try {
      // Note: expo-secure-store doesn't have a clearAll method
      // You would need to track keys and delete them individually
      return true;
    } catch (error) {
      console.error('Error clearing storage:', error);
      return false;
    }
  },
};

export default {
  tokenUtils,
  userUtils,
  validationUtils,
  dateUtils,
  stringUtils,
  numberUtils,
  errorUtils,
  storageUtils,
};
