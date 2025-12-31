// API Configuration and Service
// Usage: import { api } from './api'

import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../config';

// Create axios instance with base configuration
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token
api.interceptors.request.use(
  async (config) => {
    try {
      const token = await SecureStore.getItemAsync('authToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.error('Error retrieving auth token:', error);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Token expired or invalid - clear and redirect to login
      SecureStore.deleteItemAsync('authToken');
      SecureStore.deleteItemAsync('userData');
      // In a real app, dispatch action to redirect to login
    }
    return Promise.reject(error);
  }
);

// Auth API calls
export const authAPI = {
  login: (email, password) =>
    api.post('/api/auth/login', { email, password }),

  register: (name, email, password) =>
    api.post('/api/auth/register', { name, email, password }),

  googleLogin: (idToken) =>
    api.post('/api/auth/google', { idToken }),

  logout: () =>
    api.post('/api/auth/logout'),
};

// User Profile API calls
export const profileAPI = {
  getProfile: () =>
    api.get('/api/profile'),

  updateProfile: (profileData) =>
    api.put('/api/profile', profileData),

  changePassword: (oldPassword, newPassword) =>
    api.post('/api/profile/change-password', { oldPassword, newPassword }),
};

// Applications API calls
export const applicationsAPI = {
  getAll: () =>
    api.get('/api/applications'),

  getById: (id) =>
    api.get(`/api/applications/${id}`),

  create: (applicationData) =>
    api.post('/api/applications', applicationData),

  update: (id, applicationData) =>
    api.put(`/api/applications/${id}`, applicationData),

  delete: (id) =>
    api.delete(`/api/applications/${id}`),

  getStats: () =>
    api.get('/api/dashboard/stats'),
};

// Cover Letter API calls
export const coverLetterAPI = {
  generate: (generationData) =>
    api.post('/api/generate-cover-letter', generationData),

  save: (coverLetterData) =>
    api.post('/api/save-cover-letter', coverLetterData),

  getByApplicationId: (applicationId) =>
    api.get(`/api/cover-letters/application/${applicationId}`),

  update: (id, content) =>
    api.put(`/api/cover-letters/${id}`, { content }),

  delete: (id) =>
    api.delete(`/api/cover-letters/${id}`),
};

// Dashboard API calls
export const dashboardAPI = {
  getStats: () =>
    api.get('/api/dashboard/stats'),

  getRecentApplications: (limit = 5) =>
    api.get(`/api/dashboard/recent-applications?limit=${limit}`),

  getUpcomingDeadlines: () =>
    api.get('/api/dashboard/upcoming-deadlines'),
};

export default api;
