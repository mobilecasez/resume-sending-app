# Quick Start Guide

## First-Time Setup (5 minutes)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Your Email

Create a `.env` file:
```bash
cp .env.example .env
```

Edit `.env` and add your email credentials:
```env
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_gmail_app_password
```

**For Gmail Users:**
- Go to Google Account → Security
- Enable 2-Step Verification
- Create an App Password
- Use that password in `.env`

### 3. Add Your Resume

Place your resume PDF in this folder and update `.env`:
```env
RESUME_PATH=Your_Resume.pdf
```

### 4. Update Contact Information

Edit `index.js` line ~85 to add your real contact details:
```javascript
const contactInfo = [
  'Email: your.email@example.com | Phone: (555) 123-4567',
  'LinkedIn: linkedin.com/in/yourprofile | Portfolio: yoursite.com',
];
```

## Applying to a Company (30 seconds)

### Option 1: Interactive (Easiest)

```bash
npm run apply
```

Answer the prompts:
- Company name
- Position
- Email address
- Why this company
- Relevant skills

Done! ✅

### Option 2: Quick Edit `.env`

Edit `.env` file:
```env
COMPANY_NAME=Google
POSITION=Software Engineer
RECIPIENT_EMAIL=hiring@google.com
COMPANY_PARAGRAPH=I'm excited about Google because...
RELEVANT_SKILLS=Python, React, Docker, Kubernetes
```

Run:
```bash
npm start
```

## Testing (Before Real Use)

1. Set your own email as the recipient:
   ```env
   RECIPIENT_EMAIL=your.own.email@gmail.com
   ```

2. Run the app:
   ```bash
   npm start
   ```

3. Check your email inbox

4. Verify the cover letter has:
   - Correct company name
   - Correct position
   - Your custom paragraph
   - Your skills listed

## Tips

### Applying to Multiple Companies

Use interactive mode and run it multiple times:
```bash
npm run apply  # Company 1
npm run apply  # Company 2
npm run apply  # Company 3
```

All applications are logged in `applications.log`

### Customizing Cover Letter Content

The default template has 4 paragraphs:
1. Opening (auto-generated with company/position)
2. **Your custom paragraph** (why this company)
3. Skills paragraph (auto-generated with your skills)
4. Closing (standard)

Edit the `COMPANY_PARAGRAPH` for each application to make it personal!

### Keeping Generated Files

By default, generated cover letters are deleted after sending.

To keep them:
```env
KEEP_GENERATED_FILES=true
```

### Common Errors

**"Resume file not found"**
- Check `RESUME_PATH` in `.env`
- Use the full filename with extension

**"Authentication failed"**
- Use an App Password for Gmail, not your regular password
- Check SMTP settings match your email provider

**"Cover letter template not found"**
- Make sure `Cover_Letter_Rishi_Samadhiya.pdf` exists
- Or update `COVER_LETTER_PATH` in `.env`

## Next Steps

1. Test with your own email first
2. Customize the cover letter template (edit `index.js`)
3. Apply to real companies!
4. Track your applications in `applications.log`

---

**Need Help?** Check the full README.md for detailed documentation.
