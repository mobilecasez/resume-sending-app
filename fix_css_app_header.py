import re

css_file = 'css/index_new.css'
with open(css_file, 'r') as f:
    content = f.read()

# Make sure the app-header sits cleanly on top of the new index layout
if '/* app-header fixes */' not in content:
    content += '\n/* app-header fixes */\n#app-header { position: sticky; top: 0; z-index: 1000; }\nbody { padding-top: 0 !important; }\n'
    with open(css_file, 'w') as f:
        f.write(content)

print("App header layout fixed")
