import glob
import re

files = glob.glob('public/*.html')
new_font = "font-family: 'Montserrat', sans-serif;"
old_font = 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";'

for f in files:
    with open(f, 'r') as file:
        content = file.read()
    
    # Re-inject Google Fonts for Montserrat in the head since it's not a native system font
    # Let's add it right before the custom css link if it's missing
    if 'Montserrat' not in content and '<link rel="stylesheet"' in content:
        google_font_link = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n'
        content = re.sub(r'(<link rel="stylesheet")', google_font_link + r'\1', content, count=1)
    
    content = content.replace(old_font, new_font)
    
    with open(f, 'w') as file:
        file.write(content)

print("Inline HTML fonts enforced to Montserrat and Google Font links added.")
