/**
 * App Header Component for CVApplyr
 * Landing page style header with enhanced navigation
 */

(function() {
    'use strict';

    // Dynamic base URL detection
    const BASE_URL = (
        window.location.protocol === 'file:' ||
        window.location.hostname === 'localhost' || 
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname === '' ||
        window.location.hostname === '192.168.1.16'
    ) ? 'http://localhost:3000' 
      : 'https://cvapplyr.com';
    
    window.CVA_BASE_URL = BASE_URL;

    window.navigateToApp = function(path) {
        window.location.href = BASE_URL + path;
    };

    window.insertAppHeader = function(targetId = 'app-header') {
        const targetElement = document.getElementById(targetId);
        if (!targetElement) {
            console.error('App header target element not found:', targetId);
            return;
        }

        const token = localStorage.getItem('authToken');
        const userData = JSON.parse(localStorage.getItem('userData') || '{}');
        
        let authLinksHTML = '';
        if (token && userData.email) {
            // User is logged in - show enhanced navigation
            const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) : 'U';
            
            authLinksHTML = `
                        <!-- Credit Badge -->
                        <li class="nav-item credit-item">
                            <a href="/usage" class="credit-badge-nav" id="creditBadgeNav" title="View usage & credits">
                                <span class="credit-icon">💳</span>
                                <span class="credit-number" id="creditNumber">0</span>
                            </a>
                        </li>
                        
                        <!-- User Profile -->
                        <li class="nav-item user-item">
                            <div class="user-section-nav">
                                <div class="user-avatar-nav" id="userAvatarNav">${initials}</div>
                                <div class="user-details-nav">
                                    <div class="user-name-nav" id="userNameNav">${userData.fullName || 'User'}</div>
                                </div>
                            </div>
                        </li>
                        
                        <!-- Admin Button (hidden by default) -->
                        <li class="nav-item" id="adminNavItem" style="display: none;">
                            <a href="/admin-packages" class="nav-btn-landing" title="Admin Panel">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                </svg>
                            </a>
                        </li>
                        
                        <!-- Dashboard Button -->
                        <li class="nav-item">
                            <a href="/dashboard" class="nav-btn-landing" title="Dashboard">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                                </svg>
                            </a>
                        </li>
                        
                        <!-- Notifications Bell -->
                        <li class="nav-item notification-item">
                            <button class="nav-btn-landing notification-btn" id="notificationBtn" title="Notifications" onclick="window.appHeader.toggleNotifications(event)">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                                <span class="notification-badge" id="notificationBadge" style="display: none;">0</span>
                            </button>
                            <div class="notification-dropdown" id="notificationDropdown">
                                <div class="notification-dropdown-header">
                                    <h6>Notifications</h6>
                                    <button class="mark-all-read-btn" onclick="window.appHeader.markAllNotificationsRead()" title="Mark all as read">
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                                        </svg>
                                    </button>
                                </div>
                                <div class="notification-dropdown-body" id="notificationDropdownBody">
                                    <div class="notification-loading">
                                        <div class="spinner-border spinner-border-sm" role="status"></div>
                                        <span>Loading...</span>
                                    </div>
                                </div>
                                <div class="notification-dropdown-footer">
                                    <a href="/notifications" class="view-all-notifications">View All Notifications</a>
                                </div>
                            </div>
                        </li>
                        
                        <!-- Profile Button -->
                        <li class="nav-item">
                            <a href="/profile" class="nav-btn-landing" title="Profile">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                            </a>
                        </li>
                        
                        <!-- Logout Button -->
                        <li class="nav-item">
                            <button class="btn btn-logout" id="logoutBtn" onclick="window.appHeader.handleLogout()">Logout</button>
                        </li>`;
        } else {
            // User not logged in
            authLinksHTML = `
                        <li class="nav-item">
                            <a class="nav-link" href="javascript:void(0)" onclick="navigateToApp('/login')">Sign In</a>
                        </li>
                        <li>
                            <a href="javascript:void(0)" onclick="navigateToApp('/register')" class="btn btn-primary">Sign Up Free</a>
                        </li>`;
        }

        const headerHTML = `
    <!-- HEADER -->
    <header id="home">
        <!-- Navbar -->
        <nav class="navbar navbar-expand-lg" style="background: transparent !important; box-shadow: none !important;">
            <div class="container-fluid" style="padding: 0 40px !important;">
                <a class="navbar-brand" href="/">CV<span>Applyr</span></a>
                <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarNav">
                    <i class="material-icons">menu</i>
                </button>
                <div class="collapse navbar-collapse" id="navbarNav">
                    <ul class="nav navbar-nav ml-auto">
                        <li class="nav-item">
                            <a class="nav-link" href="/#home">Home</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/#why">Why CVApplyr</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/#features">Features</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/#pricing">Pricing</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/#contact">Contact</a>
                        </li>${authLinksHTML}
                    </ul>
                </div>
            </div>
        </nav>
    </header>
    
    <style>
        /* Full width navbar optimization */
        .navbar-nav {
            align-items: center;
            gap: 5px;
        }
        
        .nav-item {
            margin-left: 5px !important;
        }
        
        /* Credit Badge in Navbar */
        .credit-item {
            display: flex;
            align-items: center;
            margin-left: 8px;
        }
        
        .credit-badge-nav {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%);
            border-radius: 20px;
            text-decoration: none;
            transition: all 0.3s ease;
            box-shadow: 0 3px 10px rgba(139, 92, 246, 0.3);
        }
        
        .credit-badge-nav:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(139, 92, 246, 0.4);
            text-decoration: none;
        }
        
        .credit-icon {
            font-size: 16px;
        }
        
        .credit-number {
            font-size: 14px;
            font-weight: 700;
            color: white;
            min-width: 20px;
            text-align: center;
        }
        
        /* User Section in Navbar */
        .user-item {
            display: flex;
            align-items: center;
            margin-left: 8px;
        }
        
        .user-section-nav {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 12px;
            background: rgba(255, 255, 255, 0.15);
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        
        .user-avatar-nav {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            font-size: 0.7rem;
        }
        
        .user-details-nav {
            display: flex;
            flex-direction: column;
        }
        
        .user-name-nav {
            font-size: 0.75rem;
            font-weight: 600;
            color: white;
            line-height: 1.2;
        }
        
        /* Notifications */
        .notification-item {
            position: relative;
            display: flex;
            align-items: center;
        }
        
        .notification-btn {
            position: relative;
            border: none;
            background: transparent;
            cursor: pointer;
            padding: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
        }
        
        .notification-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 8px;
        }
        
        .notification-btn:focus {
            outline: none;
        }
        
        .notification-btn svg {
            width: 20px;
            height: 20px;
            stroke: white;
        }
        
        .notification-badge {
            position: absolute;
            top: -4px;
            right: -4px;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
            font-size: 10px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 10px;
            min-width: 18px;
            height: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 6px rgba(239, 68, 68, 0.4);
        }
        
        .notification-dropdown {
            position: absolute;
            top: calc(100% + 12px);
            right: 0;
            width: 360px;
            max-width: 90vw;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            display: none;
            z-index: 1000;
            animation: slideDown 0.3s ease-out;
        }
        
        .notification-dropdown.show {
            display: block;
        }
        
        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .notification-dropdown-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px;
            border-bottom: 1px solid #e5e7eb;
        }
        
        .notification-dropdown-header h6 {
            margin: 0;
            font-size: 14px;
            font-weight: 700;
            color: #1f2937;
        }
        
        .mark-all-read-btn {
            background: none;
            border: none;
            color: #667eea;
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            transition: all 0.2s;
        }
        
        .mark-all-read-btn:hover {
            background: #f3f4f6;
        }
        
        .mark-all-read-btn svg {
            width: 18px;
            height: 18px;
        }
        
        .notification-dropdown-body {
            max-height: 400px;
            overflow-y: auto;
        }
        
        .notification-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            padding: 32px;
            color: #6b7280;
            font-size: 14px;
        }
        
        .notification-empty {
            text-align: center;
            padding: 32px;
            color: #9ca3af;
        }
        
        .notification-empty svg {
            width: 48px;
            height: 48px;
            margin: 0 auto 12px;
            opacity: 0.5;
        }
        
        .notification-empty p {
            margin: 0;
            font-size: 14px;
        }
        
        .notification-item-card {
            padding: 12px 16px;
            border-bottom: 1px solid #f3f4f6;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            gap: 12px;
        }
        
        .notification-item-card:hover {
            background: #f9fafb;
        }
        
        .notification-item-card.unread {
            background: #eff6ff;
        }
        
        .notification-item-card.unread:hover {
            background: #dbeafe;
        }
        
        .notification-icon-wrapper {
            flex-shrink: 0;
            width: 36px;
            height: 36px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
        }
        
        .notification-icon-wrapper.email {
            background: #dbeafe;
            color: #3b82f6;
        }
        
        .notification-icon-wrapper.cover_letter {
            background: #d1fae5;
            color: #10b981;
        }
        
        .notification-icon-wrapper.credits {
            background: #fed7aa;
            color: #f97316;
        }
        
        .notification-icon-wrapper.profile {
            background: #e9d5ff;
            color: #a855f7;
        }
        
        .notification-content {
            flex: 1;
            min-width: 0;
        }
        
        .notification-title {
            font-size: 13px;
            font-weight: 600;
            color: #1f2937;
            margin: 0 0 4px 0;
            line-height: 1.3;
        }
        
        .notification-message {
            font-size: 12px;
            color: #6b7280;
            margin: 0;
            line-height: 1.4;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .notification-time {
            font-size: 11px;
            color: #9ca3af;
            margin-top: 4px;
        }
        
        .notification-dropdown-footer {
            padding: 12px;
            border-top: 1px solid #e5e7eb;
            text-align: center;
        }
        
        .view-all-notifications {
            display: block;
            color: #667eea;
            font-size: 13px;
            font-weight: 600;
            text-decoration: none;
            padding: 4px;
            border-radius: 6px;
            transition: all 0.2s;
        }
        
        .view-all-notifications:hover {
            background: #f3f4f6;
            text-decoration: none;
            color: #5568d3;
        }
        
        /* Navigation Buttons */
        .nav-btn-landing {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(10px);
            transition: all 0.2s ease;
            text-decoration: none;
            color: white;
            margin-left: 6px;
        }
        
        .nav-btn-landing:hover {
            background: rgba(255, 255, 255, 0.25);
            transform: translateY(-2px);
            text-decoration: none;
            color: white;
        }
        
        .nav-btn-landing svg {
            width: 18px;
            height: 18px;
        }
        
        /* Logout Button */
        .btn-logout {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 8px 16px;
            background: rgba(220, 38, 38, 0.15);
            border: 1px solid rgba(254, 202, 202, 0.5);
            border-radius: 20px;
            font-size: 0.75rem;
            color: white;
            cursor: pointer;
            transition: all 0.2s ease;
            font-weight: 500;
            margin-left: 8px;
            height: 36px;
            position: relative;
            top: 0 !important;
        }
        
        .btn-logout:hover {
            background: rgba(220, 38, 38, 0.25);
            border-color: rgba(254, 202, 202, 0.8);
        }
        
        /* Mobile Responsive */
        @media (max-width: 991px) {
            .credit-item,
            .user-item,
            .notification-item,
            .nav-btn-landing,
            .btn-logout {
                margin-left: 0;
                margin-top: 10px;
            }
            
            .credit-badge-nav,
            .user-section-nav,
            .nav-btn-landing {
                width: 100%;
                justify-content: center;
            }
            
            .btn-logout {
                width: 100%;
            }
            
            .notification-dropdown {
                position: fixed;
                top: auto;
                right: 10px;
                left: 10px;
                width: auto;
                max-width: none;
            }
        }
    </style>
        `;
        
        targetElement.innerHTML = headerHTML;
        
        // Load user data and credits
        if (token && userData.email) {
            window.appHeader.loadCredits();
            window.appHeader.checkAdminStatus();
            window.appHeader.loadNotifications();
            
            // Refresh notifications every 30 seconds
            setInterval(() => {
                window.appHeader.loadNotifications();
            }, 30000);
            
            // Close dropdown when clicking outside
            document.addEventListener('click', function(e) {
                const dropdown = document.getElementById('notificationDropdown');
                const btn = document.getElementById('notificationBtn');
                if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
                    dropdown.classList.remove('show');
                }
            });
        }
    };

    // App Header Object with helper functions
    window.appHeader = {
        loadCredits: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                const response = await fetch('/api/user/credits', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.success) {
                        const credits = data.balance || (data.credits && typeof data.credits === 'object' ? data.credits.remaining : data.credits) || 0;
                        const creditNumber = document.getElementById('creditNumber');
                        if (creditNumber) {
                            creditNumber.textContent = credits;
                        }
                    }
                }
            } catch (error) {
                console.error('Error loading credits:', error);
            }
        },

        checkAdminStatus: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                const response = await fetch('/api/user/is-admin', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.isAdmin) {
                        const adminNavItem = document.getElementById('adminNavItem');
                        if (adminNavItem) {
                            adminNavItem.style.display = 'flex';
                        }
                    }
                }
            } catch (error) {
                console.error('Error checking admin status:', error);
            }
        },

        handleLogout: function() {
            localStorage.removeItem('authToken');
            localStorage.removeItem('userData');
            sessionStorage.clear();
            window.location.href = '/login';
        },

        loadNotifications: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                const response = await fetch('/api/notifications?limit=5', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.success) {
                        window.appHeader.updateNotificationBadge(data.unreadCount || 0);
                        window.appHeader.renderNotifications(data.notifications || []);
                    }
                }
            } catch (error) {
                console.error('Error loading notifications:', error);
            }
        },

        updateNotificationBadge: function(count) {
            const badge = document.getElementById('notificationBadge');
            if (badge) {
                if (count > 0) {
                    badge.textContent = count > 99 ? '99+' : count;
                    badge.style.display = 'flex';
                } else {
                    badge.style.display = 'none';
                }
            }
        },

        renderNotifications: function(notifications) {
            const body = document.getElementById('notificationDropdownBody');
            if (!body) return;

            if (notifications.length === 0) {
                body.innerHTML = `
                    <div class="notification-empty">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                        </svg>
                        <p>No notifications yet</p>
                    </div>
                `;
                return;
            }

            const notificationIcons = {
                email: '📧',
                cover_letter: '📄',
                credits: '💳',
                profile: '👤'
            };

            const html = notifications.map(notif => {
                const timeAgo = window.appHeader.getTimeAgo(notif.created_at);
                const unreadClass = notif.is_read ? '' : 'unread';
                const icon = notificationIcons[notif.type] || '🔔';
                
                return `
                    <div class="notification-item-card ${unreadClass}" onclick="window.appHeader.handleNotificationClick(${notif.id})">
                        <div class="notification-icon-wrapper ${notif.type}">
                            ${icon}
                        </div>
                        <div class="notification-content">
                            <p class="notification-title">${notif.title}</p>
                            <p class="notification-message">${notif.message}</p>
                            <div class="notification-time">${timeAgo}</div>
                        </div>
                    </div>
                `;
            }).join('');

            body.innerHTML = html;
        },

        getTimeAgo: function(timestamp) {
            const now = new Date();
            const then = new Date(timestamp);
            const seconds = Math.floor((now - then) / 1000);
            
            if (seconds < 60) return 'Just now';
            if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
            if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
            if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
            return then.toLocaleDateString();
        },

        toggleNotifications: function(event) {
            event.stopPropagation();
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown) {
                dropdown.classList.toggle('show');
                if (dropdown.classList.contains('show')) {
                    window.appHeader.loadNotifications();
                }
            }
        },

        handleNotificationClick: async function(notificationId) {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                // Mark as read
                await fetch(`/api/notifications/${notificationId}/read`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                // Reload notifications
                await window.appHeader.loadNotifications();
                
                // Navigate to notifications page
                window.location.href = '/notifications';
            } catch (error) {
                console.error('Error marking notification as read:', error);
            }
        },

        markAllNotificationsRead: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                const response = await fetch('/api/notifications/mark-all-read', {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    await window.appHeader.loadNotifications();
                }
            } catch (error) {
                console.error('Error marking all as read:', error);
            }
        }
    };

    // Auto-insert header when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            const autoInsert = document.getElementById('app-header');
            if (autoInsert) {
                window.insertAppHeader();
            }
        });
    } else {
        const autoInsert = document.getElementById('app-header');
        if (autoInsert) {
            window.insertAppHeader();
        }
    }
})();
