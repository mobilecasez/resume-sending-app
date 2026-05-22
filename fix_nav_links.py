import re

js_file = 'public/js/app-header.js'
with open(js_file, 'r') as f:
    content = f.read()

# Make sure index page nav matches dashboard nav for logged-in users!
# The user provided the HTML block. It seems the old app-header.js was injecting a custom layout.
# We will inject a font-size scale up (+20%) for the navbar links natively via CSS override!

css_file = 'css/style.css'
with open(css_file, 'r') as f:
    css_content = f.read()

if '/* Navbar scale +20% */' not in css_content:
    css_content += '\n/* Navbar scale +20% */\n.navbar-nav .nav-link, .nav-btn-landing, .credit-number, .user-name-nav { font-size: 110% !important; }\n'
    with open(css_file, 'w') as f:
        f.write(css_content)

print("Nav links scale updated in CSS.")
