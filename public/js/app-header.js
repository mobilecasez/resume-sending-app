/**
 * App Header Component for CVApplyr
 * Dynamically renders the new sleek navigation with auth states
 */

(function() {
    'use strict';

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
        window.location.href = path; // Native relative routing
    };

    window.insertAppHeader = function(targetId = 'app-header') {
        const targetElement = document.getElementById(targetId);
        if (!targetElement) return;

        const token = localStorage.getItem('authToken');
        const userData = JSON.parse(localStorage.getItem('userData') || '{}');
        
        let authLinksDesktop = '';
        let authLinksMobile = '';
        let appNavLinks = '';   // items inside the Apps dropdown (logged-in only)

        if (token && userData.email) {
            appNavLinks = `
                <a href="/dashboard" class="hdr-apps-item"><span>📝</span> Letters</a>
                <a href="/job-hub" class="hdr-apps-item"><span>🧭</span> AI Job Hub</a>
                <a href="/resume-builder" class="hdr-apps-item"><span>📄</span> Resume Builder</a>
                <div id="appsAdminSection" style="display:none;">
                    <div style="height:1px;background:rgba(255,255,255,0.12);margin:6px 8px;"></div>
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);padding:4px 12px 2px;">Admin</div>
                    <a href="/admin-packages" class="hdr-apps-item"><span>🎁</span> Packages</a>
                    <a href="/admin-ai-event-costs" class="hdr-apps-item"><span>💳</span> AI Event Costs</a>
                    <a href="/admin-users" class="hdr-apps-item"><span>👤</span> User Credits</a>
                    <a href="/admin-employer-requests" class="hdr-apps-item"><span>🛠️</span> Employer Fixes</a>
                    <a href="/admin-store-analytics" class="hdr-apps-item"><span>📊</span> Store Analytics</a>
                    <a href="/admin-user-analytics" class="hdr-apps-item"><span>🧭</span> User Analytics</a>
                    <a href="/admin-segments" class="hdr-apps-item"><span>🎯</span> Segments</a>
                    <a href="/admin-registered-users" class="hdr-apps-item"><span>🧑‍💻</span> Registered Users</a>
                    <a href="/admin-routines" class="hdr-apps-item"><span>⏱️</span> Routines</a>
                </div>
            `;
            const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) : 'U';
            
            // Generate avatar HTML - use image if available, else initials
            const avatarSrc = userData.photoPath
                ? (userData.photoPath.startsWith('http://') || userData.photoPath.startsWith('https://')
                    ? userData.photoPath
                    : `/${userData.photoPath.replace(/^[\/\\]/, '')}`)
                : null;
            const avatarHtml = avatarSrc
                ? `<img src="${avatarSrc}" alt="Profile" class="hdr-avatar" id="userAvatarNav" style="object-fit: cover;">`
                : `<div class="hdr-avatar" id="userAvatarNav">${initials}</div>`;
            
            // Logged in state
            authLinksDesktop = `
                <!-- Credit Badge -->
                <a href="/usage" class="hdr-credit-badge" id="creditBadgeNav" title="View usage & credits">
                    <span>💳</span>
                    <span id="creditNumber">--</span>
                </a>

                <!-- Admin Button -->
                <a href="/admin-packages" class="hdr-icon-btn" id="adminNavItem" style="display:none;" title="Admin Panel">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                </a>

                <!-- Dashboard -->
                <a href="/dashboard" class="hdr-icon-btn" title="Dashboard">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                </a>

                <!-- Notifications -->
                <div style="position:relative;">
                    <button class="hdr-icon-btn" id="notificationBtn" title="Notifications" onclick="window.appHeader.toggleNotifications(event)">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                        <span class="hdr-notif-dot" id="notificationBadge" style="display:none;">0</span>
                    </button>
                    <!-- Dropdown structure -->
                    <div class="hdr-notif-dropdown" id="notificationDropdown">
                        <div class="hdr-notif-header">
                            <h6>Notifications</h6>
                            <button class="hdr-mark-read" onclick="window.appHeader.markAllNotificationsRead()" title="Mark all read"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></button>
                        </div>
                        <div class="hdr-notif-body" id="notificationDropdownBody">
                            <div class="hdr-notif-empty">Loading...</div>
                        </div>
                        <div class="hdr-notif-footer">
                            <a href="/notifications" class="hdr-notif-all">View All Notifications</a>
                        </div>
                    </div>
                </div>

                <!-- Apps menu (Letters / AI Job Hub / Resume Builder) -->
                <div style="position:relative;">
                    <button class="hdr-icon-btn" id="appsBtn" title="Menu" onclick="window.appHeader.toggleApps(event)">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h6v6H4V5zM14 5h6v6h-6V5zM4 15h6v6H4v-6zM14 15h6v6h-6v-6z"/></svg>
                    </button>
                    <div class="hdr-apps-dropdown" id="appsDropdown">
                        ${appNavLinks}
                    </div>
                </div>

                <!-- Profile -->
                <a href="/profile" class="hdr-icon-btn hdr-profile-link" title="Profile Section" style="padding: 0; background: transparent; border-radius: 50%;">
                    ${avatarHtml}
                </a>

                <!-- Logout -->
                <button class="hdr-logout-btn" id="logoutBtn" onclick="window.appHeader.handleLogout()">Logout</button>
            `;
            
            authLinksMobile = `
                <a href="/dashboard" class="mobile-nav-link">Dashboard</a>
                <a href="/job-hub" class="mobile-nav-link">🧭 AI Job Hub</a>
                <a href="/resume-builder" class="mobile-nav-link">📄 Resume Builder</a>
                <a href="/profile" class="mobile-nav-link">Profile</a>
                <a href="/usage" class="mobile-nav-link">💳 Credits (<span id="mobileCredits">...</span>)</a>
                <a href="/notifications" class="mobile-nav-link">🔔 Notifications</a>
                <div id="mobileAdminSection" style="display:none;">
                    <a href="/admin-packages" class="mobile-nav-link">🎁 Admin · Packages</a>
                    <a href="/admin-ai-event-costs" class="mobile-nav-link">💳 Admin · AI Event Costs</a>
                    <a href="/admin-users" class="mobile-nav-link">👤 Admin · User Credits</a>
                    <a href="/admin-employer-requests" class="mobile-nav-link">🛠️ Admin · Employer Fixes</a>
                    <a href="/admin-store-analytics" class="mobile-nav-link">📊 Admin · Store Analytics</a>
                    <a href="/admin-user-analytics" class="mobile-nav-link">🧭 Admin · User Analytics</a>
                    <a href="/admin-segments" class="mobile-nav-link">🎯 Admin · Segments</a>
                    <a href="/admin-registered-users" class="mobile-nav-link">🧑‍💻 Admin · Registered Users</a>
                    <a href="/admin-routines" class="mobile-nav-link">⏱️ Admin · Routines</a>
                </div>
                <button class="mobile-auth-btn hdr-mobile-logout" onclick="window.appHeader.handleLogout()">Logout</button>
            `;
        } else {
            // Logged out state
            authLinksDesktop = `
                <a href="/login" class="btn btn-ghost">Sign In</a>
                <a href="/register" class="btn btn-primary">Free trial <span class="arrow">→</span></a>
            `;
            authLinksMobile = `
                <div class="mobile-cta">
                    <a href="/login" class="btn btn-ghost">Sign in</a>
                    <a href="/register" class="btn btn-primary">Free trial</a>
                </div>
            `;
        }

        const navStyle = `
<style>
/* New Sleek Navigation CSS overrides */
.nav {
    position: fixed; top: 0; left: 0; right: 0;
    z-index: 1000;
    padding: 14px 40px;
    background: rgba(22, 29, 51, 0.72);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    border-bottom: 1px solid rgba(255,255,255,0.07);
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, sans-serif;
}
.nav-inner {
    max-width: 1280px; margin: 0 auto;
    display: flex; align-items: center; justify-content: space-between; gap: 24px;
}
.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
.brand-icon {
    width: 30px; height: 30px;
    background-image: url('/assets/logo_img.png');
    background-size: contain; background-repeat: no-repeat; background-position: center;
    filter: brightness(0) invert(1);
}
.brand-text { font-size: 19px; font-weight: 700; letter-spacing: -0.025em; line-height: 1; }
.brand-text .cv { color: #ECEFF7; }
.brand-text .applyr { color: #3B82F6; }

.nav-links { display: flex; gap: 2px; flex: 1; justify-content: center; margin-left: 48px; }
.nav-links a {
    font-size: 14px; font-weight: 500; color: #A6AEC4; padding: 9px 16px;
    border-radius: 8px; transition: all 0.2s; text-decoration: none;
}
.nav-links a:hover { color: #ECEFF7; background: rgba(255,255,255,0.05); text-decoration: none; }

/* Apps dropdown (Letters / AI Job Hub / Resume Builder) */
.hdr-apps-dropdown {
    position: absolute; top: calc(100% + 10px); right: 0; min-width: 210px;
    background: #1E2747; border: 1px solid rgba(255,255,255,0.15); border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: none; z-index: 1001; overflow: hidden; padding: 6px;
}
.hdr-apps-dropdown.show { display: block; }
.hdr-apps-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;
    color: #ECEFF7; font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap;
}
.hdr-apps-item span { font-size: 16px; line-height: 1; }
.hdr-apps-item:hover { background: rgba(79,141,255,0.16); color: #fff; text-decoration: none; }

.nav-cta { display: flex; gap: 10px; align-items: center; }

/* Buttons */
.btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 9px 18px; border-radius: 10px; font-size: 13.5px; font-weight: 600;
    transition: all 0.2s; cursor: pointer; text-decoration: none; border: none; font-family: inherit;
}
.btn-ghost { color: #ECEFF7; background: transparent; }
.btn-ghost:hover { background: rgba(255,255,255,0.08); color: #fff; }
.btn-primary {
    background: #3B82F6; color: #fff;
    box-shadow: 0 4px 14px rgba(59,130,246,0.3), inset 0 1px 0 rgba(255,255,255,0.2);
}
.btn-primary:hover { background: #2563EB; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(59,130,246,0.4); color: #fff; }

/* Auth States */
.hdr-icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; border-radius: 8px; background: rgba(255,255,255,0.08);
    border: none; color: #ECEFF7; cursor: pointer; transition: background 0.15s, transform 0.15s;
    flex-shrink: 0; text-decoration: none;
}
.hdr-icon-btn:hover { background: rgba(255,255,255,0.15); transform: translateY(-1px); color: #fff; }
.hdr-icon-btn svg { width: 18px; height: 18px; }

.hdr-credit-badge {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px;
    background: linear-gradient(135deg, #8B5CF6, #7C3AED); border-radius: 20px;
    font-size: 13px; font-weight: 700; color: #fff; text-decoration: none;
    box-shadow: 0 3px 10px rgba(139,92,246,0.3); transition: transform 0.15s;
    margin-right: 6px;
}
.hdr-credit-badge:hover { transform: translateY(-1px); color: #fff; }

.hdr-avatar {
    width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center; color: #fff; font-size: 14px; font-weight: 700;
}

.hdr-notif-dot {
    position: absolute; top: -3px; right: -3px; background: #ef4444; color: #fff;
    font-size: 10px; font-weight: 700; min-width: 17px; height: 17px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(239,68,68,0.4);
}

.hdr-logout-btn {
    padding: 7px 14px; font-size: 13px; font-weight: 500; background: rgba(220,38,38,0.12);
    border: 1px solid rgba(254,202,202,0.25); border-radius: 8px; color: #fca5a5; cursor: pointer;
    transition: background 0.15s; margin-left: 6px;
}
.hdr-logout-btn:hover { background: rgba(220,38,38,0.22); color: #fca5a5; }

/* Notification Dropdown */
.hdr-notif-dropdown {
    position: absolute; top: calc(100% + 10px); right: 0; width: 340px; max-width: 90vw;
    background: #1E2747; border: 1px solid rgba(255,255,255,0.15); border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: none; z-index: 1001; overflow: hidden;
}
.hdr-notif-dropdown.show { display: block; }
.hdr-notif-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.07); }
.hdr-notif-header h6 { margin: 0; font-size: 13px; font-weight: 700; color: #ECEFF7; }
.hdr-mark-read { background: none; border: none; color: #60A5FA; cursor: pointer; padding: 4px; border-radius: 6px; }
.hdr-mark-read:hover { background: rgba(255,255,255,0.08); }
.hdr-notif-body { max-height: 320px; overflow-y: auto; }
.hdr-notif-empty { padding: 28px; text-align: center; color: #757D98; font-size: 13px; }
.hdr-notif-card { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
.hdr-notif-card:hover { background: rgba(255,255,255,0.04); }
.hdr-notif-card.unread { background: rgba(59,130,246,0.07); }
.hdr-notif-icon { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
.hdr-notif-content { flex: 1; min-width: 0; }
.hdr-notif-title { font-size: 13px; font-weight: 600; color: #ECEFF7; margin: 0 0 3px; }
.hdr-notif-msg { font-size: 12px; color: #A6AEC4; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hdr-notif-time { font-size: 11px; color: #757D98; margin-top: 3px; }
.hdr-notif-footer { padding: 10px 16px; border-top: 1px solid rgba(255,255,255,0.07); text-align: center; }
.hdr-notif-all { font-size: 13px; font-weight: 600; color: #60A5FA; text-decoration: none; }

/* Mobile Menu */
.menu-btn {
    display: none; width: 40px; height: 40px; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; cursor: pointer;
    align-items: center; justify-content: center; padding: 0;
}
.menu-btn-icon {
    display: block; position: relative; width: 16px; height: 2px; background: #ECEFF7; border-radius: 2px;
}
.menu-btn-icon::before, .menu-btn-icon::after {
    content: ''; position: absolute; left: 0; width: 100%; height: 2px; background: #ECEFF7; border-radius: 2px;
}
.menu-btn-icon::before { top: -6px; }
.menu-btn-icon::after { top: 6px; }

.mobile-menu {
    position: fixed; top: 70px; left: 12px; right: 12px; z-index: 999;
    background: rgba(22, 29, 51, 0.95); backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 14px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5); transform: translateY(-12px); opacity: 0; pointer-events: none;
    transition: all 0.25s ease;
}
.mobile-menu.open { transform: translateY(0); opacity: 1; pointer-events: auto; }
.mobile-nav-link, .mobile-menu > a {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 14px; font-size: 15px; font-weight: 500; color: #ECEFF7;
    border-radius: 10px; text-decoration: none; border-bottom: 1px solid rgba(255,255,255,0.05);
}
.mobile-nav-link:hover, .mobile-menu > a:hover { background: rgba(255,255,255,0.05); text-decoration: none; color: #fff; }
.mobile-menu .mobile-cta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.07); }
.mobile-menu .mobile-cta a { justify-content: center; text-decoration: none; }
.mobile-auth-btn { width: 100%; display: flex; align-items: center; padding: 14px; font-size: 15px; font-weight: 500; background: none; border: none; color: #ECEFF7; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; text-align: left; }
.hdr-mobile-logout { color: #fca5a5 !important; border-bottom: none !important; }

@media (max-width: 1024px) {
    .nav-links { display: none; }
    .menu-btn { display: flex; }
    .nav-cta .btn-ghost { display: none; }
}
@media (max-width: 768px) {
    .nav-cta { display: none; }
}
</style>
        `;

        document.head.insertAdjacentHTML('beforeend', navStyle);

        const headerHTML = `
            <header class="nav">
                <div class="nav-inner">
                    <a href="/index.html" class="brand">
                        <span class="brand-icon"></span>
                        <span class="brand-text"><span class="cv">CV</span><span class="applyr">Applyr</span></span>
                    </a>
                    <div class="nav-links">
                        <a href="/index.html">Home</a>
                        <a href="/index.html#why">Why CVApplyr</a>
                        <a href="/index.html#features">Features</a>
                        <a href="/index.html#pricing">Pricing</a>
                        <a href="/index.html#contact">Contact</a>
                        <a href="/index.html#download" class="nav-dl-link" title="Download the CVApplyr app" style="display:inline-flex;align-items:center;gap:6px;color:#fff;background:linear-gradient(135deg,#4F8DFF,#7C6BFF);padding:7px 16px;border-radius:9px;font-weight:700;box-shadow:0 4px 14px rgba(79,141,255,0.30);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
                            Download
                        </a>
                    </div>
                    <div class="nav-cta">
                        ${authLinksDesktop}
                    </div>
                    <button class="menu-btn" id="menuBtn">
                        <span class="menu-btn-icon"></span>
                    </button>
                </div>
            </header>

            <div class="mobile-menu" id="mobileMenu">
                <a href="/index.html" class="mobile-nav-link">Home</a>
                <a href="/index.html#why" class="mobile-nav-link">Why CVApplyr</a>
                <a href="/index.html#features" class="mobile-nav-link">Features</a>
                <a href="/index.html#pricing" class="mobile-nav-link">Pricing</a>
                <a href="/index.html#contact" class="mobile-nav-link">Contact</a>
                <a href="/index.html#download" class="mobile-nav-link" style="color:#fff;background:linear-gradient(135deg,#4F8DFF,#7C6BFF);font-weight:700;">⬇ Download the app</a>
                ${authLinksMobile}
            </div>
        `;

        targetElement.innerHTML = headerHTML;

        // Hook up menu interactions
        setTimeout(() => {
            const menuBtn = document.getElementById('menuBtn');
            const mobileMenu = document.getElementById('mobileMenu');
            
            if (menuBtn && mobileMenu) {
                menuBtn.addEventListener('click', () => {
                    menuBtn.classList.toggle('open');
                    mobileMenu.classList.toggle('open');
                });
                
                // Close menu when a link is clicked
                mobileMenu.querySelectorAll('a').forEach(a => {
                    a.addEventListener('click', () => {
                        menuBtn.classList.remove('open');
                        mobileMenu.classList.remove('open');
                    });
                });
            }
            
            // Only fetch dynamically if user is logged in
            if (token) {
                window.appHeader.checkAdminStatus();
                window.appHeader.fetchCredits();
                window.appHeader.fetchNotifications();
            }
        }, 0);
    };

    // Make global methods for auth interactions
    window.appHeader = {
        handleLogout: function() {
            localStorage.removeItem('authToken');
            localStorage.removeItem('userData');
            window.location.href = '/login';
        },
        toggleNotifications: function(e) {
            if (e) e.stopPropagation();
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown) dropdown.classList.toggle('show');

            // Close when clicking outside
            document.addEventListener('click', function closeNotif(e) {
                if (!e.target.closest('#notificationDropdown') && !e.target.closest('#notificationBtn')) {
                    dropdown.classList.remove('show');
                    document.removeEventListener('click', closeNotif);
                }
            });
        },
        toggleApps: function(e) {
            if (e) e.stopPropagation();
            const dropdown = document.getElementById('appsDropdown');
            if (dropdown) dropdown.classList.toggle('show');
            document.addEventListener('click', function closeApps(e) {
                if (!e.target.closest('#appsDropdown') && !e.target.closest('#appsBtn')) {
                    dropdown.classList.remove('show');
                    document.removeEventListener('click', closeApps);
                }
            });
        },
        async checkAdminStatus() {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return;
                
                const response = await fetch('/api/user/is-admin', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await response.json();
                if (data.isAdmin) {
                    const adminNavItem = document.getElementById('adminNavItem');
                    if (adminNavItem) adminNavItem.style.display = 'inline-flex';
                    const appsAdminSection = document.getElementById('appsAdminSection');
                    if (appsAdminSection) appsAdminSection.style.display = 'block';
                    const mobileAdminSection = document.getElementById('mobileAdminSection');
                    if (mobileAdminSection) mobileAdminSection.style.display = 'block';
                }
            } catch (err) {
                console.error('Error checking admin status', err);
            }
        },
        async fetchCredits() {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return;
                
                const response = await fetch('/api/user/credits', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    const credits = data.balance || 0;
                    
                    const badge = document.getElementById('creditNumber');
                    if (badge) badge.textContent = credits;
                    
                    const mobileBadge = document.getElementById('mobileCredits');
                    if (mobileBadge) mobileBadge.textContent = credits;
                }
            } catch (err) {
                console.error('Error fetching credits', err);
            }
        },
        async fetchNotifications() {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return;
                
                const response = await fetch('/api/notifications', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    window.appHeader.updateNotificationsUI(data.notifications || [], data.unreadCount || 0);
                }
            } catch (err) {
                console.error('Error fetching notifications', err);
            }
        },
        updateNotificationsUI(notifications, unreadCount) {
            const badge = document.getElementById('notificationBadge');
            const body = document.getElementById('notificationDropdownBody');
            
            if (badge) {
                if (unreadCount > 0) {
                    badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
                    badge.style.display = 'flex';
                } else {
                    badge.style.display = 'none';
                }
            }
            
            if (body) {
                if (notifications.length === 0) {
                    body.innerHTML = '<div class="hdr-notif-empty">No notifications</div>';
                    return;
                }
                
                let html = '';
                notifications.slice(0, 5).forEach(notif => {
                    const isUnread = !notif.is_read;
                    // Provide a default icon fallback
                    let icon = '🔔';
                    let typeClass = 'profile';
                    if (notif.type) {
                        if (notif.type.includes('letter')) { icon = '📄'; typeClass = 'cover_letter'; }
                        else if (notif.type.includes('reply')) { icon = '📬'; typeClass = 'reply'; }
                        else if (notif.type.includes('profile')) { icon = '👤'; typeClass = 'profile'; }
                    }

                    html += `
                        <div class="hdr-notif-card ${isUnread ? 'unread' : ''}" onclick="window.appHeader.handleNotificationClick(${notif.id})">
                            <div class="hdr-notif-icon ${typeClass}">${icon}</div>
                            <div class="hdr-notif-content">
                                <p class="hdr-notif-title">${notif.title}</p>
                                <p class="hdr-notif-msg">${notif.message}</p>
                                <div class="hdr-notif-time">${new Date(notif.created_at).toLocaleDateString()}</div>
                            </div>
                        </div>
                    `;
                });
                body.innerHTML = html;
            }
        },
        async handleNotificationClick(id) {
            try {
                const token = localStorage.getItem('authToken');
                await fetch(`/api/notifications/${id}/read`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                window.location.href = '/notifications';
            } catch (err) {
                window.location.href = '/notifications';
            }
        },
        async markAllNotificationsRead() {
            try {
                const token = localStorage.getItem('authToken');
                await fetch('/api/notifications/mark-all-read', {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                window.appHeader.fetchNotifications();
            } catch (err) {
                console.error(err);
            }
        }
    };

    // Auto-init on script load
    document.addEventListener('DOMContentLoaded', () => {
        window.insertAppHeader();
    });
})();
