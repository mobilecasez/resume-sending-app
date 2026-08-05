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
const {
    snapMultiValue, keepCheckboxValue, isMultiField,
    snapSingleValue, repeaterKind, normResumeDate, buildRepeaterRows,
    normalizeRepeaterValue, chipsAnswer, workAuthTopic, learnedWorkAuthAnswer,
    demographicTopic, demographicTopicOf, genderOptionFor, isPhoneCodeField, isPhoneNumberField,
    isWorkAuthQuestion,
} = require('../server/controllers/aiHubController.js');

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

// FOUND ON A LIVE PAGE, not in a fixture: real options contain commas. Revolut's "How did you
// hear about us" list has "Job portal or job search (Indeed, Google search, Justjoin.it, etc.)"
// and Lever's ethnicity list has "Hispanic, Latino or Spanish origin". Splitting a multi-answer
// value blindly on commas turned those into fragments that matched nothing — and keepCheckboxValue
// then DELETED a correct answer.
console.log('\nan option that CONTAINS a comma is one answer, not several');
const ETH = { type: 'checkbox', widget: 'checkboxgroup', multi: true, options: ['Hispanic, Latino or Spanish origin', 'Asian', 'Mixed or Multiple Ethnic Groups'] };
ok('the whole value is recognised as one option', keepCheckboxValue(ETH, 'Hispanic, Latino or Spanish origin') === 'Hispanic, Latino or Spanish origin', keepCheckboxValue(ETH, 'Hispanic, Latino or Spanish origin'));
ok('a plain answer alongside it still splits correctly', keepCheckboxValue(ETH, 'Asian, Hispanic, Latino or Spanish origin') === 'Asian, Hispanic, Latino or Spanish origin', keepCheckboxValue(ETH, 'Asian, Hispanic, Latino or Spanish origin'));
ok('snapping resolves it too', JSON.stringify(snapMultiValue(ETH.options, 'Hispanic, Latino or Spanish origin')) === '["Hispanic, Latino or Spanish origin"]', snapMultiValue(ETH.options, 'Hispanic, Latino or Spanish origin'));
ok('ordinary comma-separated answers are UNCHANGED by all this', keepCheckboxValue(LANGS, 'English, French') === 'English, French');
ok('a fragment that matches nothing is still dropped', keepCheckboxValue(ETH, 'Asian, Klingon') === 'Asian', keepCheckboxValue(ETH, 'Asian, Klingon'));

console.log('\nthe multi flag is read from any of the three signals');
ok('widget checkboxgroup', isMultiField(PRONOUNS) === true);
ok('widget chips', isMultiField(CHIPS) === true);
ok('multi:true alone', isMultiField({ multi: true }) === true);
ok('a plain select is NOT multi', isMultiField({ type: 'select', options: ['a', 'b'] }) === false);
ok('a lone checkbox is NOT multi', isMultiField(LONE) === false);

// ─────────────────────────────────────────────────────────────────────────────
// The deterministic answers for the shapes the scan started emitting. These exist so the
// server does not have to HOPE a model returns a row array or a real option — and so that
// what it does answer can only ever come from what the candidate wrote themselves.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\na ONE-answer field keeps its first answer instead of losing both');
const YN = ['Yes', 'No'];
ok('an exact answer is untouched', snapSingleValue(YN, 'No') === 'No');
ok('two answers to a one-answer question keep the first', snapSingleValue(YN, 'Yes, French') === 'Yes', snapSingleValue(YN, 'Yes, French'));
ok('the first answer must really be an option', snapSingleValue(YN, 'Klingon, Dothraki') === null);
ok('a starts-with first answer resolves', snapSingleValue(['Yes, I consent', "No, I don't consent"], 'Yes, whatever') === 'Yes, I consent');
ok('an ambiguous first answer is refused, not guessed', snapSingleValue(['Yes, full time', 'Yes, part time', 'No'], 'yes, something') === null);

console.log('\na repeater region is named from its own heading, or not at all');
ok('Revolut work region', repeaterKind('Experience (optional) Please highlight your work experience') === 'experience');
ok('Revolut education region', repeaterKind('Education (optional) Please enter the name of the universities you attended') === 'education');
ok('plain "Employment history"', repeaterKind('Employment history') === 'experience');
ok('a region naming neither is left alone', repeaterKind('Attachments') === null);
ok('a tie is refused rather than guessed', repeaterKind('Education and work experience') === null, repeaterKind('Education and work experience'));
ok('an empty label is not a section', repeaterKind('') === null);

console.log('\nrésumé dates are normalised, never invented');
ok('YYYY-MM survives', normResumeDate('2021-04') === '2021-04');
ok('YYYY-MM-DD survives', normResumeDate('2021-04-09') === '2021-04-09');
ok('"May 2022" becomes 2022-05', normResumeDate('May 2022') === '2022-05', normResumeDate('May 2022'));
ok('"Jan. 2019" becomes 2019-01', normResumeDate('Jan. 2019') === '2019-01', normResumeDate('Jan. 2019'));
ok('"03/2020" becomes 2020-03', normResumeDate('03/2020') === '2020-03', normResumeDate('03/2020'));
ok('a bare year STAYS a year — a month would be invented', normResumeDate('2018') === '2018');
ok('"Present" is kept verbatim', normResumeDate('Present') === 'Present');
ok('nothing in, nothing out', normResumeDate(null) === '');

const RESUME = {
    builder_resume: {
        experience: [
            { company: 'Acme Ltd', role: 'Senior Engineer', location: 'Berlin', start_date: 'Apr 2021', end_date: 'Present' },
            { company: 'Globex', role: 'Engineer', start_date: '2018-01', end_date: '2021-03' },
            { company: 'Initech', role: 'Junior Engineer', start_date: '2016', end_date: '2017' },
            { company: 'Umbrella', role: 'Intern', start_date: '2015', end_date: '2016' },
        ],
        education: [{ institution: 'TU Delft', degree: 'MSc', field_of_study: 'Computer Science', end_date: '2015', grade: '8.5 CGPA' }],
        skills: { technical: ['React', 'Node.js', 'TypeScript', 'Postgres'], soft: ['Mentoring'] },
        languages: [{ name: 'English', level: 'C2' }, { name: 'Dutch', level: 'B1' }],
    },
    resume_metadata: { skills: ['GraphQL'], languages: ['German'], education: [{ institution: 'Fallback Uni', degree: 'BSc', field: 'Maths', year: '2012' }] },
};

console.log('\nrepeater rows are built from the résumé — and only from the résumé');
const expRows = buildRepeaterRows('experience', RESUME);
ok('work rows come out newest first', expRows[0].Company === 'Acme Ltd' && expRows[1].Company === 'Globex');
ok('at most 3 rows — the client only clicks that many', expRows.length === 3, expRows.length);
ok('the role is offered under both column names the employer might use', expRows[0].Position === 'Senior Engineer' && expRows[0].Title === 'Senior Engineer');
ok('dates are normalised in place', expRows[0]['Start date'] === '2021-04' && expRows[0]['End date'] === 'Present', expRows[0]);
ok('a row with no employer is not a row', buildRepeaterRows('experience', { builder_resume: { experience: [{ role: 'Engineer' }] } }).length === 0);
ok('no résumé → no rows, not a blank one', buildRepeaterRows('experience', {}).length === 0);
const eduRows = buildRepeaterRows('education', RESUME);
ok('the school is offered as School / University / Institution', eduRows[0].School === 'TU Delft' && eduRows[0].University === 'TU Delft' && eduRows[0].Institution === 'TU Delft');
ok('degree, field and grade come through', eduRows[0].Degree === 'MSc' && eduRows[0]['Field of study'] === 'Computer Science' && eduRows[0].Grade === '8.5 CGPA');
ok('education falls back to the parsed résumé when there is no builder CV',
    buildRepeaterRows('education', { resume_metadata: RESUME.resume_metadata })[0].School === 'Fallback Uni');
ok('an education region NEVER receives an employer', eduRows.every((r) => !r.Company));
ok('a work region NEVER receives a school', expRows.every((r) => !r.School));

console.log('\nwhatever the model returns for a repeater is forced into row shape');
ok('a JSON STRING of rows is parsed', JSON.stringify(normalizeRepeaterValue('[{"Company":"Acme"}]')) === '[{"Company":"Acme"}]');
ok('a single object becomes one row', JSON.stringify(normalizeRepeaterValue({ Company: 'Acme' })) === '[{"Company":"Acme"}]');
ok('empty rows are dropped', normalizeRepeaterValue([{}, { Company: '' }]) === null);
ok('a nested cell is dropped, the row survives', JSON.stringify(normalizeRepeaterValue([{ Company: 'Acme', Highlights: ['a', 'b'] }])) === '[{"Company":"Acme"}]');
ok('a date cell is normalised here too', normalizeRepeaterValue([{ 'Start date': 'May 2022' }])[0]['Start date'] === '2022-05');
ok('more than 3 rows are cut to 3', normalizeRepeaterValue([{ a: '1' }, { a: '2' }, { a: '3' }, { a: '4' }]).length === 3);
ok('prose is not a row array', normalizeRepeaterValue('I worked at Acme') === null);
ok('a number cell survives as text', normalizeRepeaterValue([{ Grade: 8.5 }])[0].Grade === '8.5');

console.log('\nchips are answered only where a résumé really holds the answer');
ok('a skills chip input gets the candidate’s own skills, most relevant first',
    chipsAnswer({ label: 'Skills' }, RESUME) === 'React, Node.js, TypeScript, Postgres, GraphQL, Mentoring', chipsAnswer({ label: 'Skills' }, RESUME));
ok('"Technologies you have used" is the same question', String(chipsAnswer({ label: 'Technologies you have used' }, RESUME)).indexOf('React') === 0);
ok('at most 10 chips', String(chipsAnswer({ label: 'Skills' }, { builder_resume: { skills: { technical: Array.from({ length: 30 }, (_, i) => 'S' + i) } } })).split(', ').length === 10);
ok('spoken languages come from the languages list, not the skills list', chipsAnswer({ label: 'Languages' }, RESUME) === 'English, Dutch, German', chipsAnswer({ label: 'Languages' }, RESUME));
ok('"programming languages" is a SKILLS question', String(chipsAnswer({ label: 'Programming languages' }, RESUME)).indexOf('React') === 0);
ok('"Preferred work locations" is a chip input we must NOT answer', chipsAnswer({ label: 'Preferred work locations' }, RESUME) === null);
ok('no résumé → no chips', chipsAnswer({ label: 'Skills' }, {}) === null);

console.log('\nwork authorisation is replayed from the applicant’s own past answer, never flipped');
const QA = [
    { question: 'Are you legally authorised to work in Germany?', answer: 'Yes' },
    { question: 'Do you now or in the future require visa sponsorship?', answer: 'No' },
];
ok('"authorised to work" is one topic', workAuthTopic('Are you authorised to work in the UK?') === 'authorised');
ok('"require sponsorship" is another', workAuthTopic('Will you require sponsorship?') === 'sponsorship');
ok('a question that is BOTH is ambiguous and refused', workAuthTopic('Are you authorised to work here without sponsorship?') === null);
ok('an unrelated question is not this at all', workAuthTopic('What is your notice period?') === null);
ok('the same question reworded, same country, replays',
    learnedWorkAuthAnswer({ label: 'Do you have the right to work in Germany?' }, QA) === 'Yes',
    learnedWorkAuthAnswer({ label: 'Do you have the right to work in Germany?' }, QA));
ok('a DIFFERENT country never replays', learnedWorkAuthAnswer({ label: 'Do you have the right to work in Canada?' }, QA) === null);
ok('a country-less question never borrows a country-specific answer', learnedWorkAuthAnswer({ label: 'Do you have the right to work?' }, QA) === null);
ok('the sponsorship answer is NOT reused for the authorisation question',
    learnedWorkAuthAnswer({ label: 'Are you authorised to work in the United States?' }, [QA[1]]) === null);
ok('the sponsorship question gets the sponsorship answer', learnedWorkAuthAnswer({ label: 'Would you need sponsorship now or in future?' }, QA) === 'No');
ok('an essay-length saved answer is not a yes/no', learnedWorkAuthAnswer({ label: 'Right to work in Germany?' }, [{ question: 'Are you authorised to work in Germany?', answer: 'x'.repeat(80) }]) === null);
ok('nothing saved → nothing replayed', learnedWorkAuthAnswer({ label: 'Right to work in Germany?' }, []) === null);

// MEASURED ON THE LIVE REVOLUT FORM: the model returned {"Company":…,"Role":…}. "Role" is not a
// word the client fuzzy-matches against the employer's column headings, so a perfectly good
// employer row carried a key nothing could place. The vocabulary is the server's to keep.
console.log('\na row key the model invented is renamed onto the vocabulary the client knows');
const asRow = (o) => normalizeRepeaterValue([o])[0];
ok('"Role" becomes the Position/Title pair', JSON.stringify(asRow({ Role: 'Project Manager' })) === '{"Position":"Project Manager","Title":"Project Manager"}', asRow({ Role: 'Project Manager' }));
ok('"Employer" becomes Company', JSON.stringify(asRow({ Employer: 'Metasys' })) === '{"Company":"Metasys"}', asRow({ Employer: 'Metasys' }));
ok('"Institution" becomes School/University/Institution', Object.keys(asRow({ Institution: 'C-DAC' })).join(',') === 'School,University,Institution', asRow({ Institution: 'C-DAC' }));
ok('"Major" becomes Field of study', asRow({ Major: 'Chemistry' })['Field of study'] === 'Chemistry', asRow({ Major: 'Chemistry' }));
ok('"From"/"To" become Start date / End date', JSON.stringify(asRow({ From: '2021-04', To: '2024-08' })) === '{"Start date":"2021-04","End date":"2024-08"}', asRow({ From: '2021-04', To: '2024-08' }));
ok('a renamed date column is still date-normalised', asRow({ Role: 'x', From: 'June 2013' })['Start date'] === '2013-06', asRow({ Role: 'x', From: 'June 2013' }));
// ⚠️ The "is this a date?" test has to read the name we EMIT, not the model's own word. "From"
// happens to contain the word "from"; "To", "Started" and "Finished" contain none of them, so the
// same fact used to reach the device normalised or raw depending purely on the model's phrasing.
ok('"To" is date-normalised even though the word itself is not date-ish', asRow({ To: 'August 2024' })['End date'] === '2024-08', asRow({ To: 'August 2024' }));
ok('"Started"/"Finished" are too', asRow({ Started: 'Aug 2015', Finished: 'March 2021' })['Start date'] === '2015-08' && asRow({ Started: 'Aug 2015', Finished: 'March 2021' })['End date'] === '2021-03', asRow({ Started: 'Aug 2015', Finished: 'March 2021' }));
ok('an already-correct row is unchanged', JSON.stringify(asRow({ Company: 'Acme', 'Start date': '2021-04' })) === '{"Company":"Acme","Start date":"2021-04"}', asRow({ Company: 'Acme', 'Start date': '2021-04' }));
ok('a column we have no synonym for is passed through, not dropped', asRow({ 'Reason for leaving': 'Relocated' })['Reason for leaving'] === 'Relocated');
ok('the first spelling of a duplicated column wins', asRow({ Role: 'Chemist', Position: 'Analyst' }).Position === 'Chemist', asRow({ Role: 'Chemist', Position: 'Analyst' }));

console.log('\ndemographics are recognised wherever they hide, and only gender has a source');
ok('ethnicity is protected', demographicTopic('Please select your ethnicity (optional)') === 'protected');
ok('race is protected', demographicTopic('What is your race?') === 'protected');
ok('disability is protected', demographicTopic('Do you have a disability, or have you ever had one?') === 'protected');
ok('veteran status is protected', demographicTopic('Are you a protected veteran?') === 'protected');
ok('sexual orientation is protected', demographicTopic('Sexual orientation') === 'protected');
ok('religion is protected', demographicTopic('What is your religion?') === 'protected');
ok('an age BAND is protected', demographicTopic('Which age range are you in?') === 'protected');
ok('…but plain date of birth is NOT — it is a profile fact the form legitimately needs', demographicTopic('Date of birth') === null);
ok('gender is its own topic', demographicTopic('Gender') === 'gender');
ok('so is a pronoun question', demographicTopic('Which pronouns do you use? (optional)') === 'gender');
ok('and a lone box whose whole label IS a pronoun pair', demographicTopic('She/her') === 'gender', demographicTopic('She/her'));
ok('"They/them" too', demographicTopic('They/them') === 'gender');
ok('an ordinary question is not a demographic one', demographicTopic('How did you hear about this role?') === null);
ok('nor is a company whose name contains a stray word', demographicTopic('Have you previously been employed by Essex Water?') === null, demographicTopic('Have you previously been employed by Essex Water?'));

// ⚠️ MEASURED, not imagined: when a group's host holds nothing but its own options the scan has no
// question to send, so grpQuestion() falls back to a MEMBER'S label and the field arrives asking
// "Male" or "White". Neither is a demographic WORD, so the question-only guard let both through —
// verified against production, the "Male" one came back ANSWERED. The options are the question.
console.log('\na demographic group with no question is still recognised — from its options');
const topicOf = (label, options) => demographicTopicOf({ label, options });
ok('a gender group labelled with one of its own options', topicOf('Male', ['Male', 'Female', 'Non-binary', 'Prefer not to say']) === 'gender');
ok('a pronoun group labelled "He/him"', topicOf('He/him', ['He/him', 'She/her', 'They/them']) === 'gender');
ok('the EEO race list, labelled "White"', topicOf('White', ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'White', 'Two or More Races', 'Decline To Self Identify']) === 'protected');
ok('a short ethnicity list, labelled "Asian"', topicOf('Asian', ['Asian', 'Black', 'Hispanic', 'White', 'Mixed', 'Prefer not to say']) === 'protected');
ok('the veteran list', topicOf('I am not a protected veteran', ['I identify as one or more of the classifications of a protected veteran', 'I am not a protected veteran', 'I decline to answer']) === 'protected');
ok('the disability list', topicOf('Yes, I have a disability', ['Yes, I have a disability', 'No, I do not have a disability', 'I do not want to answer']) === 'protected');
// …and the ordinary questions it must NOT swallow. Each of these was a real option list.
ok('a yes/no question with a decline option is NOT gender', topicOf('Have you worked here before?', ['Yes', 'No', 'Prefer not to say']) === null);
ok('a source-of-application list is not a demographic', topicOf('How did you hear about us?', ['LinkedIn', 'Referral', 'Job board', 'Veterans job board', 'Other']) === null, topicOf('How did you hear about us?', ['LinkedIn', 'Referral', 'Job board', 'Veterans job board', 'Other']));
ok('a benefits list with ONE "disability" row is not a demographic', topicOf('Which benefits interest you?', ['Health insurance', 'Disability insurance', 'Pension']) === null);
ok('a size list is not a gender question', topicOf('T-shirt size', ['S', 'M', 'L', 'XL']) === null);
ok('a language list is not a demographic', topicOf('Languages', ['English', 'French', 'German']) === null);
ok('an office list containing "Isle of Man" is not a gender question', topicOf('Which office?', ['Isle of Man', 'London', 'Dublin']) === null);
// A Mr/Mrs list IS a gender question in disguise, and answering it from a first name is exactly
// the inference we refuse. \\bmrs?\\b used to match "Mr" in the FEMALE branch, which is tested
// first, so every title list resolved the male option as female.
ok('a Mr/Mrs title list is treated as gender', topicOf('Title', ['Mr', 'Mrs', 'Miss', 'Ms']) === 'gender');
ok('"Mr" is the male option, not the female one', genderOptionFor('Male', ['Mr', 'Mrs']) === 'Mr', genderOptionFor('Male', ['Mr', 'Mrs']));
ok('"Mrs" is the female one', genderOptionFor('Female', ['Mr', 'Mrs']) === 'Mrs', genderOptionFor('Female', ['Mr', 'Mrs']));

console.log('\nthe work-authorisation guard covers the wording that asks BOTH halves');
ok('a combined question has no single topic (so nothing may be replayed onto it)',
   workAuthTopic('Are you legally authorized to work in the US, and will you require visa sponsorship?') === null);
ok('…but it IS a work-authorisation question, so the guard still fires',
   isWorkAuthQuestion('Are you legally authorized to work in the US, and will you require visa sponsorship?') === true);
ok('each half on its own is still a single topic', workAuthTopic('Are you legally authorized to work in the US?') === 'authorised' && workAuthTopic('Will you require visa sponsorship?') === 'sponsorship');
ok('an ordinary question is neither', isWorkAuthQuestion('What is your notice period?') === false);

console.log('\nthe gender answer is the PROFILE‘s, spelled the way the page spells it');
ok('"Male" → the Male option', genderOptionFor('Male', ['Male', 'Female', 'Non-binary', 'Prefer not to say']) === 'Male');
ok('"Male" → the He/him option when that is how the page asks', genderOptionFor('Male', ['He/him', 'She/her', 'They/them']) === 'He/him');
ok('"Female" → She/her, and never the Male option', genderOptionFor('Female', ['He/him', 'She/her', 'They/them']) === 'She/her');
ok('"female" does not match the "male" bucket', genderOptionFor('female', ['Male', 'Female']) === 'Female');
ok('"Prefer not to say" finds the decline option', genderOptionFor('Prefer not to say', ['Male', 'Female', 'I decline to answer']) === 'I decline to answer');
ok('"Non-binary" finds They/them', genderOptionFor('Non-binary', ['He/him', 'She/her', 'They/them']) === 'They/them');
ok('no stated gender → no answer', genderOptionFor('', ['Male', 'Female']) === null);
ok('a stated gender the page does not offer → no answer', genderOptionFor('Non-binary', ['Male', 'Female']) === null);
ok('a free-text gender field takes the profile value as written', genderOptionFor('Female', []) === 'Female');

console.log('\na dial-code control is NEVER the number control (the live "" that ate +91)');
const REVOLUT_DIAL = { type: 'button', label: 'Search phone country codes',
    options: ['+1', '+7', '+20', '+31', '+44', '+49', '+91'] };
ok('Revolut‘s "Search phone country codes" IS a dial-code control', isPhoneCodeField(REVOLUT_DIAL) === true);
ok('…and is NOT treated as the phone-number control', isPhoneNumberField(REVOLUT_DIAL) === false, isPhoneNumberField(REVOLUT_DIAL));
ok('a plain tel input still is the number control', isPhoneNumberField({ type: 'tel', label: 'Phone number' }) === true);
ok('"Country Phone Code" is still a dial-code control', isPhoneCodeField({ label: 'Country Phone Code', options: ['+1', '+44', '+49', '+91', '+31'] }) === true);
ok('a referee‘s phone is nobody‘s number to fill', isPhoneNumberField({ type: 'tel', label: 'Emergency contact phone' }) === false);

console.log('\na lone checkbox answered with its OWN label is a tick, not an untick');
ok('"She/her" on the She/her box survives', keepCheckboxValue({ label: 'She/her', options: [] }, 'She/her') === 'She/her', keepCheckboxValue({ label: 'She/her', options: [] }, 'She/her'));
ok('…in the page‘s own spelling', keepCheckboxValue({ label: 'He/him', options: [] }, 'he/him') === 'He/him');
ok('a "No" on a lone box is still deleted', keepCheckboxValue({ label: 'She/her', options: [] }, 'No') === null);
ok('and so is another box‘s label', keepCheckboxValue({ label: 'She/her', options: [] }, 'They/them') === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
