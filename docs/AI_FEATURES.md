# 🤖 Template-Based Cover Letter Generator with Deep Company Research

## Overview

Your resume application now features an **intelligent, template-based cover letter generator** that:
- Uses your existing PDF template (`Cover_Letter_Google_New.pdf`)
- Performs deep company research (About Us, Careers pages)
- Finds matching job positions
- Extracts HR contact information
- Translates non-English websites automatically
- Generates professional, personalized cover letters

## How It Works

### 1. **Template-Based Generation** 📄
- Loads `Cover_Letter_Google_New.pdf` as the base template
- Preserves your professional formatting and layout
- Overlays new company-specific content
- Maintains consistent visual style

### 2. **Resume Analysis** 📋
- Extracts text from your PDF resume
- Identifies key skills, experience, and qualifications
- Parses work history, education, and professional summary
- No manual input required!

### 3. **Deep Company Research** 🔍
**Homepage Analysis:**
- Scrapes company website homepage
- Extracts title, meta description, headings
- Translates non-English content automatically

**About Us Page:**
- Automatically finds /about, /about-us, /company pages
- Reads company mission, values, and business focus
- Understands what the company does

**Careers Page:**
- Searches /careers, /jobs, /opportunities pages
- Finds job listings matching your skills
- Identifies relevant open positions
- Reports number of matching vacancies

**Contact Information:**
- Extracts HR email addresses (hr@, recruit@, career@)
- Finds company address from schema.org or footer
- Identifies hiring manager contacts

### 4. **Skill Matching** 🎯
- Compares your resume skills with company needs
- Highlights relevant experience for each application
- Matches your background with job requirements
- Shows matching job positions found

### 5. **Multi-Language Support** 🌍
- Detects website language automatically
- Translates German, Spanish, Japanese, French, Chinese, etc.
- Processes all information in English
- **Cover letters always generated in English**

### 6. **Professional PDF Output** 📑
- Uses your template layout
- Includes your profile photo (if uploaded)
- Adds your signature (if uploaded)
- Professional formatting with proper spacing
- Contact information header

## Features

### 🎨 Template-Based Design
**Uses your professional PDF template**

- Loads `Cover_Letter_Google_New.pdf` as base
- Maintains your custom formatting and style
- Consistent professional appearance
- Overlays company-specific content
- Preserves layout and branding

### 🔍 Deep Company Research
**Goes beyond the homepage**

- **Homepage**: Title, description, main headings
- **About Us Page**: Company mission, values, business focus
- **Careers Page**: Job listings, open positions
- **Skill Matching**: Finds jobs matching your resume
- **Contact Info**: HR emails, company address
- **Metadata**: Reports what was found on each page

Example Output:
```
✅ Found About page: https://company.com/about
💼 Found 3 matching positions on Careers page
✅ HR Email: careers@company.com
```

### 🌍 Multi-Language Support
**Automatically handles websites in any language**

- Detects website language automatically
- Translates German, Spanish, Japanese, French, Chinese, and 100+ languages
- Processes company information in English
- **Cover letters are always generated in English**
- No configuration needed - works automatically!

Example: German website → English analysis → English cover letter

### Smart Content Generation
**Works out of the box - No API keys needed!**

- Template-based with intelligent customization
- Company-specific content from deep research
- Skill matching with found job positions
- Natural, conversational tone
- Professional structure and flow
- Mentions specific company details from About page

### Optional AI Enhancement
**Powered by OpenAI GPT-4** (Optional)

For even more sophisticated generation:
1. Get an API key from [OpenAI](https://platform.openai.com/api-keys)
2. Add to `.env` file: `OPENAI_API_KEY=sk-your-key`
3. Restart the server

The AI model can create:
- Highly personalized, contextual content
- Industry-specific language
- Compelling narratives
- Professional yet authentic voice

**Note**: The template-based generator works perfectly without AI!

## Usage

### Step 1: Complete Your Profile
1. Go to the **Profile Page**
2. Upload your:
   - Resume (PDF format)
   - Profile Photo (optional but recommended)
   - Signature (optional but recommended)
3. Fill in personal details:
   - Name, Email, Phone
   - Date of Birth
   - City, Country, Zip Code
   - Address

### Step 2: Add Recipients
1. Go to the **Dashboard**
2. For each recipient, enter:
   - **Email**: hiring manager's email
   - **Website**: company website URL
   - **Position**: job title you're applying for (optional)
3. Add multiple recipients using the "+ Add Recipient" button

### Step 3: Generate & Review
1. Click **"Review & Send"** or **"Send Now"** button
2. The system will:
   - Analyze your resume
   - Research each company
   - Generate personalized cover letters
   - Create professional PDFs
   - **Display a preview modal with download links**
3. Review generated cover letters:
   - Click **"Download"** to review each PDF
   - Check company information and metadata
   - See which skills were matched
   - Verify AI generation status

### Step 4: Send Applications
1. After reviewing, click **"Send All Emails"** in the modal
2. Emails will be sent with:
   - Pre-generated personalized cover letter PDF
   - Your resume PDF
   - Professional email template
3. Track results for each recipient
4. Generated PDFs are saved for future reference

### Why Two Steps?
- **Quality Control**: Review before sending ensures accuracy
- **Download & Save**: Keep copies of all your cover letters
- **Peace of Mind**: No surprises, you see exactly what employers get
- **Flexibility**: Close and send later if needed

## What Makes This Different?

### ❌ Traditional Approach
- Generic, one-size-fits-all letters
- Obvious templates
- No company research
- Same content for everyone
- Robotic language

### ✅ Our AI Approach
- Unique letter for each company
- Company-specific content
- Skill matching and research
- Natural, human writing
- Personalized with your details

## Example Output

Here's what a generated cover letter includes:

```
[Your Photo]                                    [Your Name]
                                               [Email | Phone | Location]

                                               [Date]

[Company Name]

Dear Hiring Team,

[Engaging opening that references the company specifically]

[Paragraph highlighting your relevant experience and skills]

[Paragraph showing knowledge of the company and value you bring]

[Strong closing with call to action]

Best regards,

[Your Signature Image]

[Your Name]
```

## Technical Details

### Resume Parsing
- Extracts text from PDF using `pdf-parse`
- Identifies skills sections
- Parses work experience
- Finds education and certifications

### Web Scraping
- Uses `axios` for HTTP requests
- `cheerio` for HTML parsing
- **Google Translate API for multi-language support**
- Automatically detects and translates non-English content
- Supports 100+ languages (German, Spanish, Japanese, French, Chinese, etc.)
- Extracts title, meta description
- Parses main content and headings
- Respects robots.txt and rate limits

### PDF Generation
- Uses `pdf-lib` for professional PDFs
- Embeds photos and signatures
- Professional typography
- Proper spacing and margins
- Clean, ATS-friendly format

### Email Integration
- Attaches generated cover letter PDF
- Includes your resume
- Professional HTML email body
- Contact information displayed
- Customized subject line

## Configuration

### Required (Set in UI)
- SMTP email settings (Settings page)
- Resume upload (Profile page)
- User profile information (Profile page)

### Optional (Environment Variables)
```env
# AI Generation (Optional)
OPENAI_API_KEY=sk-your-api-key

# Existing required variables
JWT_SECRET=your-jwt-secret
ENCRYPTION_KEY=your-encryption-key
```

## Tips for Best Results

### 1. Resume Quality
- Use a well-formatted PDF resume
- Include clear section headers (Skills, Experience, Education)
- List skills explicitly
- Include company names and job titles

### 2. Company Information
- Provide accurate website URLs
- Include www. or https:// in URLs
- Use company career pages when possible
- Specify the position/job title

### 3. Profile Completeness
- Upload a professional photo (headshot style)
- Add your signature image
- Fill in all contact details
- Keep location information current

### 4. Email Settings
- Use app-specific passwords for Gmail
- Configure SMTP settings correctly
- Test with one recipient first
- Check spam folders initially

## Troubleshooting

### Cover Letter Not Personalized Enough
- Ensure resume has clear sections
- Verify website URL is accessible
- Check that skills are listed in resume
- Add more detail to your profile

### Resume Parsing Issues
- Save resume as PDF (not scanned image)
- Use standard fonts
- Include text (not just images)
- Format with clear sections

### Website Scraping Failed
- Verify URL is correct and accessible
- Some sites block automated access (normal)
- System will still generate good content
- Try adding https:// to URL

### Photo/Signature Not Appearing
- Upload PNG format files
- Ensure files are less than 10MB
- Check file permissions
- Verify upload was successful

## Privacy & Security

- Resume parsing happens server-side only
- Company data is scraped in real-time (not stored)
- Your resume and files are stored securely
- SMTP passwords are encrypted (AES-256)
- No data is shared with third parties
- OpenAI API (if used) processes text temporarily

## Future Enhancements

Coming soon:
- Multiple cover letter styles/tones
- Industry-specific templates
- A/B testing different approaches
- Success tracking and analytics
- LinkedIn profile integration
- Job description parsing
- Follow-up email generation

## Support

If you encounter issues:
1. Check the server console for error messages
2. Verify all profile information is complete
3. Test with a single recipient first
4. Review the troubleshooting section above

## Credits

Built with:
- OpenAI GPT-4 (optional)
- pdf-parse for resume reading
- cheerio for web scraping
- pdf-lib for PDF generation
- nodemailer for email sending

---

**Ready to send personalized applications at scale!** 🚀
