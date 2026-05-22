/**
 * App Footer Component for CVApplyr
 * Shared footer injected on all pages — matches index.html design
 */

(function() {
    'use strict';

    const footerStyle = `
<style id="app-footer-styles">
.site-footer {
    background: #080C1A;
    padding: 60px 40px 28px;
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, sans-serif;
    border-top: 1px solid rgba(255,255,255,0.06);
}
.site-footer .footer-grid {
    max-width: 1280px; margin: 0 auto;
    display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 48px;
    margin-bottom: 40px;
}
.site-footer .footer-brand .brand {
    display: inline-flex; align-items: center; gap: 10px; margin-bottom: 14px;
}
.site-footer .footer-brand .brand-icon {
    width: 28px; height: 28px;
    background-image: url('/assets/logo_img.png');
    background-size: contain; background-repeat: no-repeat; background-position: center;
    filter: brightness(0) invert(1);
}
.site-footer .footer-brand .brand-text { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
.site-footer .footer-brand .brand-text .cv { color: #ECEFF7; }
.site-footer .footer-brand .brand-text .applyr { color: #3B82F6; }
.site-footer .footer-brand p { font-size: 13px; color: #6B7490; line-height: 1.6; margin: 0 0 10px; }
.site-footer .footer-co { font-size: 12px; color: #4A5168; }
.site-footer .footer-col h4 { font-size: 12px; font-weight: 700; color: #ECEFF7; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 16px; }
.site-footer .footer-col a { display: block; font-size: 13.5px; color: #6B7490; text-decoration: none; margin-bottom: 10px; transition: color 0.15s; }
.site-footer .footer-col a:hover { color: #ECEFF7; }
.site-footer .footer-bottom {
    max-width: 1280px; margin: 0 auto;
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.06);
    font-size: 12px; color: #4A5168;
}
@media (max-width: 768px) {
    .site-footer { padding: 40px 20px 24px; }
    .site-footer .footer-grid { grid-template-columns: 1fr; gap: 32px; }
    .site-footer .footer-bottom { flex-direction: column; gap: 6px; text-align: center; }
}
</style>
    `;

    window.insertAppFooter = function(targetId = 'app-footer') {
        const targetElement = document.getElementById(targetId);
        if (!targetElement) return;

        if (!document.getElementById('app-footer-styles')) {
            document.head.insertAdjacentHTML('beforeend', footerStyle);
        }

        targetElement.innerHTML = `
<footer class="site-footer">
    <div class="footer-grid">
        <div class="footer-brand">
            <div class="brand">
                <div class="brand-icon"></div>
                <div class="brand-text"><span class="cv">cv</span><span class="applyr">applyr</span></div>
            </div>
            <p>AI-powered cover-letter generation &amp; bulk job application sending.</p>
            <div class="footer-co">Built &amp; owned by <strong>zSellr (OPC) Private Limited</strong></div>
        </div>
        <div class="footer-col">
            <h4>Quick Links</h4>
            <a href="/">Home</a>
            <a href="/#why">Why CVApplyr</a>
            <a href="/#features">Features</a>
            <a href="/#pricing">Pricing</a>
            <a href="/#contact">Contact</a>
        </div>
        <div class="footer-col">
            <h4>Legal</h4>
            <a href="/privacy-policy">Privacy Policy</a>
            <a href="/terms-of-service">Terms of Service</a>
            <a href="/refund-policy">Refund Policy</a>
            <a href="/support">Support</a>
        </div>
        <div class="footer-col">
            <h4>Contact</h4>
            <a href="mailto:support@cvapplyr.com">support@cvapplyr.com</a>
        </div>
    </div>
    <div class="footer-bottom">
        <span>© 2026 CVApplyr by zSellr (OPC) Private Limited · All rights reserved</span>
        <span>Made in India · with care</span>
    </div>
</footer>
        `;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            if (document.getElementById('app-footer')) window.insertAppFooter();
        });
    } else {
        if (document.getElementById('app-footer')) window.insertAppFooter();
    }
})();
