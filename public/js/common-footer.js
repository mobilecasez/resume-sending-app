// Common Footer Component
(function() {
    'use strict';

    const footerHTML = `
        <footer id="common-footer">
            <div class="footer-container">
                <div class="footer-section">
                    <h3>CVApplyr</h3>
                    <p>AI-powered cover letter generation for your job applications</p>
                </div>
                
                <div class="footer-section">
                    <h4>Product</h4>
                    <ul>
                        <li><a href="/packages">Packages</a></li>
                        <li><a href="/usage">Usage & Credits</a></li>
                    </ul>
                </div>
                
                <div class="footer-section">
                    <h4>Legal</h4>
                    <ul>
                        <li><a href="/terms">Terms & Conditions</a></li>
                        <li><a href="/privacy">Privacy Policy</a></li>
                        <li><a href="/refund">Refund Policy</a></li>
                    </ul>
                </div>
                
                <div class="footer-section">
                    <h4>Support</h4>
                    <ul>
                        <li><a href="mailto:support@cvapplyr.com">Contact Us</a></li>
                        <li><a href="mailto:support@cvapplyr.com">Help Center</a></li>
                    </ul>
                </div>
            </div>
            
            <div class="footer-bottom">
                <p>&copy; 2026 CVApplyr. All rights reserved.</p>
            </div>
        </footer>
    `;

    const footerStyles = `
        <style id="common-footer-styles">
            #common-footer {
                background: white;
                margin-top: 60px;
                padding: 40px 24px 24px;
                box-shadow: 0 -2px 10px rgba(0,0,0,0.05);
            }

            .footer-container {
                max-width: 1200px;
                margin: 0 auto;
                display: grid;
                grid-template-columns: 2fr 1fr 1fr 1fr;
                gap: 32px;
                margin-bottom: 32px;
            }

            @media (max-width: 768px) {
                .footer-container {
                    grid-template-columns: 1fr;
                    gap: 24px;
                }
            }

            .footer-section h3 {
                color: #6366F1;
                font-size: 1.5rem;
                margin-bottom: 12px;
            }

            .footer-section h4 {
                color: #1F2937;
                font-size: 1rem;
                margin-bottom: 16px;
                font-weight: 600;
            }

            .footer-section p {
                color: #6B7280;
                line-height: 1.6;
                font-size: 0.875rem;
            }

            .footer-section ul {
                list-style: none;
                padding: 0;
                margin: 0;
            }

            .footer-section ul li {
                margin-bottom: 12px;
            }

            .footer-section ul li a {
                color: #6B7280;
                text-decoration: none;
                font-size: 0.875rem;
                transition: color 0.2s;
            }

            .footer-section ul li a:hover {
                color: #6366F1;
            }

            .footer-bottom {
                max-width: 1200px;
                margin: 0 auto;
                padding-top: 24px;
                border-top: 1px solid #E5E7EB;
                text-align: center;
            }

            .footer-bottom p {
                color: #9CA3AF;
                font-size: 0.875rem;
            }
        </style>
    `;

    window.commonFooter = {
        init: function() {
            // Add styles
            document.head.insertAdjacentHTML('beforeend', footerStyles);
            
            // Add footer HTML before closing body tag
            document.body.insertAdjacentHTML('beforeend', footerHTML);
        }
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            window.commonFooter.init();
        });
    } else {
        window.commonFooter.init();
    }
})();
