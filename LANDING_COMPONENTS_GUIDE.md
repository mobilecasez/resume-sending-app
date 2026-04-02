# Landing Page Components Integration Guide

This guide explains how to use the reusable landing-header.js and landing-footer.js components to apply the ShopFlix AI landing page design to any CVApplyr application page.

## Files Created

1. **`/public/js/landing-header.js`** - Landing page header/navbar component
2. **`/public/js/landing-footer.js`** - Landing page footer component

## Features

- **Dynamic Routing**: Automatically detects localhost vs production (cvapplyr.com)
- **Auth-Aware**: Shows different navigation based on login status
- **Easy Integration**: Just add 3 elements to any HTML page
- **Consistent Design**: Uses exact ShopFlix AI template design from about.html
- **Auto-Inject**: Components automatically inject when DOM is ready

## Integration Steps

### Step 1: Add Required CSS/JS Dependencies

Add these in the `<head>` section of your page:

```html
<!-- Bootstrap CSS (if not already included) -->
<link rel="stylesheet" href="../bootstrap-4.1.1-dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
<!-- Landing Page Styles -->
<link rel="stylesheet" href="../css/animate.css">
<link rel="stylesheet" href="../css/style.css">
```

Add these at the end of `<body>` (before closing tag):

```html
<!-- jQuery (required for Bootstrap) -->
<script src="https://ajax.googleapis.com/ajax/libs/jquery/1.11.3/jquery.min.js"></script>
<!-- Popper.js -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/popper.js/1.14.3/umd/popper.min.js"></script>
<!-- Bootstrap JS -->
<script src="../bootstrap-4.1.1-dist/js/bootstrap.min.js"></script>
<!-- WOW Animation -->
<script src="../js/plugins/wow/wow.min.js"></script>
<script>new WOW().init();</script>

<!-- Landing Components -->
<script src="/js/landing-header.js"></script>
<script src="/js/landing-footer.js"></script>
```

### Step 2: Add Container Elements

Add these elements in your HTML body:

```html
<body>
    <!-- Landing Header Container -->
    <div id="landing-header"></div>
    
    <!-- Your existing page content here -->
    <div class="your-content">
        <!-- ... -->
    </div>
    
    <!-- Landing Footer Container -->
    <div id="landing-footer"></div>
    
    <!-- Scripts go here -->
</body>
```

### Step 3: Adjust Body Padding

The landing navbar is fixed at the top. Add this CSS to prevent content from hiding under it:

```html
<style>
    body {
        padding-top: 70px; /* Account for fixed navbar */
    }
</style>
```

## Complete Example

Here's a minimal working example:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Page - CVApplyr</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    
    <!-- Bootstrap & Landing Styles -->
    <link rel="stylesheet" href="../bootstrap-4.1.1-dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
    <link rel="stylesheet" href="../css/animate.css">
    <link rel="stylesheet" href="../css/style.css">
    
    <style>
        body {
            padding-top: 70px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .content-wrapper {
            padding: 40px 20px;
        }
    </style>
</head>
<body>
    <!-- Landing Header -->
    <div id="landing-header"></div>
    
    <!-- Page Content -->
    <div class="content-wrapper">
        <div class="container">
            <h1>Your Page Content Here</h1>
            <p>This page now has the landing header and footer!</p>
        </div>
    </div>
    
    <!-- Landing Footer -->
    <div id="landing-footer"></div>
    
    <!-- Scripts -->
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/1.11.3/jquery.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/popper.js/1.14.3/umd/popper.min.js"></script>
    <script src="../bootstrap-4.1.1-dist/js/bootstrap.min.js"></script>
    <script src="../js/plugins/wow/wow.min.js"></script>
    <script>new WOW().init();</script>
    
    <!-- Landing Components -->
    <script src="/js/landing-header.js"></script>
    <script src="/js/landing-footer.js"></script>
</body>
</html>
```

## Component Behavior

### Header Component

**Navigation Links:**
- Home → /about#home
- Why CVApplyr → /about#services
- Features → /about#features
- Pricing → /about#pricing
- Contact → /about#contact

**Auth Detection:**
- **Not logged in**: Shows "Sign In" and "Sign Up Free" buttons
- **Logged in**: Shows "Dashboard" link and "Go to App" button

**Global Functions Available:**
- `window.navigateToApp(path)` - Navigate to app pages with dynamic URL
- `window.CVA_BASE_URL` - Current base URL (localhost:3000 or cvapplyr.com)
- `window.insertLandingHeader(targetId)` - Manually insert header if needed

### Footer Component

**Sections:**
- **CVApplyr**: Brand description
- **Quick Links**: Links to landing page sections
- **Legal**: Privacy Policy, Terms of Service, Refund Policy
- **Contact**: Email and company information

**Global Functions Available:**
- `window.insertLandingFooter(targetId)` - Manually insert footer if needed

## Advanced Usage

### Custom Target IDs

If you need different container IDs:

```html
<div id="my-custom-header"></div>
<div id="my-custom-footer"></div>

<script>
    // Manually trigger with custom IDs
    document.addEventListener('DOMContentLoaded', function() {
        insertLandingHeader('my-custom-header');
        insertLandingFooter('my-custom-footer');
    });
</script>
```

### Disable Auto-Injection

If you don't have elements with IDs `landing-header` and `landing-footer`, the components won't auto-inject. You can manually control injection:

```javascript
// Insert header and footer programmatically
window.insertLandingHeader('header-container');
window.insertLandingFooter('footer-container');
```

## Path Considerations

**For pages in `/public/` directory:**
- Use `../bootstrap-4.1.1-dist/` for Bootstrap
- Use `../css/` for stylesheets
- Use `../js/` for JavaScript files
- Use `/js/landing-header.js` for component scripts (absolute path)

**For pages in root directory:**
- Use `bootstrap-4.1.1-dist/` (no `../`)
- Use `css/` (no `../`)
- Use `js/` (no `../`)

## Pages to Update

Apply these components to:
- ✅ login.html (already has landing design)
- ✅ register.html (already has landing design)
- ⏳ packages.html
- ⏳ index.html (dashboard)
- ⏳ review.html
- ⏳ profile.html
- ⏳ usage.html
- ⏳ payment.html
- ⏳ payment-success.html
- ⏳ payment-failure.html
- ⏳ admin-packages.html
- ⏳ contact.html

## Testing Checklist

After integrating components:

- [ ] Header appears at top of page
- [ ] Navbar is fixed and scrolls with page
- [ ] All navigation links work correctly
- [ ] Auth buttons show correct state (logged in/out)
- [ ] Mobile menu works (hamburger icon)
- [ ] Footer appears at bottom with all sections
- [ ] All footer links work
- [ ] No console errors
- [ ] Dynamic routing works (localhost vs production)

## Troubleshooting

**Header/Footer not showing:**
- Check browser console for errors
- Verify container elements have correct IDs: `landing-header` and `landing-footer`
- Ensure scripts are loaded after container elements
- Check that paths to CSS/JS files are correct

**Navbar covers content:**
- Add `padding-top: 70px;` to body styles

**Bootstrap styles conflict:**
- Landing components use Bootstrap 4.1.1
- Ensure no conflicting Bootstrap versions are loaded

**Dynamic routing not working:**
- Check that `BASE_URL` is correctly detected
- Verify localStorage has `authToken` for logged-in users

## Maintenance

To update header/footer across all pages:
1. Edit `/public/js/landing-header.js` or `/public/js/landing-footer.js`
2. Changes automatically apply to all pages using the components
3. No need to update individual HTML files

This component-based approach ensures:
- ✅ Consistent design across all pages
- ✅ Easy maintenance (update once, apply everywhere)
- ✅ Reduced code duplication
- ✅ Faster page updates

---

**Next Steps:** Test components on packages.html, then progressively apply to remaining pages.
