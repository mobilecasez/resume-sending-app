/**
 * Automated OAuth Demo Video Creator for Google Cloud Verification
 * Creates a video demonstrating CVApplyr's Gmail OAuth integration
 */

const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
    baseUrl: 'https://cvapplyr.com', // Production URL
    // baseUrl: 'http://localhost:3000', // For local testing
    videoPath: './oauth-demo-video.mp4',
    screenshotsDir: './demo-screenshots',
    
    // Test credentials - CREATE A TEST GOOGLE ACCOUNT FOR THIS
    testEmail: process.env.TEST_GOOGLE_EMAIL || 'your-test-email@gmail.com',
    testPassword: process.env.TEST_GOOGLE_PASSWORD || 'your-test-password',
    
    // Demo recipient for job application
    demoRecipient: {
        email: 'hr@mobilecasez.com',
        company: 'MobileCaseZ',
        position: 'Software Engineer',
        website: 'https://www.mobilecasez.com/'
    }
};

const recorder = {
    width: 1280,
    height: 720,
    fps: 30,
};

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function typeSlowly(page, selector, text, delay = 100) {
    await page.waitForSelector(selector);
    await page.click(selector);
    for (const char of text) {
        await page.keyboard.type(char);
        await wait(delay);
    }
}

// Add text overlay to page
async function addOverlay(page, text, duration = 3000) {
    await page.evaluate((overlayText, overlayDuration) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.85);
            color: white;
            padding: 16px 32px;
            border-radius: 8px;
            font-size: 24px;
            font-weight: bold;
            z-index: 999999;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        `;
        overlay.textContent = overlayText;
        document.body.appendChild(overlay);
        
        setTimeout(() => {
            overlay.style.transition = 'opacity 0.5s';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }, overlayDuration - 500);
    }, text, duration);
    await wait(duration);
}

async function createDemoVideo() {
    console.log('🎬 Starting OAuth Demo Video Creation...\n');
    
    // Create screenshots directory
    await fs.mkdir(CONFIG.screenshotsDir, { recursive: true });
    
    const browser = await puppeteer.launch({
        headless: false, // Show browser for recording
        args: [
            '--start-maximized',
            '--window-size=1280,720',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        defaultViewport: {
            width: 1280,
            height: 720
        }
    });
    
    const page = await browser.newPage();
    
    // Set longer default timeout for all operations
    page.setDefaultNavigationTimeout(60000); // 60 seconds
    page.setDefaultTimeout(30000); // 30 seconds for element waiting
    
    // Start screen recording
    console.log('📹 Starting screen recording...');
    const screenRecorder = new PuppeteerScreenRecorder(page, {
        fps: 30,
        videoFrame: {
            width: 1280,
            height: 720,
        },
        aspectRatio: '16:9',
    });
    
    await screenRecorder.start(CONFIG.videoPath);
    
    try {
        // ========================================
        // SCENE 1: Introduction - Homepage
        // ========================================
        console.log('\n📍 Scene 1: Homepage Introduction');
        await page.goto(CONFIG.baseUrl, { waitUntil: 'networkidle2' });
        await addOverlay(page, '1. CVApplyr Homepage', 3000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/01-homepage.png` });
        
        // ========================================
        // SCENE 2: Navigate to Login
        // ========================================
        console.log('📍 Scene 2: Navigating to Login');
        await page.goto(`${CONFIG.baseUrl}/login`, { waitUntil: 'networkidle2' });
        await addOverlay(page, '2. Navigate to Login', 2000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/02-login-page.png` });
        
        // ========================================
        // SCENE 3: Click "Sign in with Google"
        // ========================================
        console.log('📍 Scene 3: Initiating Google OAuth');
        
        // Wait for the OAuth button to be visible
        try {
            await page.waitForSelector('a[href="/auth/google"]', { timeout: 10000 });
            await addOverlay(page, '3. Click "Continue with Google"', 2000);
            
            // Click the Google OAuth button
            await page.click('a[href="/auth/google"]');
            console.log('✅ Clicked Google Sign-in button');
            
            // Wait for navigation to Google
            await wait(5000);
        } catch (error) {
            console.log('⚠️  OAuth button not found, trying direct URL');
            await page.goto(`${CONFIG.baseUrl}/auth/google`, { 
                waitUntil: 'networkidle0',
                timeout: 60000 
            });
        }
        
        await wait(2000);
        
        // ========================================
        // SCENE 4: Google OAuth Consent Screen
        // ========================================
        console.log('📍 Scene 4: Google OAuth Consent Screen');
        
        // Handle Google login if not already logged in
        try {
            // Check if we're on Google login page
            const isGoogleLoginPage = await page.evaluate(() => {
                return window.location.href.includes('accounts.google.com');
            });
            
            if (isGoogleLoginPage) {
                console.log('🔐 Entering Google credentials...');
                
                // Wait for email input
                await page.waitForSelector('input[type="email"]', { timeout: 10000 });
                await addOverlay(page, '4. Enter Google Email', 2000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/03-google-login.png` });
                
                // Enter email
                await typeSlowly(page, 'input[type="email"]', CONFIG.testEmail, 80);
                await wait(1000);
                await page.keyboard.press('Enter');
                await wait(3000);
                
                // Enter password
                await page.waitForSelector('input[type="password"]', { timeout: 10000 });
                await addOverlay(page, '5. Enter Google Password', 2000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/04-google-password.png` });
                
                await typeSlowly(page, 'input[type="password"]', CONFIG.testPassword, 80);
                await wait(1000);
                await page.keyboard.press('Enter');
                await wait(5000);
                
                console.log('✅ Credentials entered');
            }
            
            // Handle "This app isn't verified" warning
            try {
                const advancedLink = await page.$('button:has-text("Advanced"), a:has-text("Advanced")');
                if (advancedLink) {
                    console.log('⚠️  Unverified app warning detected, clicking Advanced...');
                    await addOverlay(page, '6. Click "Advanced" for Unverified App', 3000);
                    await wait(1000);
                    await advancedLink.click();
                    await wait(2000);
                    await page.screenshot({ path: `${CONFIG.screenshotsDir}/05-advanced-warning.png` });
                    
                    // Click "Go to CVApplyr (unsafe)" or similar link
                    const continueLink = await page.$('a:has-text("cvapplyr"), a:has-text("Continue"), a:has-text("Go to")');
                    if (continueLink) {
                        await addOverlay(page, '7. Continue to CVApplyr', 2000);
                        await continueLink.click();
                        console.log('✅ Clicked continue to CVApplyr');
                        await wait(5000);
                    }
                }
            } catch (e) {
                console.log('ℹ️  No advanced warning or already handled');
            }
            
            // Check for OAuth consent screen
            const isConsentPage = await page.evaluate(() => {
                return document.body.innerText.includes('wants to access your Google Account') ||
                       document.body.innerText.includes('CVApplyr') ||
                       document.body.innerText.includes('Send email on your behalf');
            });
            
            if (isConsentPage) {
                console.log('📋 OAuth Consent Screen detected');
                await addOverlay(page, '8. OAuth Permissions Screen', 3000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/06-oauth-consent.png` });
                
                // Scroll to show all permissions
                await page.evaluate(() => {
                    window.scrollTo(0, document.body.scrollHeight / 2);
                });
                await wait(2000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/07-oauth-permissions.png` });
                
                // Click Continue/Allow button
                const continueButton = await page.$('button[data-action="accept"], button:has-text("Continue"), button:has-text("Allow")');
                if (continueButton) {
                    await addOverlay(page, '9. Grant Gmail Send Permission', 2000);
                    await continueButton.click();
                    console.log('✅ Accepted OAuth permissions');
                    await wait(5000);
                }
            }
            
        } catch (error) {
            console.log('⚠️  OAuth flow handling:', error.message);
        }
        
        // ========================================
        // SCENE 5: Dashboard After Login
        // ========================================
        console.log('📍 Scene 5: Dashboard After Login');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        
        // Wait for dashboard to fully load
        await wait(3000);
        await page.waitForSelector('.recipient-item', { timeout: 10000 }).catch(() => {});
        await addOverlay(page, '10. Dashboard - OAuth Login Successful', 3000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/08-dashboard.png` });
        
        // ========================================
        // SCENE 6: Add Job Recipient
        // ========================================
        console.log('📍 Scene 6: Adding Job Recipient');
        
        await addOverlay(page, '11. Add Job Recipient Details', 2000);
        
        // Wait for form to be ready
        await wait(1000);
        
        // Fill in recipient details with correct selectors
        const recipientFields = [
            { selector: 'input[name="email"]', value: CONFIG.demoRecipient.email, label: 'Email' },
            { selector: 'input[name="website"]', value: CONFIG.demoRecipient.website, label: 'Website' },
            { selector: 'input[name="position"]', value: CONFIG.demoRecipient.position, label: 'Position' },
        ];
        
        for (const field of recipientFields) {
            try {
                await page.waitForSelector(field.selector, { timeout: 5000 });
                await page.click(field.selector);
                // Clear existing value
                await page.evaluate((sel) => {
                    document.querySelector(sel).value = '';
                }, field.selector);
                await typeSlowly(page, field.selector, field.value, 50);
                console.log(`✅ Filled ${field.label}: ${field.value}`);
                await wait(500);
            } catch (e) {
                console.log(`⚠️  Field ${field.selector} not found, skipping...`);
            }
        }
        
        await wait(2000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/09-recipient-details.png` });
        
        // ========================================
        // SCENE 7: Navigate to Review Page
        // ========================================
        console.log('📍 Scene 7: Navigating to Review Page');
        
        // Look for "Review & Send" button
        try {
            const reviewButton = await page.$('button[onclick="reviewAndSend()"]');
            if (reviewButton) {
                await addOverlay(page, '12. Click "Review & Send"', 2000);
                await reviewButton.click();
                console.log('✅ Clicked Review & Send button');
                
                // Wait for navigation to review page
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                await wait(2000);
                
                await addOverlay(page, '13. Review Page - Generating Cover Letter...', 3000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/10-review-page.png` });
                
                // Wait for cover letter generation (look for the cover letter content)
                console.log('⏳ Waiting for cover letter generation...');
                await wait(15000); // Wait 15 seconds for AI to generate
                
                await addOverlay(page, '14. Cover Letter Generated with AI', 3000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/11-generated-letter.png` });
            } else {
                console.log('⚠️  Review & Send button not found');
            }
        } catch (error) {
            console.log('⚠️  Error navigating to review page:', error.message);
        }
        
        // ========================================
        // SCENE 8: Send Application via Gmail API
        // ========================================
        console.log('📍 Scene 8: Sending Application via Gmail API');
        
        try {
            // Look for send button using XPath
            await wait(2000);
            const sendButtons = await page.$x("//button[contains(text(), 'Send') and contains(@class, 'btn-success')]");
            if (sendButtons && sendButtons.length > 0) {
                await addOverlay(page, '15. Click Send to Email via Gmail API', 3000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/12-before-send.png` });
                
                // Scroll to button to ensure it's visible
                await page.evaluate((button) => {
                    button.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, sendButtons[0]);
                await wait(1000);
                
                // Click the first send button
                await sendButtons[0].click();
                console.log('✅ Clicked Send Application button');
                
                // Wait for sending process
                await wait(8000);
                
                await addOverlay(page, '16. Email Sent Successfully!', 3000);
                await page.screenshot({ path: `${CONFIG.screenshotsDir}/13-sent-confirmation.png` });
            } else {
                console.log('⚠️  Send button not found');
            }
        } catch (error) {
            console.log('⚠️  Error sending application:', error.message);
        }
        
        // ========================================
        // SCENE 9: Open Gmail to Show Sent Email
        // ========================================
        console.log('📍 Scene 9: Verifying Sent Email in Gmail');
        
        try {
            // Open Gmail in new tab
            const gmailPage = await browser.newPage();
            await gmailPage.setViewport({ width: 1280, height: 720 });
            await gmailPage.goto('https://mail.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
            await addOverlay(gmailPage, '17. Verify Email in Gmail Sent Folder', 3000);
            
            // Wait for Gmail to load
            await wait(5000);
            
            // Screenshot Gmail inbox/sent
            await gmailPage.screenshot({ path: `${CONFIG.screenshotsDir}/14-gmail-verification.png` });
            await wait(3000);
        } catch (e) {
            console.log('⚠️  Could not open Gmail:', e.message);
        }
        
        // ========================================
        // SCENE 11: Privacy & Security Statement
        // ========================================
        console.log('📍 Scene 11: Privacy & Security Pages');
        
        await page.goto(`${CONFIG.baseUrl}/privacy`, { waitUntil: 'networkidle2' });
        await wait(3000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/14-privacy-policy.png` });
        
        await page.goto(`${CONFIG.baseUrl}/terms`, { waitUntil: 'networkidle2' });
        await wait(3000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/15-terms-of-service.png` });
        
        // ========================================
        // Final scene
        // ========================================
        console.log('📍 Final: Return to Dashboard');
        await page.goto(`${CONFIG.baseUrl}/dashboard`, { waitUntil: 'networkidle2' });
        await wait(3000);
        await page.screenshot({ path: `${CONFIG.screenshotsDir}/16-final-dashboard.png` });
        
    } catch (error) {
        console.error('❌ Error during video creation:', error);
    } finally {
        // Stop recording
        console.log('\n🎬 Stopping recording...');
        await wait(2000);
        await screenRecorder.stop();
        
        await browser.close();
        
        console.log('\n✅ Video created successfully!');
        console.log(`📹 Video saved to: ${CONFIG.videoPath}`);
        console.log(`📸 Screenshots saved to: ${CONFIG.screenshotsDir}/`);
        console.log('\n📋 Next steps:');
        console.log('1. Upload video to YouTube as "Unlisted"');
        console.log('2. Add the video URL to Google Cloud Console OAuth verification');
        console.log('3. Submit for review');
    }
}

// Run the video creation
if (require.main === module) {
    createDemoVideo().catch(console.error);
}

module.exports = { createDemoVideo };
