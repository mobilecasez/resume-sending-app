// Who owns a file in temp/, so one signed-in user cannot fetch another's document.
//
// ⚠️ THE FOUR /api/download-* ROUTES AUTHENTICATE THE CALLER AND THEN IGNORE WHO THEY ARE.
// They check the JWT, reject path traversal — and then serve any filename that exists in temp/,
// to anybody. Names are minted as `<Full Name>_Resume_<Date.now()>.pdf`, so an attacker needs the
// victim's exact name and their exact millisecond, which is why this has never been exploited. But
// a "your downloads" list is precisely the feature that would hand out filenames, so the hole has
// to close before that ships.
//
// ⚠️ THE REGISTRY IS IN MEMORY, AND THAT IS THE RIGHT LIFETIME. temp/ is in .railwayignore and has
// no Railway volume, so every deploy wipes it — the files and this map die together and can never
// disagree. A database table would outlive the files it describes and start denying downloads for
// rows whose files were deleted three deploys ago.
//
// ⚠️ AN UNREGISTERED FILE IS ALLOWED, DELIBERATELY. Not every writer of temp/ is a document
// download (the email attachment path writes there too), and refusing what we have no record of
// would break flows this module never saw. So the rule is the narrower, strictly-safe one: a file
// we KNOW belongs to someone else is refused. Since temp/ empties on the next deploy, within one
// release every file being served is one we registered.
'use strict';

/** Roughly a day of heavy use; each entry is two short strings. */
const MAX = 5000;

/** filename -> userId. A Map keeps insertion order, which makes eviction trivial. */
const owners = new Map();

/** Remember that this file was produced for this user. */
function own(userId, fileName) {
  const f = String(fileName || '').trim();
  if (!f || !userId) return;
  if (owners.has(f)) owners.delete(f);          // re-insert so a re-issued name moves to the back
  owners.set(f, userId);
  while (owners.size > MAX) {
    const oldest = owners.keys().next().value;
    if (oldest === undefined) break;
    owners.delete(oldest);
  }
}

/**
 * May this user read this file?
 *
 * True when we have no record of it (see the header — not every temp/ writer is a download), and
 * true when it is theirs. False only when we know it is someone else's.
 */
function mayRead(userId, fileName) {
  const holder = owners.get(String(fileName || '').trim());
  return holder === undefined || holder === userId;
}

/** For tests and diagnostics only. */
function size() { return owners.size; }
function reset() { owners.clear(); }

module.exports = { own, mayRead, size, reset, MAX };
