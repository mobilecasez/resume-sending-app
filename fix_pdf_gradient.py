import re

js_file = 'server.js'
with open(js_file, 'r') as f:
    content = f.read()

# Instead of a solid '#262633' color, PDFKit allows linearGradients!
old_rect = "doc.rect(0, 0, sidebarWidth, pageHeight).fill('#262633');"

new_rect = """// Create dark-blue gradient to match cvapplyr theme
            const grad = doc.linearGradient(0, 0, sidebarWidth, pageHeight);
            grad.stop(0, '#3449a7')
                .stop(0.5, '#2c3552')
                .stop(1, '#172b6d');
            doc.rect(0, 0, sidebarWidth, pageHeight).fill(grad);"""

content = content.replace(old_rect, new_rect)

with open(js_file, 'w') as f:
    f.write(content)
print("PDF generator patched with gradient.")
