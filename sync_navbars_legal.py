import re
import glob

# Apply the same app-header fix to the legal pages!
files = glob.glob('public/*.html')

new_nav = """<!-- Header Component (Matches Dashboard) -->
    <div id="app-header"></div>"""

for f in files:
    if f in ['public/login.html', 'public/register.html', 'public/dashboard.html']:
        continue # Keep these separate
        
    with open(f, 'r') as file:
        content = file.read()
    
    if '<!-- NAV -->' in content:
        nav_pattern = r'<!-- NAV -->.*?<!-- MOBILE MENU -->.*?</div>'
        content = re.sub(nav_pattern, new_nav, content, flags=re.DOTALL)
        
        script_pattern = r'<script src="/js/app-header.js"></script>'
        if script_pattern not in content:
            content = content.replace('</body>', '    <!-- jQuery from CDN -->\n    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>\n    <!-- Bootstrap JS -->\n    <script src="/bootstrap-4.1.1-dist/js/bootstrap.min.js"></script>\n    <script src="/js/app-header.js"></script>\n</body>')
        
        with open(f, 'w') as file:
            file.write(content)
        print(f"Updated nav on {f}")

