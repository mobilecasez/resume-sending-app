# 📋 Application Flow Documentation

## Two-Step Send Process

Your application now uses a **review-before-send** workflow that gives you complete control over what gets sent to employers.

---

## The Complete Flow

### 🎯 Step 1: Generate Cover Letters

**What Happens:**
1. User fills in recipient information:
   - Email address
   - Company website (optional)
   - Position applying for

2. User clicks **"Review & Send"** or **"Send Now"**

3. Frontend calls `/api/generate-cover-letters`

4. Backend process:
   ```javascript
   For each recipient:
     ├─ Extract resume text and parse data
     ├─ Scrape company website (if provided)
     ├─ Match skills with company needs
     ├─ Generate cover letter (AI or template)
     ├─ Create PDF with photo & signature
     ├─ Save to temp/ folder
     └─ Return download URL
   ```

5. Frontend displays modal with:
   - Company name and details
   - Download button for each PDF
   - Metadata (AI used?, skills found, etc.)
   - "Send All Emails" button

---

### ✅ Step 2: Review & Send

**What Happens:**
1. User reviews generated cover letters:
   - Downloads PDFs to read
   - Verifies information is correct
   - Checks that content is natural

2. User clicks **"Send All Emails"** (or closes modal to send later)

3. Frontend calls `/api/send-applications` with:
   ```javascript
   recipients = [
     {
       email: "hr@company.com",
       website: "https://company.com",
       position: "Software Engineer",
       fileName: "CoverLetter_1234567890_CompanyName.pdf" // Pre-generated
     }
   ]
   ```

4. Backend process:
   ```javascript
   For each recipient:
     ├─ Check if fileName exists in recipient object
     ├─ Use pre-generated PDF from temp/ folder
     ├─ Skip cover letter generation (already done!)
     ├─ Attach pre-generated cover letter
     ├─ Attach resume
     ├─ Send email with professional template
     └─ Clean up temp file after send
   ```

5. User receives success confirmation

---

## Key Features

### ✨ Benefits

1. **Review Before Send**
   - See exactly what employers receive
   - Download and keep copies
   - Fix any issues before sending

2. **No Surprises**
   - Preview all content
   - Verify company information
   - Check AI-generated text

3. **Flexibility**
   - Generate now, send later
   - Close modal and come back
   - PDFs saved in temp folder

4. **Efficiency**
   - Generate once, use multiple times
   - No re-generation on send
   - Faster email sending

### 🔧 Technical Details

**Endpoints:**
- `POST /api/generate-cover-letters` - Generates PDFs, returns download URLs
- `GET /api/download-cover-letter/:filename` - Serves PDF for download
- `POST /api/send-applications` - Sends emails with pre-generated PDFs

**File Storage:**
- Generated PDFs: `/temp/CoverLetter_[timestamp]_[company].pdf`
- Temporary storage until sent
- Auto-cleanup after successful send
- Persist if modal closed (send later)

**Data Flow:**
```
User Input → Generate → Save to temp/ → Show Downloads → User Reviews → Send
     ↓            ↓           ↓              ↓                ↓           ↓
Recipients   AI/Template   PDFs saved   Modal shown    User approves  Email sent
```

---

## Error Handling

### Generation Fails
- Show error message in modal
- Don't show download links for failed generations
- Allow user to retry

### Pre-generated File Missing
- Backend checks file exists before sending
- Error: "Pre-generated cover letter not found. Please regenerate."
- User must regenerate before sending

### Send Fails
- Keep PDF in temp folder
- Show error message
- User can retry send without regenerating

---

## Backward Compatibility

The system maintains backward compatibility:

```javascript
// New way (with pre-generated PDFs)
if (recipient.fileName) {
    // Use pre-generated file from temp/
    filePath = path.join(__dirname, 'temp', recipient.fileName);
}
// Old way (generate on the fly)
else {
    // Generate cover letter now
    // Create PDF now
    // Then send
}
```

This ensures the system works even if `fileName` is not provided.

---

## User Experience

### Before (Old Flow)
```
Click Send → Wait... → Email Sent
              ↑
        (No way to review!)
```

### After (New Flow)
```
Click Send → Generate → Review Downloads → Approve → Email Sent
                          ↓
                    User has control!
```

---

## Files Modified

1. **server.js**
   - Added `/api/generate-cover-letters` endpoint
   - Added `/api/download-cover-letter/:filename` endpoint
   - Modified `/api/send-applications` to use pre-generated PDFs

2. **public/index.html**
   - Created `generateCoverLetters()` function
   - Created `showCoverLetterResults()` modal function
   - Created `sendEmailsWithCoverLetters()` function
   - Modified `reviewAndSend()` and `sendNow()` to call generate first

3. **AI_FEATURES.md**
   - Updated usage section
   - Added two-step process documentation
   - Added "Why Two Steps?" explanation

---

## Testing Checklist

- [ ] Add recipient with email, website, position
- [ ] Click "Review & Send"
- [ ] Verify modal appears with download link
- [ ] Click download and verify PDF content
- [ ] Check metadata is displayed correctly
- [ ] Click "Send All Emails"
- [ ] Verify email sent successfully
- [ ] Check temp file cleaned up after send
- [ ] Test closing modal without sending
- [ ] Verify can send later with same PDFs
- [ ] Test error handling (missing file, send failure)

---

## Future Enhancements

### Possible Improvements
1. **Editing**: Allow editing cover letters before sending
2. **Templates**: Save favorite templates for reuse
3. **History**: Keep sent cover letters in database
4. **Analytics**: Track open rates, response rates
5. **Scheduling**: Schedule emails for specific times
6. **Bulk Actions**: Select specific recipients to send
7. **Preview Modal**: Show PDF preview in modal (iframe)
8. **Temp Cleanup**: Cron job to clean old temp files

---

## Conclusion

The two-step flow provides users with **control**, **transparency**, and **peace of mind** when sending job applications. No more wondering what employers received - you see it first!
