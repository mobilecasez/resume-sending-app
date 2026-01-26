// Common Header Component
(function() {
    'use strict';

    // Header HTML template
    const headerHTML = `
        <nav class="top-navbar">
            <div class="navbar-left">
                <a href="/" class="navbar-brand">
                    <img src="/icon_light_background.png" alt="CVApplyr" style="height: 45px;">
                </a>
            </div>
            
            <div class="navbar-right">
                <!-- Credit Badge -->
                <a href="/usage" class="credit-badge" id="creditBadge" title="View usage & credits">
                    <span class="credit-icon">💳</span>
                    <span class="credit-number" id="creditBadgeNumber">0</span>
                </a>
                
                <div class="user-section">
                    <div class="user-avatar" id="userAvatar"></div>
                    <div class="user-details">
                        <div class="user-name" id="userName"></div>
                        <div class="user-email" id="userEmail"></div>
                    </div>
                </div>
                
                <div class="nav-actions">
                    <button class="nav-btn" id="adminBtn" onclick="window.location.href='/admin-packages'" title="Admin Panel" style="display: none;">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                        </svg>
                    </button>
                    <a href="/" class="nav-btn" title="Dashboard">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                        </svg>
                    </a>
                    <a href="/profile" class="nav-btn" title="Profile">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                    </a>
                </div>
                
                <button class="logout-btn" onclick="handleLogout()">Logout</button>
            </div>
        </nav>
    `;

    // Common header styles
    const headerStyles = `
        <style id="common-header-styles">
            .top-navbar {
                background: white;
                padding: 12px 24px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                display: flex;
                justify-content: space-between;
                align-items: center;
                position: sticky;
                top: 0;
                z-index: 100;
            }

            .navbar-left {
                display: flex;
                align-items: center;
                gap: 16px;
            }

            .navbar-brand {
                display: flex;
                align-items: center;
                gap: 10px;
                text-decoration: none;
            }

            .navbar-brand h1 {
                color: var(--primary-color);
                font-size: 1.25rem;
                font-weight: 700;
                margin: 0;
            }

            .navbar-right {
                display: flex;
                align-items: center;
                gap: 16px;
            }

            .credit-badge {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 16px;
                background: linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%);
                border-radius: 12px;
                text-decoration: none;
                transition: all 0.3s ease;
                box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
                cursor: pointer;
            }

            .credit-badge:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 16px rgba(139, 92, 246, 0.4);
            }

            .credit-icon {
                font-size: 20px;
            }

            .credit-number {
                font-size: 18px;
                font-weight: 700;
                color: white;
                min-width: 24px;
                text-align: center;
            }

            .user-section {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 6px 12px;
                background: #f8f9fa;
                border-radius: 8px;
            }

            .nav-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .nav-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 36px;
                height: 36px;
                border-radius: 8px;
                background: #f8f9fa;
                border: 1px solid #e2e8f0;
                cursor: pointer;
                transition: all 0.2s ease;
                text-decoration: none;
                color: #555;
            }

            .nav-btn:hover {
                background: var(--primary-color, #1e40af);
                border-color: var(--primary-color, #1e40af);
                color: white;
            }

            .nav-btn svg {
                width: 18px;
                height: 18px;
            }

            .user-avatar {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%);
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-weight: 600;
                font-size: 0.75rem;
            }

            .user-details {
                display: flex;
                flex-direction: column;
            }

            .user-name {
                font-size: 0.8125rem;
                font-weight: 600;
                color: var(--text-primary, #0f172a);
                line-height: 1.2;
            }

            .user-email {
                font-size: 0.6875rem;
                color: var(--text-secondary, #475569);
            }

            .logout-btn {
                padding: 8px 14px;
                background: transparent;
                border: 1px solid #fecaca;
                border-radius: 6px;
                font-size: 0.75rem;
                color: #dc2626;
                cursor: pointer;
                transition: all 0.2s ease;
                font-weight: 500;
            }

            .logout-btn:hover {
                background: #fee2e2;
                border-color: #dc2626;
            }

            @media (max-width: 768px) {
                .top-navbar {
                    padding: 10px 16px;
                }

                .user-details {
                    display: none;
                }

                .navbar-brand h1 {
                    font-size: 1rem;
                }
            }
        </style>
    `;

    // Common Header Object
    window.commonHeader = {
        // Initialize header
        init: function() {
            // Inject styles if not already present
            if (!document.getElementById('common-header-styles')) {
                document.head.insertAdjacentHTML('beforeend', headerStyles);
            }

            // Inject header HTML at the beginning of body
            document.body.insertAdjacentHTML('afterbegin', headerHTML);

            // Load user info
            this.loadUserInfo();

            // Check admin status
            this.checkAdminStatus();

            // Load credits only if the page doesn't have its own credit loading
            // (to avoid conflicts with dashboard)
            if (!window.dashboardPage) {
                this.loadCredits();
            }
        },

        // Load user information
        loadUserInfo: function() {
            const userData = JSON.parse(localStorage.getItem('userData') || '{}');
            if (userData.fullName) {
                const userNameEl = document.getElementById('userName');
                const userEmailEl = document.getElementById('userEmail');
                const userAvatarEl = document.getElementById('userAvatar');

                if (userNameEl) userNameEl.textContent = userData.fullName;
                if (userEmailEl) userEmailEl.textContent = userData.email;
                
                // Set avatar initials
                const initials = userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
                if (userAvatarEl) userAvatarEl.textContent = initials;
            }
        },

        // Check if user is admin
        checkAdminStatus: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                const response = await fetch('/api/user/is-admin', {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });
                
                if (!response.ok) return;
                
                const data = await response.json();
                if (data.isAdmin) {
                    const adminBtn = document.getElementById('adminBtn');
                    if (adminBtn) {
                        adminBtn.style.display = 'flex';
                    }
                }
            } catch (error) {
                console.error('Error checking admin status:', error);
            }
        },

        // Load credits
        loadCredits: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            try {
                const response = await fetch('/api/users/credits', {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });
                
                if (!response.ok) {
                    console.log('Credits endpoint not available');
                    return;
                }
                
                const data = await response.json();
                if (data.success) {
                    const creditBadgeNumber = document.getElementById('creditBadgeNumber');
                    if (creditBadgeNumber) {
                        creditBadgeNumber.textContent = data.credits || 0;
                    }
                }
            } catch (error) {
                console.error('Error loading credits:', error);
            }
        },

        // Update credits display (can be called from pages)
        updateCredits: function(credits) {
            const creditBadgeNumber = document.getElementById('creditBadgeNumber');
            if (creditBadgeNumber) {
                creditBadgeNumber.textContent = credits || 0;
            }
        },

        // Handle logout
        handleLogout: function() {
            localStorage.removeItem('authToken');
            localStorage.removeItem('userData');
            sessionStorage.clear();
            window.location.href = '/login';
        }
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            commonHeader.init();
        });
    } else {
        // DOM is already ready
        commonHeader.init();
    }
})();
