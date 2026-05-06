// AI Hub — new feature. Safe to delete without affecting existing app.

/**
 * POST /api/ai-hub/analyze-wishlist
 * Body: { companies: string[] }
 *
 * TODO: Call OpenAI to research each company's careers page, scrape open roles,
 *       score them against the user's stored resume using LLM similarity, and
 *       persist results to the ai_hub_jobs table keyed by user_id.
 */
async function analyzeWishlist(req, res) {
    try {
        const { companies } = req.body;

        if (!Array.isArray(companies) || companies.length === 0) {
            return res.status(400).json({ error: 'companies must be a non-empty array' });
        }

        // Mock response — replace with real AI analysis pipeline
        return res.json({
            matches: companies.length * 3,
            sources: companies.length,
        });
    } catch (error) {
        console.error('[aiHubController] analyzeWishlist error:', error);
        return res.status(500).json({ error: 'Failed to analyze wishlist' });
    }
}

// Deterministic logo colour from company name initial
const LOGO_COLORS = [
    ['#06B6D4', '#3B82F6'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EF4444', '#DC2626'],
    ['#635BFF', '#4338CA'],
    ['#EC4899', '#DB2777'],
];

function parseCompanyInput(input) {
    let companyName = input;
    let domain = input;
    let subInfo = `${input} · Careers Portal`;

    try {
        const urlStr = input.startsWith('http') ? input : `https://${input}`;
        const url = new URL(urlStr);
        domain = url.hostname.replace(/^www\./, '');

        // Strip common prefixes like "jobs.", "careers.", "jobsat"
        const cleanDomain = domain
            .replace(/^(jobs\.|careers\.|jobsat)/, '');

        // Derive company name from first segment of domain
        const baseName = cleanDomain.split('.')[0];
        companyName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        subInfo = `${domain} · Careers Portal`;
    } catch {
        // Not a URL — treat as plain company name
    }

    const colorIndex = companyName.charCodeAt(0) % LOGO_COLORS.length;
    return { companyName, domain, subInfo, logoColor: LOGO_COLORS[colorIndex] };
}

/**
 * GET /api/ai-hub/jobs?company={companyName|URL}
 *
 * TODO: Query the ai_hub_jobs table for jobs belonging to this user and
 *       company. If stale (>24h), re-trigger the scrape/LLM pipeline and
 *       return the refreshed data.
 */
async function getJobMatches(req, res) {
    try {
        const { company } = req.query;

        if (!company) {
            return res.status(400).json({ error: 'company query parameter is required' });
        }

        const { companyName, domain, subInfo, logoColor } = parseCompanyInput(company);

        // TODO: replace with real DB query + scrape pipeline
        const jobs = [
            {
                id: `${domain}-job-1`,
                title: `Software Engineer`,
                location: 'Remote',
                experience: '3–5 years',
                salary: '$120K–$160K',
                jobType: 'Full-time',
                urgent: false,
                skills: ['JavaScript', 'TypeScript', 'React', 'Node.js'],
                contacts: [
                    {
                        id: `${domain}-c1`,
                        name: 'Hiring Manager',
                        role: 'Engineering Manager',
                        email: `hiring@${domain}`,
                        verified: false,
                        avatarColor: ['#06B6D4', '#3B82F6'],
                    },
                ],
            },
            {
                id: `${domain}-job-2`,
                title: `Product Manager`,
                location: 'Hybrid',
                experience: '5+ years',
                salary: '$130K–$180K',
                jobType: 'Full-time',
                urgent: false,
                skills: ['Product Strategy', 'Analytics', 'Agile', 'Roadmapping'],
                contacts: [],
            },
            {
                id: `${domain}-job-3`,
                title: `Senior UX Designer`,
                location: 'Remote',
                experience: '4+ years',
                salary: '$100K–$140K',
                jobType: 'Full-time',
                urgent: true,
                skills: ['Figma', 'User Research', 'Prototyping', 'Design Systems'],
                contacts: [],
            },
        ];

        const employer = {
            id: `emp-${domain}`,
            name: companyName,
            subInfo,
            logoColor,
            logoInitial: companyName.charAt(0).toUpperCase(),
            status: 'watching',
            jobs,
        };

        return res.json(employer);
    } catch (error) {
        console.error('[aiHubController] getJobMatches error:', error);
        return res.status(500).json({ error: 'Failed to fetch job matches' });
    }
}

/**
 * POST /api/ai-hub/verify-email
 * Body: { email: string }
 *
 * TODO: Call the email verification microservice (SMTP handshake probing +
 *       LinkedIn cross-referencing). Cache results in the contacts table to
 *       avoid re-verifying the same address within 7 days.
 */
async function verifyEmail(req, res) {
    try {
        const { email } = req.body;

        if (!email || typeof email !== 'string') {
            return res.status(400).json({ error: 'email is required' });
        }

        // Mock verification — replace with real SMTP/LinkedIn check
        return res.json({
            verified: true,
            confidence: 0.94,
        });
    } catch (error) {
        console.error('[aiHubController] verifyEmail error:', error);
        return res.status(500).json({ error: 'Failed to verify email' });
    }
}

/**
 * POST /api/ai-hub/jobs/:jobId/contacts
 * Body: { name, role, email }
 *
 * TODO: Persist the contact to the ai_hub_contacts table (user_id, job_id,
 *       name, role, email). Kick off async email verification and optionally
 *       enqueue a social-profile enrichment job.
 */
async function addContactToJob(req, res) {
    try {
        const { jobId } = req.params;
        const { name, role, email } = req.body;

        if (!name || !role || !email) {
            return res.status(400).json({ error: 'name, role, and email are required' });
        }

        // Mock contact creation — replace with DB insert
        const contact = {
            id: `contact-${Date.now()}`,
            name,
            role,
            email,
            verified: false,
            avatarColor: ['#64748B', '#475569'],
        };

        console.log(`[aiHubController] Contact added to job ${jobId}:`, name);
        return res.status(201).json(contact);
    } catch (error) {
        console.error('[aiHubController] addContactToJob error:', error);
        return res.status(500).json({ error: 'Failed to add contact' });
    }
}

module.exports = {
    analyzeWishlist,
    getJobMatches,
    verifyEmail,
    addContactToJob,
};
