const fs = require('fs');
const path = require('path');
const dbConfig = require('../../db-config');
const { notifyProfileUpdated } = require('./notificationsController');
const resumeParser = require('../../services/resumeParserService');   // read at call time, so a suite can swap it
const { vetUploadedResume } = require('../utils/resumeFile');   // the one "can we read this CV?" gate, shared with server.js
const onboarding = require('../services/onboardingProgress');
const { emit } = require('../services/track');   // first-party analytics

const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

/**
 * A stored path is only worth reporting if the file is actually there.
 *
 * Rows can outlive their files: account deletion removes uploads/user_<id>/ from disk, and until
 * this was fixed it left the three path columns set, so signing back in produced a live user whose
 * profile pointed at deleted files. Rather than trust the column, stat it.
 *
 * Returns the relative path when the file is present, otherwise null. Anything resolving outside the
 * uploads root is refused — a stored path is user-influenced data, not a licence to read the disk.
 */
function livePath(rel) {
    const p = String(rel || '').trim();
    if (!p) return null;
    const abs = path.resolve(process.cwd(), p);
    if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) return null;
    try { return fs.statSync(abs).isFile() ? p : null; } catch { return null; }
}

/**
 * Record an upload ONLY once its bytes are durably on disk.
 *
 * multer has already written the file by the time a handler runs, but "written" is not "durable" and
 * a failed UPDATE would leave an orphan file. Sync the file, then write the row; if the row fails,
 * remove the file. The caller's catch turns any throw into a 500, so the client sees a real failure
 * instead of a green tick over a file that is not there.
 */
async function commitUpload(req, column, userId) {
    const abs = path.resolve(req.file.path);
    if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
        throw new Error('Upload landed outside the uploads directory');
    }
    const fh = await fs.promises.open(abs, 'r');
    try {
        const st = await fh.stat();
        if (!st.isFile() || st.size === 0) throw new Error('Uploaded file is empty');
        await fh.sync();                       // on the volume before the database hears about it
    } finally {
        await fh.close();
    }

    const rel = path.relative(process.cwd(), abs);
    try {
        await dbConfig.run(`UPDATE users SET ${column} = ? WHERE id = ?`, [rel, userId]);
    } catch (e) {
        await fs.promises.unlink(abs).catch(() => {});   // no row -> don't leave the file behind
        throw e;
    }
    return rel;
}

/** A stored date of birth as YYYY-MM-DD, or null. */
function dobOf(v) {
    if (!v) return null;
    // 'en-CA' gives YYYY-MM-DD format without timezone conversion
    return new Date(v).toLocaleDateString('en-CA');
}

/**
 * First-run setup completeness — drives the onboarding "Getting Started" checklist.
 * profile = the basics filled beyond signup defaults (phone/address/DOB).
 * ⚠️ ONE RULE for the checklist (HelpAssistant, journey.js, the coach). The Make Yours wizard is closed by its OWN
 * fields instead (onboardingProgress.profileCompleteOf, fed by wizardInputsForUser below) — this rule also wants a
 * date of birth, a photo and a signature, which the wizard calls optional (review, 2026-09-19).
 * Takes paths already passed through livePath.
 */
function setupOf({ phone, address, dob, photoPath, resumePath, signaturePath }) {
    const setup = {
        profile: !!(phone && address && dob),
        resume: !!resumePath,
        photo: !!photoPath,
        signature: !!signaturePath,
    };
    setup.complete = setup.profile && setup.resume && setup.photo && setup.signature;
    return setup;
}

/**
 * What onboardingProgress.stateFor reads about the profile: the typed fields, which files are really on disk, and the
 * CV's extension and upload time. Paths already passed through livePath. getProfile and wizardInputsForUser share it,
 * so the wizard state a profile read shows and the one Account Settings is closed on are the same answer.
 */
function wizardInputsOf({ fullName, phone, address, photoPath, signaturePath, resumePath }) {
    let cv = null;
    if (resumePath) {
        try {
            const st = fs.statSync(path.resolve(process.cwd(), resumePath));
            cv = { ext: (path.extname(resumePath).slice(1) || '').toUpperCase() || null, uploadedAt: st.mtime.toISOString() };
        } catch { cv = { ext: null, uploadedAt: null }; }
    }
    return {
        profile: { fullName, phone, address },
        files: { photo: !!photoPath, signature: !!signaturePath, resume: !!resumePath },
        cv,
    };
}

/** wizardInputsOf for a user id, read fresh. null when there is no such user. */
async function wizardInputsForUser(userId) {
    const u = await dbConfig.get('SELECT full_name, phone_number, address, photo_path, resume_path, signature_path FROM users WHERE id = ?', [userId]);
    if (!u) return null;
    return wizardInputsOf({
        fullName: u.full_name, phone: u.phone_number, address: u.address,
        photoPath: livePath(u.photo_path), signaturePath: livePath(u.signature_path), resumePath: livePath(u.resume_path),
    });
}

// Get user profile data
const getProfile = async (req, res) => {
    const userId = req.user.id;

    try {
        const user = await dbConfig.get('SELECT full_name as "fullName", email, resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath", phone_number as "phoneNumber", address, date_of_birth as "dateOfBirth", gender, created_at as "createdAt", oauth_provider as "oauthProvider" FROM users WHERE id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Format DOB as date-only string using toLocaleDateString to avoid timezone shifts
        const formattedDOB = dobOf(user.dateOfBirth);

        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;

        // ⚠️ A PATH IN THE DATABASE IS NOT PROOF OF A FILE. Handing back a URL for a file that is not
        // on disk gives the app a permanently broken image with no way to recover — the user cannot
        // tell whether they ever uploaded, and the checklist says "done". Treat a missing file as an
        // empty slot so the app simply asks for it again.
        const photoPath = livePath(user.photoPath);
        const resumePath = livePath(user.resumePath);
        const signaturePath = livePath(user.signaturePath);

        const setup = setupOf({ phone: user.phoneNumber, address: user.address, dob: formattedDOB, photoPath, resumePath, signaturePath });

        // ⚠️ THE WIZARD'S OWN PROGRESS, ADDED — never replacing a key above (HelpAssistant, journey.js and the
        // activation coach read profile/resume/photo/signature/complete). null on any failure = today's Home.
        // See server/services/onboardingProgress.js for why the files alone were not enough (2026-09-19).
        setup.wizard = await onboarding.stateFor(userId, wizardInputsOf({
            fullName: user.fullName, phone: user.phoneNumber, address: user.address, photoPath, signaturePath, resumePath,
        }));

        res.json({
            fullName: user.fullName,
            email: user.email,
            phone: user.phoneNumber,
            address: user.address,
            dateOfBirth: formattedDOB,
            gender: user.gender || '',
            profileImage: photoPath ? `${baseUrl}/${photoPath}` : null,
            resume: resumePath ? `${baseUrl}/${resumePath}` : null,
            signature: signaturePath ? `${baseUrl}/${signaturePath}` : null,
            createdAt: user.createdAt,
            oauth_provider: user.oauthProvider || null,
            setup,
            // Whether the uploaded CV has been READ yet ('done' | 'pending' | 'slow' | 'error' | 'unread'), and the
            // sentence to show when it cannot be. null when there is no CV on disk (or the wizard state was unreadable).
            resumeParse: setup.wizard && setup.wizard.cv ? { status: setup.wizard.cv.status, error: setup.wizard.cv.error } : null,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

// Upload profile image
const uploadProfileImage = async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = await commitUpload(req, 'photo_path', userId);
        emit(req, 'photo_uploaded');
        await onboarding.afterProfileWrite(req, userId);   // never throws

        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        res.json({
            success: true,
            message: 'Profile image uploaded successfully',
            path: `${baseUrl}/${filePath}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Upload resume
const uploadResume = async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // ⚠️ CHECKED BEFORE IT IS COMMITTED (2026-09-19). This used to save ANY file as the résumé and only then
        // find out, in the background, whether it could be read — so a .docx replaced a good PDF and failed
        // silently. What the bytes ARE decides (iOS hands a .docx over as application/octet-stream, and a renamed
        // file is still what its bytes say): a format services/resumeText.js cannot read is refused here, the
        // file is removed, and the CV already on file stays exactly as it was.
        // ⚠️ ONE GATE, shared with the website's /api/upload-profile (server/utils/resumeFile.vetUploadedResume): it
        // refuses what cannot be read, removes the file, and stores what can under its REAL extension.
        const vetted = await vetUploadedResume(req.file.path);
        if (!vetted.ok) {
            console.warn(`[profile] résumé upload refused for user ${userId} (${vetted.fmt.reason}) — "${req.file.originalname}"; the CV on file is unchanged`);
            return res.status(vetted.status).json(vetted.body);
        }
        const fmt = vetted.fmt;
        req.file.path = vetted.path;

        const filePath = await commitUpload(req, 'resume_path', userId);
        emit(req, 'resume_uploaded', { format: fmt.kind });

        // ⚠️ 'pending' BEFORE THE ANSWER. The background parse used to be the first to say so, a moment after this
        // response — so a build tapped straight after a re-upload read the PREVIOUS CV's 'done' row as this one's.
        try { await resumeParser.markParsePending(userId); }
        catch (e) { console.warn(`[profile] could not mark user ${userId}'s new CV as being read:`, e.message); }
        // Run resume metadata extraction in the background without delaying the upload response.
        resumeParser.triggerResumeParsingBackground(userId, filePath);
        await onboarding.afterProfileWrite(req, userId);   // never throws

        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        res.json({
            success: true,
            message: 'Resume uploaded successfully',
            path: `${baseUrl}/${filePath}`,
            format: fmt.label,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Upload signature
const uploadSignature = async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = await commitUpload(req, 'signature_path', userId);
        emit(req, 'signature_uploaded');
        await onboarding.afterProfileWrite(req, userId);   // never throws

        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${protocol}://${req.get('host')}`;
        res.json({
            success: true,
            message: 'Signature uploaded successfully',
            path: `${baseUrl}/${filePath}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Update user profile data
const updateProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const { fullName, phone, address, dateOfBirth, email, gender } = req.body;

        const updates = [];
        const params = [];

        if (fullName) {
            updates.push('full_name = ?');
            params.push(fullName);
        }
        if (email) {
            // Basic email validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ error: 'Invalid email format' });
            }
            // Don't allow setting a private relay email
            if (email.includes('privaterelay.appleid.com')) {
                return res.status(400).json({ error: 'Please provide your real email address, not the Apple private relay' });
            }
            updates.push('email = ?');
            params.push(email);
        }
        if (phone) {
            updates.push('phone_number = ?');
            params.push(phone);
        }
        if (address) {
            updates.push('address = ?');
            params.push(address);
        }
        if (dateOfBirth) {
            // THE NOON TRICK: Set time to 12:00 PM to prevent midnight timezone shifts
            const date = new Date(dateOfBirth);
            date.setHours(12, 0, 0, 0);
            
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const dateOnly = `${year}-${month}-${day}`;
            
            updates.push('date_of_birth = ?');
            params.push(dateOnly);
        }
        if (gender !== undefined) {
            // Used (with the user's consent) to auto-fill pronoun/gender questions on job forms.
            // Only three allowed values; '' clears it. Anything else is rejected.
            const allowed = ['Male', 'Female', 'Prefer Not to Say', ''];
            if (!allowed.includes(gender)) {
                return res.status(400).json({ error: 'Invalid gender value' });
            }
            updates.push('gender = ?');
            params.push(gender === '' ? null : gender);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(userId);
        const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

        await dbConfig.run(sql, params);

        // Create notification for profile update
        try {
            const fieldsUpdated = [];
            if (fullName) fieldsUpdated.push('Name');
            if (phone) fieldsUpdated.push('Phone');
            if (address) fieldsUpdated.push('Address');
            if (dateOfBirth) fieldsUpdated.push('Date of Birth');
            if (gender !== undefined) fieldsUpdated.push('Gender');
            await notifyProfileUpdated(userId, fieldsUpdated);
        } catch (notifError) {
            console.error('Failed to create notification:', notifError);
        }

        emit(req, 'profile_updated', { fields: updates.length });
        await onboarding.afterProfileWrite(req, userId);   // never throws

        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: error.message });
    }
};

/**
 * POST /users/profile/onboarding — what the wizard knows that no profile column holds (2026-09-19):
 *   { notes?, lane?: 'write' | 'upload', skipped?: { photo?, signature? }, readCv?: true }
 * Typed notes used to live only in the screen (and in the one generate-ai request), so reopening the wizard
 * lost them; a skip was never recorded, so "Skip for now" was forgotten by the next launch. `readCv` asks for a
 * CV on disk that has never been read (an upload from before the parser, or one whose row is gone) to be read.
 * Answers with the fresh wizard state — the same object GET /users/profile carries as setup.wizard.
 */
const saveOnboarding = async (req, res) => {
    try {
        const userId = req.user.id;
        const b = req.body || {};
        // ⚠️ Only something the user WROTE opens the wizard's row (review, 2026-09-19). The wizard asks for an unread CV
        // to be read the moment it opens; that request alone must not turn "opened it and closed it" — or a profile
        // already completed in Account Settings — into "Pick up where you left off".
        const wrote = typeof b.notes === 'string' || b.lane === 'write' || b.lane === 'upload' || !!(b.skipped && typeof b.skipped === 'object');
        if (wrote) {
            await onboarding.touch(userId, {
                notes: typeof b.notes === 'string' ? b.notes : undefined,
                lane: b.lane,
                skipped: b.skipped && typeof b.skipped === 'object' ? b.skipped : undefined,
            });
        }
        if (b.readCv === true) {
            const u = await dbConfig.get('SELECT resume_path FROM users WHERE id = ?', [userId]);
            const rel = u && livePath(u.resume_path);
            const meta = rel ? await dbConfig.get('SELECT parse_status FROM resume_metadata WHERE user_id = ?', [userId]).catch(() => null) : null;
            if (rel && (!meta || (meta.parse_status !== 'pending' && meta.parse_status !== 'done'))) {
                await resumeParser.markParsePending(userId).catch(() => {});
                resumeParser.triggerResumeParsingBackground(userId, rel);
            }
        }
        const snap = { json: null };
        await getProfile(req, { status() { return this; }, json(v) { snap.json = v; return this; } });
        res.json({ success: true, wizard: (snap.json && snap.json.setup && snap.json.setup.wizard) || null });
    } catch (error) {
        console.error('Onboarding progress error:', error);
        res.status(500).json({ error: 'We could not save your progress. Please try again.' });
    }
};

// Privacy settings
const updatePrivacySettings = (req, res) => {
    try {
        const userId = req.user.id;
        const { emailNotifications, smsNotifications, profilePublic } = req.body;

        // Store privacy settings as JSON in the database
        // For now, we'll just return success as these settings can be stored in a future update
        const privacySettings = {
            emailNotifications,
            smsNotifications,
            profilePublic
        };

        // In the future, add a privacy_settings column to users table and save there
        // For now, just acknowledge receipt and store in session/memory if needed
        res.json({
            success: true,
            message: 'Privacy settings updated successfully',
            privacySettings: privacySettings
        });
    } catch (error) {
        console.error('Privacy settings error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    // Exported so the journey service can apply the SAME "is this file really on disk" rule.
    // A second copy of it is how one surface ends up saying "done" while the other asks again.
    livePath,
    // The checklist's completeness rule.
    setupOf,
    // What onboardingProgress closes the wizard on, for a user id (its own fields — see closeIfCompletedElsewhere).
    wizardInputsForUser,
    getProfile,
    uploadProfileImage,
    uploadResume,
    uploadSignature,
    updateProfile,
    saveOnboarding,
    updatePrivacySettings
};
