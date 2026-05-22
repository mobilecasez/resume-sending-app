import glob

# Ensure fonts are correctly mapped across all stylesheets to Montserrat
css_files = glob.glob('css/*.css')

new_font = "font-family: 'Montserrat', sans-serif;"
old_font = 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";'

for css_file in css_files:
    try:
        with open(css_file, 'r') as f:
            content = f.read()
        
        # Replace the body font
        if old_font in content:
            content = content.replace(old_font, new_font)
        else:
            # Also catch the one in dashboard_new.css if it was wrapped differently
            content = content.replace('font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";', new_font)
                
        with open(css_file, 'w') as f:
            f.write(content)
        print(f"Updated {css_file} to Montserrat")
    except Exception as e:
        print(f"Error updating {css_file}: {e}")

