const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const jobService = require('../services/jobService');
const dbConfig = require('../../db-config');
const { executeGenerationWork } = require('../controllers/coverLetterController');
const { executeSendWork } = require('../controllers/emailController');
const { regionFromCountry, regionFromTld } = require('../utils/regionFromCountry');

/**
 * POST /api/batch-process
 * Starts a server-side batch job that processes all recipients.
 * 
 * Body: {
 *   recipients: [{ email, website, position }],
 *   mode: 'generate' | 'send' | 'generate-and-send',
 *   coverLetters: { "0": { coverLetterHtml, companyName, address, ... }, ... }  // required for 'send' mode
 * }
 * 
 * Returns 202 { jobId, status: 'pending' }
 */
router.post('/batch-process', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients, mode, coverLetters } = req.body;

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ error: 'Recipients array is required' });
        }

        if (!['generate', 'send', 'generate-and-send'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode. Must be generate, send, or generate-and-send' });
        }

        // For 'send' mode, coverLetters must be provided
        if (mode === 'send' && (!coverLetters || Object.keys(coverLetters).length === 0)) {
            return res.status(400).json({ error: 'coverLetters required for send mode' });
        }

        // Validate user exists and has credits
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Filter valid recipients (must have email + website)
        const validRecipients = recipients
            .map((r, i) => ({ ...r, originalIndex: i }))
            .filter(r => r.email && r.website);

        if (validRecipients.length === 0) {
            return res.status(400).json({ error: 'No valid recipients (email + website required)' });
        }

        // Create batch job
        const jobId = await jobService.createJob(userId, `batch_${mode}`, {
            recipients: validRecipients,
            mode,
            coverLetters: coverLetters || {}
        });

        // Return 202 immediately
        res.status(202).json({ jobId, status: 'pending' });

        // Fire and forget — process in background
        processBatchJob(jobId, userId, user, validRecipients, mode, coverLetters || {}).catch(err => {
            console.error(`Batch job ${jobId} fatal error:`, err);
            jobService.failJob(jobId, err.message).catch(console.error);
        });

    } catch (error) {
        console.error('Error starting batch job:', error);
        res.status(500).json({ error: 'Failed to start batch process' });
    }
});

/**
 * Process an entire batch job server-side.
 * Updates job progress and result as each recipient is processed.
 */
async function processBatchJob(jobId, userId, user, validRecipients, mode, coverLetters) {
    await jobService.startJob(jobId);

    let completedSteps = 0;
    let generatesDone = 0;
    let sendsDone = 0;
    const totalRecipients = validRecipients.length;
    const results = {};

    // Helper to update progress — weighted so generation gets ~92% and sending ~8%
    const GENERATE_WEIGHT = 0.92;
    const SEND_WEIGHT = 0.08;
    const updateProgress = async () => {
        let pct;
        if (mode === 'generate-and-send') {
            pct = Math.round(
                (generatesDone / totalRecipients) * GENERATE_WEIGHT * 100 +
                (sendsDone / totalRecipients) * SEND_WEIGHT * 100
            );
        } else {
            pct = Math.round((completedSteps / totalRecipients) * 100);
        }
        await jobService.updateJobProgress(jobId, Math.min(pct, 99));
    };

    // Store generated cover letters for generate-and-send mode
    const generatedCoverLetters = {};

    const GENERATE_CONCURRENCY = Math.max(1, Math.min(parseInt(process.env.BATCH_GENERATE_CONCURRENCY || '3', 10), 6));

    // Small worker-pool helper for safe bounded parallelism
    const processWithConcurrency = async (items, limit, worker) => {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (true) {
                const current = cursor++;
                if (current >= items.length) break;
                await worker(items[current]);
            }
        });
        await Promise.all(workers);
    };

    // ---- GENERATE phase ----
    if (mode === 'generate' || mode === 'generate-and-send') {
        console.log(`[Batch ${jobId}] Starting parallel generation with concurrency=${GENERATE_CONCURRENCY}`);

        await processWithConcurrency(validRecipients, GENERATE_CONCURRENCY, async (recipient) => {
            const idx = recipient.originalIndex;
            try {
                console.log(`[Batch ${jobId}] Generating for recipient ${idx}: ${recipient.email}`);
                const genResult = await executeGenerationWork(userId, user, {
                    recipientEmail: recipient.email,
                    websiteUrl: recipient.website,
                    position: recipient.position || ''
                });

                generatedCoverLetters[idx] = genResult;
                results[idx] = { ...(results[idx] || {}), generated: true, generationData: genResult };
            } catch (err) {
                console.error(`[Batch ${jobId}] Error generating recipient ${idx}:`, err.message);
                results[idx] = {
                    ...(results[idx] || {}),
                    generated: false,
                    error: err.message
                };
            } finally {
                completedSteps++;
                generatesDone++;
                await updateProgress();
            }
        });
    }

    // ---- SEND phase ----
    if (mode === 'send' || mode === 'generate-and-send') {
        for (const recipient of validRecipients) {
            const idx = recipient.originalIndex;

            try {
                // Use generated cover letter or the one provided by client
                const cl = generatedCoverLetters[idx] || coverLetters[String(idx)];

                if (!cl || !cl.coverLetterHtml) {
                    results[idx] = {
                        ...(results[idx] || {}),
                        sent: false,
                        sendError: 'No cover letter available'
                    };
                    completedSteps++;
                    sendsDone++;
                    await updateProgress();
                    continue;
                }

                // Build address from locations array (same logic as client)
                let companyAddress = cl.address || cl.companyAddress || '';
                if (!companyAddress && cl.locations && cl.locations.length > 0) {
                    const hq = cl.locations.find(loc => loc.isHeadquarters) || cl.locations[0];
                    if (hq) {
                        let addr = hq.address || '';
                        const city = hq.city || '';
                        const country = hq.country || '';
                        if (!addr || addr === 'Address not available online') {
                            const parts = [];
                            if (city && city !== 'Not specified') parts.push(city);
                            if (country && country !== 'Not specified') parts.push(country);
                            companyAddress = parts.join(', ') || '';
                        } else {
                            companyAddress = addr;
                            if (city && city !== 'Not specified' && !addr.toLowerCase().includes(city.toLowerCase())) {
                                companyAddress += ', ' + city;
                            }
                            if (country && country !== 'Not specified' && !companyAddress.toLowerCase().includes(country.toLowerCase())) {
                                companyAddress += ', ' + country;
                            }
                        }
                    }
                }

                // Region: honour the per-recipient choice from the client ('send' mode),
                // else auto-detect from the employer address (covers 'generate-and-send').
                // Address first; if that yields 'generic', fall back to the website/email ccTLD
                // (always available — .nl→eu, .de→dach, .in→india…) so a missing/placeholder address
                // doesn't silently send the GENERIC template.
                const tldRegion = regionFromTld(recipient.website || recipient.email || '');
                const coverLetterRegion = cl.coverLetterRegion || ((r) => r === 'generic' ? tldRegion : r)(regionFromCountry(companyAddress));
                const resumeRegion      = cl.resumeRegion      || ((r) => r === 'generic' ? tldRegion : r)(regionFromCountry(companyAddress));

                console.log(`[Batch ${jobId}] Sending for recipient ${idx}: ${recipient.email} (address: ${companyAddress}, region: ${coverLetterRegion})`);
                const sendResult = await executeSendWork(userId, {
                    recipientEmail: recipient.email,
                    websiteUrl: recipient.website,
                    position: recipient.position || '',
                    coverLetterText: cl.coverLetterHtml,
                    companyName: cl.companyName || '',
                    companyAddress: companyAddress,
                    coverLetterRegion,
                    resumeRegion
                });

                results[idx] = {
                    ...(results[idx] || {}),
                    sent: true,
                    sendData: sendResult
                };
            } catch (err) {
                console.error(`[Batch ${jobId}] Error sending recipient ${idx}:`, err.message);
                results[idx] = {
                    ...(results[idx] || {}),
                    sent: false,
                    sendError: err.message
                };
            } finally {
                completedSteps++;
                sendsDone++;
                await updateProgress();
            }
        }
    }

    // Summarize
    const summary = {
        mode,
        totalRecipients: validRecipients.length,
        results
    };

    if (mode === 'generate' || mode === 'generate-and-send') {
        summary.generatedCount = Object.values(results).filter(r => r.generated).length;
    }
    if (mode === 'send' || mode === 'generate-and-send') {
        summary.sentCount = Object.values(results).filter(r => r.sent).length;
    }

    await jobService.completeJob(jobId, summary);
    console.log(`[Batch ${jobId}] Completed. Generated: ${summary.generatedCount || 0}, Sent: ${summary.sentCount || 0}`);
}

module.exports = router;
