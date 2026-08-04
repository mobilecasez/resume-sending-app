// The server post-passes that decide what a NEW field shape is allowed to send to the device.
//
//   node tools/test-autofill-postpass.js
//
// These are the two rules that used to silently delete a correct answer:
//   * a checkbox GROUP answers with an option LABEL ("They/them"), not a boolean — the old truthy
//     test deleted every one of them, which made the client's own group branch dead code;
//   * a multi-answer value ("English, French") was snapped as ONE string against the option list,
//     matched nothing, and was dropped as "no matching option".
// A dummy DATABASE_URL is enough: nothing here touches the database.
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test@localhost:5432/test';
const { snapMultiValue, keepCheckboxValue, isMultiField } = require('../server/controllers/aiHubController.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

const PRONOUNS = { key: 'g:checkbox|x', type: 'checkbox', widget: 'checkboxgroup', multi: true, options: ['He/him', 'She/her', 'They/them', 'Prefer not to say', 'Other'] };
const LANGS = { key: 'n:langs|checkbox', type: 'checkbox', widget: 'checkboxgroup', multi: true, options: ['English', 'French', 'German', 'Spanish'] };
const LONE = { key: 'l:i agree|checkbox', type: 'checkbox', options: [] };
const CHIPS = { key: 'l:skills|text', type: 'text', widget: 'chips', multi: true, options: ['React', 'Node.js', 'TypeScript'] };

console.log('\nthe checkbox pass no longer deletes a group answer');
ok('a group answer that IS an option survives', keepCheckboxValue(PRONOUNS, 'They/them') === 'They/them', keepCheckboxValue(PRONOUNS, 'They/them'));
ok('it survives case-insensitively, in the option’s own spelling', keepCheckboxValue(PRONOUNS, 'they/them') === 'They/them', keepCheckboxValue(PRONOUNS, 'they/them'));
ok('several answers survive together', keepCheckboxValue(LANGS, 'English, French') === 'English, French', keepCheckboxValue(LANGS, 'English, French'));
ok('a part that is NOT an option is dropped, the rest kept', keepCheckboxValue(LANGS, 'English, Klingon') === 'English', keepCheckboxValue(LANGS, 'English, Klingon'));
ok('an answer matching NO option is deleted, not passed through', keepCheckboxValue(LANGS, 'Klingon') === null, keepCheckboxValue(LANGS, 'Klingon'));

console.log('\na LONE checkbox is still boolean-only (a "No" must never untick the applicant)');
ok('"yes" survives', keepCheckboxValue(LONE, 'yes') === 'yes', keepCheckboxValue(LONE, 'yes'));
ok('true survives', keepCheckboxValue(LONE, true) === true, keepCheckboxValue(LONE, true));
ok('"No" is deleted', keepCheckboxValue(LONE, 'No') === null, keepCheckboxValue(LONE, 'No'));
ok('"false" is deleted', keepCheckboxValue(LONE, 'false') === null, keepCheckboxValue(LONE, 'false'));
ok('an unset field stays unset', keepCheckboxValue(LONE, undefined) === undefined, keepCheckboxValue(LONE, undefined));
// The regression this guards: a GROUP whose one answer is the word "No" ("No, I do not need
// sponsorship") is an option, so it is kept — but a lone box answered "No" is still deleted.
ok('"No" IS kept when it is a real option of a group', keepCheckboxValue({ type: 'checkbox', widget: 'checkboxgroup', options: ['Yes', 'No'] }, 'No') === 'No');

console.log('\nmulti-value snapping resolves part by part');
ok('exact parts pass straight through', JSON.stringify(snapMultiValue(LANGS.options, 'English, German')) === '["English","German"]', snapMultiValue(LANGS.options, 'English, German'));
ok('a reworded part snaps onto the real option', JSON.stringify(snapMultiValue(CHIPS.options, 'react, node')) === '["React","Node.js"]', snapMultiValue(CHIPS.options, 'react, node'));
ok('semicolons and pipes split too', JSON.stringify(snapMultiValue(LANGS.options, 'English; French|German')) === '["English","French","German"]', snapMultiValue(LANGS.options, 'English; French|German'));
ok('duplicates collapse', JSON.stringify(snapMultiValue(LANGS.options, 'English, english')) === '["English"]', snapMultiValue(LANGS.options, 'English, english'));
ok('nothing resolvable returns null (so the caller can say "no matching option")', snapMultiValue(LANGS.options, 'Klingon, Dothraki') === null);
ok('an empty value returns null', snapMultiValue(LANGS.options, '   ') === null);

console.log('\nthe multi flag is read from any of the three signals');
ok('widget checkboxgroup', isMultiField(PRONOUNS) === true);
ok('widget chips', isMultiField(CHIPS) === true);
ok('multi:true alone', isMultiField({ multi: true }) === true);
ok('a plain select is NOT multi', isMultiField({ type: 'select', options: ['a', 'b'] }) === false);
ok('a lone checkbox is NOT multi', isMultiField(LONE) === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
