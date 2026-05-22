import re

html_file = 'public/index.html'
with open(html_file, 'r') as f:
    content = f.read()

# Replace the "NEW NAV" in index.html with the "app-header" wrapper that dynamically loads the exact same Navbar as dashboard!
nav_pattern = r'<!-- NEW NAV -->.*?<!-- MOBILE MENU -->.*?</div>'

new_nav = """<!-- Header Component (Matches Dashboard) -->
    <div id="app-header"></div>"""

if '<!-- NEW NAV -->' in content:
    content = re.sub(nav_pattern, new_nav, content, flags=re.DOTALL)
    
    # Need to include the app-header.js script at the bottom
    script_pattern = r'<script src="/js/app-header.js"></script>'
    if script_pattern not in content:
        content = content.replace('</body>', '    <!-- jQuery from CDN -->\n    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>\n    <!-- Bootstrap JS -->\n    <script src="/bootstrap-4.1.1-dist/js/bootstrap.min.js"></script>\n    <script src="/js/app-header.js"></script>\n</body>')

with open(html_file, 'w') as f:
    f.write(content)

print("Index page now dynamically uses the identical app-header as the Dashboard.")
