# Quick Application Script for Landing Components

This document provides quick copy-paste snippets to apply landing components to each page.

## Files Already Updated

- ✅ **packages.html** - Updated with landing header/footer components

## Pages Ready to Update

### 1. index.html (Dashboard)

**At line 5-6 (after `<link rel="icon"...>`), ADD:**
```html
    <!-- Bootstrap & Landing Styles -->
    <link rel="stylesheet" href="../bootstrap-4.1.1-dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
    <link rel="stylesheet" href="../css/animate.css">
    <!-- PRELOADER -->
    <link rel="stylesheet" href="../css/preloader.css">
    <link rel="stylesheet" href="../css/style.css">
```

**In body styles, UPDATE padding:**
```css
body {
    /* existing styles */
    padding-top: 70px; /* Add this for fixed navbar */
}
```

**At `<body>` opening, ADD:**
```html
<body data-spy="scroll" data-target=".navbar">
    <!-- PRELOADER -->
    <div class="preloader-holder">
        <div class="loading">
            <div class="finger finger-1">
                <div class="finger-item"><span></span><i></i></div>
            </div>
            <div class="finger finger-2">
                <div class="finger-item"><span></span><i></i></div>
            </div>
            <div class="finger finger-3">
                <div class="finger-item"><span></span><i></i></div>
            </div>
            <div class="finger finger-4">
                <div class="finger-item"><span></span><i></i></div>
            </div>
            <div class="last-finger">
                <div class="last-finger-item"><i></i></div>
            </div>
        </div>
    </div>

    <!-- Landing Header -->
    <div id="landing-header"></div>
```

**Before `</body>` closing (after all existing scripts), ADD:**
```html
    <!-- Landing Footer -->
    <div id="landing-footer"></div>
    
    <!-- jQuery (required for Bootstrap) -->
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/1.11.3/jquery.min.js"></script>
    <!-- Popper.js -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/popper.js/1.14.3/umd/popper.min.js"></script>
    <!-- Bootstrap JS -->
    <script src="../bootstrap-4.1.1-dist/js/bootstrap.min.js"></script>
    <!-- Icons -->
    <script src="https://cdn.jsdelivr.net/npm/vivid-icons"></script>
    <script src="https://unpkg.com/vivid-icons"></script>
    <!-- WOW Animation -->
    <script src="../js/plugins/wow/wow.min.js"></script>
    <!-- Easing -->
    <script src="../js/plugins/jquery.easing.min.js"></script>
    <!-- Main JS -->
    <script src="../js/main.js"></script>
    <script>
        new WOW().init();
        // Preloader
        $(window).on('load', function() {
            $('.preloader-holder').fadeOut('slow');
        });
    </script>
    
    <!-- Landing Components -->
    <script src="/js/landing-header.js"></script>
    <script src="/js/landing-footer.js"></script>
</body>
```

**REMOVE (if present):**
```html
<script src="/js/common-header.js"></script>
<script src="/js/common-footer.js"></script>
```

---

### 2. review.html

Same steps as index.html above.

---

### 3. profile.html

Same steps as index.html above.

---

### 4. usage.html

Same steps as index.html above.

---

### 5. payment.html, payment-success.html, payment-failure.html

Same steps as index.html above.

---

### 6. admin-packages.html

Same steps as index.html above.

---

### 7. contact.html

Same steps as index.html above.

---

## Testing Each Page

After updating a page:

1. **Start server:** `node server.js`
2. **Open:** `http://localhost:3000/[page-name]`
3. **Check:**
   - [ ] Landing header appears at top
   - [ ] Fixed navbar stays on scroll
   - [ ] Nav links work (Home, Why CVApplyr, Features, Pricing, Contact)
   - [ ] Auth buttons show correctly (Sign In/Sign Up or Dashboard)
   - [ ] Mobile menu works
   - [ ] Footer appears at bottom
   - [ ] No console errors
   - [ ] Existing page functionality works

## Batch Apply Script (Optional)

Here's a Node.js script to automatically apply changes to all pages:

```javascript
// apply-landing-components.js
const fs = require('fs');
const path = require('path');

const pagesToUpdate = [
    'index.html',
    'review.html',
    'profile.html',
    'usage.html',
    'payment.html',
    'payment-success.html',
    'payment-failure.html',
    'admin-packages.html',
    'contact.html'
];

const headIncludes = `
    <!-- Bootstrap & Landing Styles -->
    <link rel="stylesheet" href="../bootstrap-4.1.1-dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
    <link rel="stylesheet" href="../css/animate.css">
    <link rel="stylesheet" href="../css/style.css">
`;

const headerDiv = `
    <!-- Landing Header -->
    <div id="landing-header"></div>
`;

const footerScripts = `
    <!-- Landing Footer -->
    <div id="landing-footer"></div>
    
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
</body>
</html>
`;

pagesToUpdate.forEach(page => {
    const filePath = path.join(__dirname, 'public', page);
    
    if (!fs.existsSync(filePath)) {
        console.log(`⚠️  ${page} not found, skipping...`);
        return;
    }
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Add head includes if not present
    if (!content.includes('landing-header.js')) {
        content = content.replace('</head>', headIncludes + '\n</head>');
    }
    
    // Add header div after body tag
    if (!content.includes('landing-header')) {
        content = content.replace('<body>', '<body>' + headerDiv);
    }
    
    // Add footer and scripts before closing body
    if (!content.includes('landing-footer')) {
        content = content.replace('</body>\n</html>', footerScripts);
    }
    
    // Remove old common-header/footer scripts
    content = content.replace(/<script src="\/js\/common-header\.js"><\/script>\s*/g, '');
    content = content.replace(/<script src="\/js\/common-footer\.js"><\/script>\s*/g, '');
    
    fs.writeFileSync(filePath, content);
    console.log(`✅ ${page} updated successfully`);
});

console.log('\n🎉 All pages updated!');
```

**To use the script:**
```bash
node apply-landing-components.js
```

---

## Manual Update Checklist

For each page you update manually:

- [ ] Add Bootstrap & Landing CSS links in `<head>`
- [ ] Add `padding-top: 70px` to body styles
- [ ] Add `<div id="landing-header"></div>` after `<body>`
- [ ] Remove old `common-header.js` and `common-footer.js` scripts
- [ ] Add footer div and all required scripts before `</body>`
- [ ] Test the page locally
- [ ] Verify no console errors
- [ ] Check mobile responsiveness
- [ ] Verify existing functionality still works

---

## Rollback Instructions

If you need to revert changes on any page:

1. **Restore from Git:**
   ```bash
   git checkout HEAD -- public/[page-name].html
   ```

2. **Or manually revert:**
   - Remove landing CSS includes from `<head>`
   - Remove `<div id="landing-header"></div>`
   - Remove `<div id="landing-footer"></div>` and landing scripts
   - Restore original `common-header.js` and `common-footer.js` scripts
   - Restore original body padding

---

## Priority Order

Recommended order to update pages:

1. ✅ **packages.html** (DONE - tested)
2. **index.html** (dashboard - most used page)
3. **review.html** (core functionality)
4. **profile.html** (user settings)
5. **usage.html** (credits management)
6. **payment pages** (payment.html, payment-success.html, payment-failure.html)
7. **admin-packages.html** (admin panel)
8. **contact.html** (support page)

---

**Next Action:** Test packages.html at `http://localhost:3000/packages` to verify landing components work correctly, then proceed with remaining pages.
