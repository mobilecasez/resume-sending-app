# CVApplyr Landing Website

This is a professional landing page for CVApplyr designed for Google OAuth verification and public marketing.

## 📁 Structure

```
Landing Website/
├── index.html          # Main landing page
├── css/               # Stylesheets
│   ├── style.css      # Main styles
│   ├── animate.css    # Animation effects
│   └── preloader.css  # Loading screen
├── js/                # JavaScript files
├── imgs/              # Images and assets
│   └── logo.png       # CVApplyr logo
└── README.md          # This file
```

## 🎨 Sections Included

1. **Hero/Banner** - Main headline with CTA
2. **About** - Key benefits (User-Friendly, Mobile Ready, 24/7 Support)
3. **Why CVApplyr** - Main features with visual blocks:
   - AI-Powered Cover Letter Generation
   - Bulk Application Sending
   - Application Tracking
4. **Features** - 6 feature cards highlighting capabilities
5. **Pricing** - 4 credit packages (Starter, Basic, Professional, Enterprise)
6. **How It Works** - 3-step process
7. **Testimonials** - Customer success stories
8. **Contact** - Support information and CTA
9. **Footer** - Links to all legal pages and social media

## 🚀 Deployment Options

### Option 1: Use as OAuth Homepage
In Google OAuth Consent Screen, set:
```
Application home page: https://cvapplyr.com/landing
```

### Option 2: Deploy to Railway (Subdomain)
Use a subdomain like `landing.cvapplyr.com` or `www.cvapplyr.com`

### Option 3: Replace Main Homepage
Move to `public/` folder and rename as needed

## 📝 Customization

### Update Links
All CTA buttons point to:
- `https://cvapplyr.com/register` - Sign up
- `https://cvapplyr.com/packages` - Pricing packages
- `https://cvapplyr.com/login` - Login

### Update Pricing
Edit the pricing section (line ~300) to match your current packages:
- Starter: ₹99 / 10 Credits
- Basic: ₹299 / 50 Credits  
- Professional: ₹799 / 150 Credits
- Enterprise: ₹1,999 / 500 Credits

### Update Contact Info
- Email: support@cvapplyr.com
- Location: Gurgaon, Haryana, India
- Company: zSellr (OPC) Private Limited

## 🎯 Google OAuth Verification

This landing page resolves all 3 Google verification issues:

✅ **Issue 1: Domain Ownership**
- Add Google Search Console verification tag in `<head>`

✅ **Issue 2: Privacy Policy Link**
- Footer contains links to `/privacy-policy` and `/terms-of-service`

✅ **Issue 3: Public Homepage**
- No login required - fully accessible to public

## 🔗 Required External Links

Ensure these pages are accessible:
- https://cvapplyr.com/privacy-policy
- https://cvapplyr.com/terms-of-service
- https://cvapplyr.com/refund-policy
- https://cvapplyr.com/about
- https://cvapplyr.com/contact

## 📱 Responsive Design

The landing page is fully responsive and works on:
- Desktop (1200px+)
- Tablet (768px - 1199px)
- Mobile (< 768px)

## 🎨 Design Credits

UI/UX design inspired by ShopFlix AI project with customization for CVApplyr's job application use case.

## 📦 Dependencies

All dependencies are loaded via CDN:
- Bootstrap 4.6.2
- Font Awesome 5.15.4
- WOW.js (scroll animations)
- jQuery 3.6.0

No build process required - just upload and deploy!

## 🚦 Next Steps

1. **Review the landing page** - Open `index.html` in a browser
2. **Update any content** as needed
3. **Add screenshots** - Place dashboard/app screenshots in `imgs/` folder
4. **Deploy** - Choose one of the deployment options above
5. **Update Google OAuth** - Set homepage URL in Google Cloud Console
6. **Verify domain** - Complete Google Search Console verification

---

**Questions?** Contact the development team for any customization needs.
