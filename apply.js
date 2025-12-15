#!/usr/bin/env node

/**
 * Interactive Application Sender
 * 
 * This script helps you quickly apply to multiple companies by
 * prompting for company-specific details.
 */

const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║   Interactive Job Application Sender                 ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  
  try {
    // Get company details
    const companyName = await question('Company Name: ');
    const position = await question('Position: ');
    const recipientEmail = await question('Recipient Email: ');
    const recipientName = await question('Recipient Name (default: Hiring Manager): ') || 'Hiring Manager';
    
    console.log('\n');
    const companyParagraph = await question('Why this company? (1-2 sentences): ');
    const relevantSkills = await question('Relevant skills to highlight: ');
    
    // Confirmation
    console.log('\n📋 Application Summary:');
    console.log('═══════════════════════════════════════');
    console.log(`Company:     ${companyName}`);
    console.log(`Position:    ${position}`);
    console.log(`Email:       ${recipientEmail}`);
    console.log(`Recipient:   ${recipientName}`);
    console.log('═══════════════════════════════════════\n');
    
    const confirm = await question('Send application? (yes/no): ');
    
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Application cancelled.\n');
      rl.close();
      return;
    }
    
    // Create temporary .env file
    const envContent = `COMPANY_NAME=${companyName}
POSITION=${position}
RECIPIENT_EMAIL=${recipientEmail}
RECIPIENT_NAME=${recipientName}
COMPANY_PARAGRAPH=${companyParagraph}
RELEVANT_SKILLS=${relevantSkills}

# Load other settings from main .env
${fs.existsSync('.env') ? fs.readFileSync('.env', 'utf-8') : ''}`;
    
    fs.writeFileSync('.env.temp', envContent);
    
    // Run the main application
    console.log('\n🚀 Sending application...\n');
    
    try {
      // Use the temp env file
      const env = { ...process.env };
      const envVars = envContent.split('\n')
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .reduce((acc, line) => {
          const [key, ...valueParts] = line.split('=');
          acc[key.trim()] = valueParts.join('=').trim();
          return acc;
        }, {});
      
      Object.assign(env, envVars);
      
      execSync('node index.js', { 
        stdio: 'inherit',
        env 
      });
      
      console.log('\n✅ Application sent successfully!\n');
      
      // Log to history
      const historyEntry = `${new Date().toISOString()} | ${companyName} | ${position} | ${recipientEmail}\n`;
      fs.appendFileSync('applications.log', historyEntry);
      
    } catch (error) {
      console.error('\n❌ Error sending application:', error.message);
    } finally {
      // Clean up temp file
      if (fs.existsSync('.env.temp')) {
        fs.unlinkSync('.env.temp');
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
  
  rl.close();
}

main();
