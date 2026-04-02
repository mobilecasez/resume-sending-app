/**
 * App Footer Component for CVApplyr
 * Injects the landing-style footer with links
 * Preserves all styles from packages.html (landing page design)
 */

(function() {
    'use strict';

    // Function to insert app footer
    window.insertAppFooter = function(targetId = 'app-footer') {
        const targetElement = document.getElementById(targetId);
        if (!targetElement) {
            console.error('App footer target element not found:', targetId);
            return;
        }

        // Get current origin for environment-aware links
        const baseUrl = window.location.origin;

        const footerHTML = `
    <!-- FOOTER -->
    <footer id="footer" class="footer" style="background: #1e1e2f; padding: 60px 0 30px 0; margin-top: 0;">
        <div class="container">
            <div class="row">
                <div class="col-md-4 col-sm-12 mb-4">
                    <h5 class="text-white mb-3">CVApplyr</h5>
                    <p class="text-muted">AI-Powered Cover Letter Generation and Application Sending App</p>
                </div>
                <div class="col-md-2 col-sm-6 mb-4">
                    <h6 class="text-white mb-3">Quick Links</h6>
                    <ul class="list-unstyled">
                        <li><a href="/about#home" class="text-muted" style="text-decoration: none;">Home</a></li>
                        <li><a href="/about#services" class="text-muted" style="text-decoration: none;">Why CVApplyr</a></li>
                        <li><a href="/about#features" class="text-muted" style="text-decoration: none;">Features</a></li>
                        <li><a href="/about#prices" class="text-muted" style="text-decoration: none;">Pricing</a></li>
                        <li><a href="/about#contact" class="text-muted" style="text-decoration: none;">Contact</a></li>
                    </ul>
                </div>
                <div class="col-md-3 col-sm-6 mb-4">
                    <h6 class="text-white mb-3">Legal</h6>
                    <ul class="list-unstyled">
                        <li><a href="${baseUrl}/privacy" class="text-muted" style="text-decoration: none;">Privacy Policy</a></li>
                        <li><a href="${baseUrl}/terms" class="text-muted" style="text-decoration: none;">Terms of Service</a></li>
                        <li><a href="${baseUrl}/refund" class="text-muted" style="text-decoration: none;">Refund Policy</a></li>
                    </ul>
                </div>
                <div class="col-md-3 col-sm-12 mb-4">
                    <h6 class="text-white mb-3">Contact</h6>
                    <ul class="list-unstyled text-muted">
                        <li>Email: support@cvapplyr.com</li>
                        <li>© 2026 zSellr Enterprises LLP</li>
                    </ul>
                </div>
            </div>
            <div class="row mt-4">
                <div class="col-12 text-center">
                    <p class="text-muted mb-0" style="font-size: 14px;">&copy; 2026 CVApplyr by zSellr Enterprises LLP. All Rights Reserved.</p>
                </div>
            </div>
        </div>
    </footer>
        `;
        
        targetElement.innerHTML = footerHTML;
    };

    // Auto-insert footer when DOM is ready if auto-insert element exists
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            const autoInsert = document.getElementById('app-footer');
            if (autoInsert) {
                window.insertAppFooter();
            }
        });
    } else {
        const autoInsert = document.getElementById('app-footer');
        if (autoInsert) {
            window.insertAppFooter();
        }
    }
})();
