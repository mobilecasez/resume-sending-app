#!/usr/bin/env node
// Support service tests — run against a REAL Postgres, then clean up after themselves.
//
// These exist because an adversarial review of the design found two defects that would have
// shipped, and "I was careful" is not evidence. The two that matter most:
//
//   • IDOR — user B must not be able to read, write to, mute or mark-read user A's thread by
//     putting A's thread id in the URL. Every one of those is asserted below, separately, because
//     it is entirely possible to guard the read and forget the write.
//   • STAFF IDENTITY — the user-facing shape must never carry sender_user_id.
//
//   DATABASE_URL=... node tools/test-support.js

const db = require('../db-config');
const svc = require('../server/services/supportService');

let pass = 0;
const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else fails.push(`${name}${extra ? ` — ${extra}` : ''}`); };
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

(async () => {
  await db.initializeConnection();

  // Two throwaway users. Suffixed so a re-run never collides.
  const stamp = (process.hrtime.bigint() % 100000000n).toString();
  const mk = async (n) => (await db.get(
    `INSERT INTO users (full_name, email, password, created_at)
     VALUES ($1, $2, 'x', NOW()) RETURNING id`, [`Test ${n}`, `support-test-${n}-${stamp}@example.invalid`])).id;
  const A = await mk('a');
  const B = await mk('b');
  const ADMIN = await mk('admin');
  await db.run(`UPDATE users SET role = 'admin' WHERE id = $1`, [ADMIN]);

  try {
    // ── creating ────────────────────────────────────────────────────────────
    const bad = await svc.createThread(A, 'not_a_real_issue', 'hi');
    eq('unknown issue key is refused', bad.error, 'unknown_issue');

    const made = await svc.createThread(A, 'cover_letter', 'It fails every time on Revolut jobs');
    ok('thread created', !!made.thread, JSON.stringify(made).slice(0, 120));
    const TA = made.thread.id;
    eq('issue title resolved from the catalogue', made.thread.issue_title, 'Cover letter would not generate');

    // Tapping the same card again continues the thread rather than opening a second one.
    // Re-submitting the FORM is still governed by the chat gap rule, so age the first message first —
    // that rule is deliberately not applied to the very first message of a brand-new thread.
    const againFast = await svc.createThread(A, 'cover_letter', 'still broken');
    eq('re-reporting the same issue too quickly is rate limited', againFast.error, 'too_fast');
    await db.run(`UPDATE support_messages SET created_at = NOW() - INTERVAL '1 hour' WHERE thread_id = $1`, [TA]);
    const again = await svc.createThread(A, 'cover_letter', 'still broken');
    eq('same issue reuses the open thread', again.thread.id, TA);

    // ── IDOR: user B must not touch user A's thread ─────────────────────────
    const bRead = await svc.threadMessages(TA, { userId: B });
    eq('B cannot READ A\'s thread', bRead.error, 'not_found');

    const bWrite = await svc.postMessage(B, TA, 'let me in', 'user');
    eq('B cannot WRITE to A\'s thread', bWrite.error, 'not_found');

    const bRead2 = await svc.markRead(TA, { userId: B });
    eq('B cannot clear A\'s unread', bRead2.error, 'not_found');

    const bMute = await svc.setMuted(TA, B, true);
    eq('B cannot mute A\'s thread', bMute.error, 'not_found');

    // ...and none of that left a trace on A's thread.
    const aStill = await svc.threadMessages(TA, { userId: A });
    ok('A\'s thread untouched by B', !aStill.error && aStill.messages.length === 2,
      `messages=${aStill.messages && aStill.messages.length}`);

    // ── staff identity must not leak ────────────────────────────────────────
    const reply = await svc.adminReply(TA, ADMIN, 'Thanks — looking into it now.');
    ok('admin can reply', !!reply.message, JSON.stringify(reply).slice(0, 120));
    const asUser = await svc.threadMessages(TA, { userId: A });
    const adminMsg = asUser.messages.find((m) => m.sender === 'support');
    ok('user sees the admin reply', !!adminMsg);
    ok('user shape has NO sender_user_id', adminMsg && !('sender_user_id' in adminMsg),
      adminMsg && JSON.stringify(Object.keys(adminMsg)));
    const asAdmin = await svc.threadMessages(TA, {});
    const adminSide = asAdmin.messages.find((m) => m.sender === 'admin');
    ok('admin shape DOES carry sender_user_id', adminSide && adminSide.sender_user_id === ADMIN);

    // ── ordering: oldest→newest for display, newest kept when truncating ────
    ok('messages are in chronological order',
      asUser.messages.every((m, i, a) => i === 0 || Number(a[i - 1].id) < Number(m.id)));
    // With a limit smaller than the thread, we must get the LATEST slice, not the first.
    const page = await svc.threadMessages(TA, { userId: A, limit: 1 });
    eq('a 1-message page returns the NEWEST message', page.messages[0].id,
      asUser.messages[asUser.messages.length - 1].id);

    // ── unread counters ─────────────────────────────────────────────────────
    const listA = await svc.listUserThreads(A);
    ok('user has unread after the admin replied', listA.unread >= 1, `unread=${listA.unread}`);
    await svc.markRead(TA, { userId: A });
    const listA2 = await svc.listUserThreads(A);
    eq('marking read clears the user badge', listA2.unread, 0);

    // ── rate limiting ───────────────────────────────────────────────────────
    const fast = await svc.postMessage(A, TA, 'another one right away', 'user');
    eq('rapid second message is refused', fast.error, 'too_fast');

    // ── length cap ──────────────────────────────────────────────────────────
    await db.run(`UPDATE support_messages SET created_at = NOW() - INTERVAL '1 hour' WHERE thread_id = $1`, [TA]);
    const long = await svc.postMessage(A, TA, 'x'.repeat(9000), 'user');
    ok('over-long body is truncated, not rejected', !!long.message);
    ok('stored body respects BODY_MAX', long.message.body.length <= svc.BODY_MAX,
      `len=${long.message && long.message.body.length}`);

    // ── admin inbox ─────────────────────────────────────────────────────────
    const inbox = await svc.listAdminThreads({ status: 'open' });
    ok('thread appears in the admin inbox', inbox.threads.some((t) => t.id === TA));
    const row = inbox.threads.find((t) => t.id === TA);
    ok('inbox row carries the user identity', row && row.user && row.user.id === A);

    const resolved = await svc.setStatus(TA, 'resolved');
    eq('status can be resolved', resolved.thread.status, 'resolved');
    const closedWrite = await svc.postMessage(A, TA, 'one more', 'user');
    eq('a resolved thread refuses new user messages', closedWrite.error, 'closed');
    eq('bad status is refused', (await svc.setStatus(TA, 'banana')).error, 'bad_status');

    // ── staff-initiated conversation ────────────────────────────────────────
    const started = await svc.adminStartThread(A, 'resume_upload', 'Hi — I can see your CV never finished processing. Want me to re-run it?', ADMIN);
    ok('admin can start a conversation with a user', !!started.thread, JSON.stringify(started).slice(0, 140));
    ok('the started thread belongs to that user', started.thread && started.thread.user.id === A);
    const seen = await svc.threadMessages(started.thread.id, { userId: A });
    ok('the user can open the thread staff started', !seen.error && seen.messages.length === 1);
    ok('and sees it as coming from support', seen.messages[0] && seen.messages[0].sender === 'support');
    ok('with no staff identity attached', seen.messages[0] && !('sender_user_id' in seen.messages[0]));
    eq('staff cannot start one for an unknown issue', (await svc.adminStartThread(A, 'nope', 'x', ADMIN)).error, 'unknown_issue');
    eq('staff cannot start an empty conversation', (await svc.adminStartThread(A, 'login', '   ', ADMIN)).error, 'empty');
    eq('staff cannot start one for a missing user', (await svc.adminStartThread(99999999, 'login', 'hi', ADMIN)).error, 'not_found');

    // ── open-thread ceiling ─────────────────────────────────────────────────
    let capped = null;
    for (const k of ['search_no_jobs', 'search_wrong', 'resume_upload', 'apply_failed', 'autofill', 'notifications', 'credits']) {
      const r = await svc.createThread(B, k, 'test');
      if (r.error === 'too_many_open') { capped = r; break; }
    }
    ok('a user cannot open unlimited threads', !!capped, 'never hit the cap');

  } finally {
    // Clean up — threads and messages cascade from the user rows.
    for (const id of [A, B, ADMIN]) {
      await db.run(`DELETE FROM support_threads WHERE user_id = $1`, [id]).catch(() => {});
      await db.run(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
    }
  }

  console.log(`\nsupport: ${pass} assertions passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('✅ all green');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack.split('\n').slice(1, 3).join('\n')); process.exit(1); });
