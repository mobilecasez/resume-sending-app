// The Job Agent's app side — what the user can and cannot trigger from the phone.
//   node scripts/test-job-agent-screen.js
// Checked on COMMENT-STRIPPED source (the server rules are behavioural in server/scripts/test-job-agent.js):
//   • Send exists only for an EMAIL job and only for a user who may send, and asks first;
//   • a company-form job only ever opens the in-app apply browser (the user submits) — never "Send";
//   • long work runs as a server job the screen polls (never a request held open for minutes);
//   • every server refusal has a sentence; the push lands on the screen; the Jobs screen has the way in.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };

const SCREEN = strip(R('app/(job-agent)/index.tsx'));
const SVC = strip(R('services/jobAgentService.ts'));
const PUSH = strip(R('services/pushRouting.ts'));
const DISC = strip(R('app/(discover)/index.tsx'));
const PLANS = strip(R('app/(subscription)/plans.tsx'));

console.log('── the screen ──');
ok('new files carry the AI Hub header', ['app/(job-agent)/index.tsx', 'app/(job-agent)/_layout.tsx', 'services/jobAgentService.ts', 'components/JobAgentEntry.tsx']
  .every((f) => R(f).startsWith('// AI Hub — new feature. Safe to delete without affecting existing app.')));
ok('⚠️ Send only for an email job, and only when the user may send', /item\.channel === 'email' && canSend \? <Btn primary label="Send" onPress=\{onSend\} \/> : <Btn primary label="Open & apply" onPress=\{onApply\} \/>/.test(SCREEN));
ok('⚠️ …and Send asks first, naming the address', /Alert\.alert\(\s*'Send this application\?'/.test(SCREEN) && /emailed to \$\{item\.applyEmail\}/.test(SCREEN) && /onSend=\{\(\) => confirmSend\(it\)\}/.test(SCREEN));
ok('a company-form job opens the in-app apply browser with Auto Fill (the user submits)', /pathname: '\/\(ai-hub\)\/job-detail'/.test(SCREEN) && /autoApply: '1', applyNowUrl: item\.jobUrl/.test(SCREEN));
ok('"I applied" is offered whenever Send is not (a free user\'s email job included)', /!\(item\.channel === 'email' && canSend\) \? <Btn label="I applied"/.test(SCREEN));
ok('automatic sending cannot be chosen without a plan, and the summary says when it is paused', /disabled=\{!a\?\.canSend\}/.test(SCREEN) && /Automatic sending is paused — it needs a plan/.test(SCREEN));
ok('a failed load is said, never a blank switched-off agent', /setLoadError\('Could not load your Job Agent|Could not load your Job Agent\. Pull down to try again\./.test(SCREEN) && /\{loadError \? \(/.test(SCREEN));
ok('taps work while the keyboard is up', /keyboardShouldPersistTaps="handled"/.test(SCREEN));
ok('a run that stopped or was skipped says why', /const reason = s\.skippedReason \|\| s\.stoppedReason \|\| s\.sendBlocked;/.test(SCREEN));
ok('the tailored documents open in the existing editors', /'\/\(resume-builder\)\/preview', params: \{ docId: it\.resumeDocId/.test(SCREEN) && /'\/\(cover-letter\)\/edit', params: \{ docId: it\.letterDocId/.test(SCREEN));
ok('switching on with no roles opens the form instead of saving an agent that searches everything', /if \(on && !list\(roles\)\.length\) \{ setEditing\(true\)/.test(SCREEN));
ok('automatic sending is an explicit choice, explained, and default is review', /useState<'review' \| 'auto_email'>\('review'\)/.test(SCREEN) && /Company forms always wait for you\./.test(SCREEN));
ok('the free preview says sending needs a plan, with a way to plans', /Sending applications needs a plan\./.test(SCREEN) && /'\/\(subscription\)\/plans'/.test(SCREEN));
ok('StyleSheet + Ionicons only (no third-party UI)', /StyleSheet\.create\(/.test(SCREEN) && !/from 'react-native-(paper|elements)|nativewind/.test(SCREEN));
ok('analytics: view, save, toggle, run, every action, open-apply', ['job_agent_view', 'job_agent_save', 'job_agent_toggle', 'job_agent_run', 'job_agent_open_apply'].every((e) => SCREEN.includes(`'${e}'`)) && /track\(`job_agent_\$\{what\}`/.test(SCREEN));

console.log('── the client ──');
ok('⚠️ a run, a preparation and a send are server jobs the client polls (minutes long)', /\{ \.\.\.body, __async: true \}/.test(SVC) && /\/ai-hub\/job-status\/\$\{start\.jobId\}/.test(SVC)
  && /runNow = \(\) => runJob/.test(SVC) && /prepareItem = \(id: number\) => runJob/.test(SVC) && /sendItem = \(id: number\) => runJob/.test(SVC));
ok('a failed job surfaces its reason', /data\.status === 'failed'[\s\S]{0,200}data\.data\.reason/.test(SVC));
ok('the store environment and device ride along (TestFlight is Sandbox; the free plan is per device)', /storeEnvHeader\(\)/.test(SVC) && /deviceHeader\(\)/.test(SVC));
const reasons = ['roles_required', 'too_soon', 'already_running', 'monthly_limit', 'quota_exhausted', 'paid_required', 'no_mail_account', 'reconnect', 'scope', 'no_resume', 'not_email_channel',
  'plan_required', 'downloads_used', 'unknown_outcome', 'payer_changed', 'interrupted', 'run_failed', 'ai_busy', 'daily_cap', 'disabled', 'no_roles'];
ok('every refusal the server gives has a sentence', reasons.every((r) => new RegExp(`case '${r}':`).test(SVC)));

console.log('── the ways in ──');
ok('the push route opens the Job Agent', /const JOB_AGENT = '\/\(job-agent\)';/.test(PUSH) && /case 'job-agent':[\s\S]{0,60}case 'job_agent':[\s\S]{0,80}pathname: JOB_AGENT/.test(PUSH));
ok('the Jobs screen shows the Job Agent card (not over the open search launcher)', /\{!launcherOpen \? <JobAgentEntry \/> : null\}/.test(DISC));
ok('plan cards show the monthly Job Agent allowance when the server sends one', /Number\(p\.autoApplies\) > 0 \?/.test(PLANS) && /Job Agent: \$\{plural\(Number\(p\.autoApplies\)/.test(PLANS));
ok('App.js is untouched by the agent', !/job-agent|JobAgent/.test(R('App.js')));

console.log(`\njob agent screen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
