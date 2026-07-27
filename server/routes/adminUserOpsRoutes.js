// Admin user-ops routes — ADDITIVE. A 360° view of one user + targeted / segment push sends.
// Every route is admin-only (authenticateAdmin). Mounted under /api next to adminNotifyRoutes.
//
//   GET  /api/admin/users/:id/overview            profile, files, credits, résumé, activity, push
//   GET  /api/admin/users/:id/files/:kind         streams resume | photo | signature for viewing
//   GET  /api/admin/users/:id/matched-jobs        global_jobs ranked by the user's own match score
//   GET  /api/admin/users/:id/activity?kind=      the ITEMS behind the overview counts:
//                                                 cover_letters | saved_jobs | applications |
//                                                 credits | searches   (paged, limit<=100)
//   GET  /api/admin/users/:id/cover-letters/:lid  one full cover letter (scoped to its owner)
//   GET  /api/admin/notify/templates?userId=N     template catalogue + per-user relevance
//   POST /api/admin/users/:id/notify              send ONE template to ONE user
//   GET  /api/admin/segments                      segment list + live counts
//   GET  /api/admin/segments/:key/users           who is in a segment
//   POST /api/admin/segments/:key/notify          dry run by default; confirm:true actually sends
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/adminUserOpsController');

router.get('/admin/users/:id/overview', authenticateAdmin, ctrl.getOverview);
router.get('/admin/users/:id/files/:kind', authenticateAdmin, ctrl.getFile);
router.get('/admin/users/:id/matched-jobs', authenticateAdmin, ctrl.getMatchedJobs);
router.get('/admin/users/:id/activity', authenticateAdmin, ctrl.getActivity);
router.get('/admin/users/:id/cover-letters/:letterId', authenticateAdmin, ctrl.getCoverLetter);

// Résumé, readable: the parsed profile plus a PDF rendered from it. The raw file stays available
// at /files/resume, but it is no longer the only way in — see services/adminResumeView.js.
router.get('/admin/users/:id/resume-profile', authenticateAdmin, ctrl.getResumeProfile);
router.get('/admin/users/:id/resume-pdf', authenticateAdmin, ctrl.getResumePdf);

// Searches with their outcomes, the jobs one search produced, and a no-charge cover-letter render
// against a real job using that user's own résumé.
router.get('/admin/users/:id/searches', authenticateAdmin, ctrl.getSearches);
router.get('/admin/users/:id/searches/:employerId/jobs', authenticateAdmin, ctrl.getSearchJobs);
router.post('/admin/users/:id/test-cover-letter', authenticateAdmin, ctrl.testCoverLetter);

router.get('/admin/notify/templates', authenticateAdmin, ctrl.getTemplates);
router.post('/admin/users/:id/notify', authenticateAdmin, ctrl.notifyUser);

router.get('/admin/segments', authenticateAdmin, ctrl.getSegments);
router.get('/admin/segments/:key/users', authenticateAdmin, ctrl.getSegmentUsers);
router.post('/admin/segments/:key/notify', authenticateAdmin, ctrl.notifySegmentUsers);

module.exports = router;
