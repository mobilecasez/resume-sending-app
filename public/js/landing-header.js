/**
 * Landing Header Component for CVApplyr
 * Dynamically injects the landing page header/navbar into any page
 * Based on the ShopFlix AI template design
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
    
    // Make BASE_URL globally available
    window.CVA_BASE_URL = BASE_URL;

    // Helper function to navigate to app pages
    window.navigateToApp = function(path) {
        window.location.href = BASE_URL + path;
    };

    // Function to insert landing header
    window.insertLandingHeader = function(targetId = 'landing-header') {
        const targetElement = document.getElementById(targetId);
        if (!targetElement) {
            console.error('Landing header target element not found:', targetId);
            return;
        }

        const headerHTML = `
    <!-- HEADER -->
    <header id="home">
        <!-- Navbar -->
        <nav class="navbar navbar-expand-lg fixed-top">
            <div class="container">
                <a class="navbar-brand" href="/about">CV<span>Applyr</span></a>
                <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarNav">
                    <i class="material-icons">menu</i>
                </button>
                <div class="collapse navbar-collapse" id="navbarNav">
                    <ul class="nav navbar-nav ml-auto">
                        <li class="nav-item">
                            <a class="nav-link" href="/about#home">Home</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/about#services">Why CVApplyr</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/about#features">Features</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/about#pricing">Pricing</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="/about#contact">Contact</a>
                        </li>
                        <li class="nav-item" id="landingAuthLinks">
                            <!-- Will be populated based on auth status -->
                        </li>
                    </ul>
                </div>
            </div>
        </nav>
    </header>
        `;
        
        targetElement.innerHTML = headerHTML;
        
        // Update auth links based on login status
        updateLandingAuthLinks();
    };

    // Function to update auth links based on login status
    function updateLandingAuthLinks() {
        const authLinksContainer = document.getElementById('landingAuthLinks');
        if (!authLinksContainer) return;

        const token = localStorage.getItem('authToken');
        const userData = JSON.parse(localStorage.getItem('userData') || '{}');
        
        if (token && userData.email) {
            // User is logged in - show dashboard link
            authLinksContainer.innerHTML = `
                <a class="nav-link" href="/">Dashboard</a>
            </li>
            <li>
                <a href="/" class="btn btn-primary">Go to App</a>
            `;
        } else {
            // User not logged in - show Sign In/Sign Up
            authLinksContainer.innerHTML = `
                <a class="nav-link" href="javascript:void(0)" onclick="navigateToApp('/login')">Sign In</a>
            </li>
            <li>
                <a href="javascript:void(0)" onclick="navigateToApp('/register')" class="btn btn-primary">Sign Up Free</a>
            `;
        }
    }

    // Auto-insert header when DOM is ready if auto-insert element exists
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            const autoInsert = document.getElementById('landing-header');
            if (autoInsert) {
                window.insertLandingHeader();
            }
        });
    } else {
        const autoInsert = document.getElementById('landing-header');
        if (autoInsert) {
            window.insertLandingHeader();
        }
    }
})();
