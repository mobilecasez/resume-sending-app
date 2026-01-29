# Resume Sending Application

A Node.js application that **generates custom cover letters for each company** while preserving formatting, and automatically sends them with your resume via email.

## ✨ New Features (v2.0)

- 🎯 **Custom Cover Letter Generation**: Automatically creates a new cover letter for each company
- 🏢 **Company-Specific Content**: Customizes company name, position, and relevant paragraphs
- 💼 **Interactive Mode**: Easy-to-use interface for applying to multiple companies
- 📝 **Template-Based**: Uses your existing cover letter as a formatting reference
- 🎨 **Format Preservation**: Maintains consistent formatting across all applications

## Features

- 📄 **Intelligent Cover Letter Rewriting**: Generates new cover letters with company-specific details
- 🎨 **Format Preservation**: Creates PDFs with identical formatting to your template
- 📧 **Email Integration**: Automatically sends resume and custom cover letter via SMTP
- 🔒 **Secure Configuration**: Uses environment variables for sensitive data
- ⚙️ **Flexible Usage**: Interactive mode or direct configuration
- 📊 **Application Tracking**: Logs all sent applications

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- A valid SMTP email account (Gmail, Outlook, etc.)

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file by copying the example:
```bash
cp .env.example .env
```

4. Edit `.env` with your actual credentials and configuration:
```bash
nano .env
# or
code .env
```

## Configuration

### Email Setup (Gmail Example)

For Gmail, you'll need to create an **App Password**:

1. Go to your Google Account settings
2. Navigate to Security
3. Enable 2-Step Verification (if not already enabled)
4. Go to "App passwords"
5. Generate a new app password for "Mail"
6. Use this password in your `.env` file

### Environment Variables

Edit your `.env` file with the following:

```env
# Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_specific_password

# Recipient Email
RECIPIENT_EMAIL=employer@example.com

# File Paths
RESUME_PATH=your_resume.pdf
COVER_LETTER_PATH=Cover_Letter_Rishi_Samadhiya.pdf

# Email Content
SENDER_NAME=Rishi Samadhiya
EMAIL_SUBJECT=Job Application - Rishi Samadhiya
EMAIL_BODY_TEXT=Dear Hiring Manager,...
EMAIL_BODY_HTML=<p>Dear Hiring Manager,</p>...

# PDF Modification Options
ADD_DATE_STAMP=true
ADD_CUSTOM_TEXT=
```

### File Paths

- Place your resume PDF in the project folder
- The cover letter `Cover_Letter_Rishi_Samadhiya.pdf` should already be present
- Update `RESUME_PATH` in `.env` to point to your resume file

## Usage

### Method 1: Interactive Mode (Recommended)

Apply to companies one by one with an interactive prompt:

```bash
npm run apply
```

This will ask you for:
- Company name
- Position title
- Recipient email
- Why you're interested in this company
- Relevant skills to highlight

The app will then:
1. Generate a custom cover letter with that information
2. Send it along with your resume
3. Log the application

### Method 2: Direct Configuration

For batch applications or automation:

1. Edit your `.env` file with company details:
```env
COMPANY_NAME=Google
POSITION=Senior Software Engineer
RECIPIENT_EMAIL=hiring@google.com
COMPANY_PARAGRAPH=Your custom paragraph about why Google...
RELEVANT_SKILLS=Python, Go, Kubernetes, etc.
```

2. Run the application:
```bash
npm start
```

### Method 3: Batch Processing

Create a `companies.json` file (see `companies.example.json`):

```json
[
  {
    "companyName": "Google",
    "position": "Software Engineer",
    "recipientEmail": "hiring@google.com",
    "companyParagraph": "Why Google...",
    "relevantSkills": "Python, Go, etc."
  }
]
```

Then create a simple batch script to process all companies.

## What It Does

1. ✅ Analyzes your template cover letter structure
2. ✅ Generates a NEW cover letter with:
   - Updated company name throughout
   - Custom position title
   - Your company-specific paragraph (why this company)
   - Relevant skills for this particular role
   - Current date
3. ✅ Preserves exact formatting (fonts, spacing, layout)
4. ✅ Sends personalized email with both attachments
5. ✅ Logs the application for your records

## Customization

### Cover Letter Template

The application creates cover letters with this structure:

```
[Your Name - Bold, larger font]
[Contact Info - Email, Phone, LinkedIn, Portfolio]

[Current Date]

[Recipient Name]
[Company Name]

Dear [Recipient Name],

[Opening paragraph - mentions position and company]
[Company-specific paragraph - YOUR CUSTOM TEXT]
[Skills paragraph - YOUR RELEVANT SKILLS]
[Closing paragraph]

Sincerely,
[Your Name]
```

### Customizing the Template

Edit `index.js` in the `createCustomCoverLetter` function to:
- Change fonts, sizes, colors
- Adjust margins and spacing
- Modify paragraph content
- Add or remove sections
- Change header layout

Example - Update contact information:

```javascript
const contactInfo = [
  'Email: your.email@example.com | Phone: (123) 456-7890',
  'LinkedIn: linkedin.com/in/yourname | Portfolio: yourwebsite.com',
];
```

### Email Content

Customize email subject and body in your `.env` file or they will be auto-generated based on the company details.

## Troubleshooting

### Common Issues

**Error: Resume file not found**
- Ensure the `RESUME_PATH` in `.env` points to the correct file
- Use absolute paths if relative paths don't work

**Error: Authentication failed**
- For Gmail, use an App Password, not your regular password
- Verify your SMTP credentials are correct
- Check if "Less secure app access" is enabled (for older email providers)

**Error: Connection refused**
- Verify SMTP host and port are correct
- Check if your firewall is blocking the connection
- For Gmail, use `smtp.gmail.com` with port `587`

### Email Provider Settings

**Gmail:**
- Host: `smtp.gmail.com`
- Port: `587` (or `465` with `SMTP_SECURE=true`)
- Requires App Password

**Outlook/Hotmail:**
- Host: `smtp.office365.com`
- Port: `587`

**Yahoo:**
- Host: `smtp.mail.yahoo.com`
- Port: `465` or `587`

## Security Notes

- ⚠️ **Never commit your `.env` file** to version control
- ⚠️ Use App Passwords instead of your main email password
- ⚠️ Keep your SMTP credentials secure
- ✅ The `.env` file is already in `.gitignore`

## Project Structure

```
resume-sending-app/
├── index.js                 # Main application - cover letter generator
├── apply.js                 # Interactive application tool
├── package.json             # Dependencies
├── .env                     # Your configuration (not in git)
├── .env.example            # Configuration template
├── companies.example.json   # Batch application template
├── .gitignore              # Git ignore rules
├── README.md               # This file
├── applications.log         # Application history (auto-generated)
├── Cover_Letter_Rishi_Samadhiya.pdf  # Your template
└── your_resume.pdf         # Your resume file
```

## How It Works

### Cover Letter Generation Process

1. **Template Analysis**: Reads your existing cover letter to extract page dimensions
2. **PDF Creation**: Creates a new PDF document with identical dimensions
3. **Content Customization**: 
   - Replaces company name in multiple places
   - Inserts position title
   - Adds your custom company-specific paragraph
   - Lists relevant skills for the role
   - Updates date to current date
4. **Formatting Preservation**: Uses same fonts, sizes, margins, and spacing
5. **Save & Send**: Saves the custom PDF and emails it

### Why This Approach?

- ✅ Each company gets a personalized cover letter
- ✅ No manual editing required
- ✅ Consistent professional formatting
- ✅ Easy to apply to dozens of companies quickly
- ✅ Full control over content customization

## Dependencies

- **pdf-lib**: PDF manipulation library that preserves formatting
- **nodemailer**: Email sending library
- **dotenv**: Environment variable management

## License

MIT

## Support

For issues or questions:
1. Check the Troubleshooting section
2. Verify your `.env` configuration
3. Ensure all dependencies are installed

---

**Made with ❤️ for job applications**
