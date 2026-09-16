// cvPlaybook — HOW A CV IS WRITTEN WHERE THE CANDIDATE IS APPLYING, as a deterministic table.
//   node server/scripts/test-cv-playbook.js
//
// WHY THIS EXISTS: the employer-doc prompt knew the country only as a label ("Applying in: Germany") and
// knew nothing at all about it when the employer research came back without conventions — the prompt then
// fell back to Anglo habits it never names out loud: "Month YYYY" dates, one summary shape, "as the material
// has it" detail, no rule about projects. Meanwhile regionFromCountry already resolves EVERY country to a CV
// profile (photo / personal details / length / format) and designFit already reads it for the DESIGN. This
// module is the same resolution read for the WRITING, plus the columns regionFromCountry has no slot for:
// projects, experience depth, bullets per role, metrics, the summary, skills, education placement, section
// order, the date pattern and a few short country notes.
//
// ⚠️ THE COUNTRY TABLE IS NOT FORKED. resolveRegion / placeFor / cvDefaultsFor decide WHERE we are and what
// the photo / personal-details / length / format habits are; this file adds columns on top of that answer and
// never re-implements the ~200-row country table. A country-level override may correct a cv.* value only
// where the research for THAT country was specific (a Swiss CV carries a photo, a Brazilian one must not).
//
// ⚠️ FORMAT AND EMPHASIS ONLY — the same contract every other prompt block in this lane carries. Every rule
// here moves, condenses, orders or re-words what the candidate's material already says. No rule may add a
// fact: not a photo, not a date of birth, not a project, not a number, not a language level. A convention the
// material cannot meet is simply not met.
//
// ⚠️ THE PHOTO NEVER REACHES THE WRITING PROMPT. cv.photo is a DESIGN input (the template owns the slot; the
// model cannot produce a photograph), so playbookFor answers it for designFit-shaped callers and
// playbookPromptBlock never emits a rule about it. The same goes for the document's language: the doc prompt
// already says "write in the same language as the candidate's material", and a second, contradicting language
// rule from a country table would be a bug, not a convention.
//
// ⚠️ DETERMINISTIC AND PURE. No Date.now(), no Math.random(), no I/O. The same inputs give the same playbook,
// for ever — because the employer document is cached under a fingerprint that does NOT hash prompt text
// (employerDocs.fingerprint): two builds that disagreed would be served interchangeably from that cache.
// Nothing here enters a fingerprint, so shipping it re-bills nobody and rewrites no stored document.
//
// ⚠️ THE MERGE ORDER IS designFit.employerContext's, DELIBERATELY. profile row → country override → employer
// size/type modifier → the researched conventions for THIS employer. A fact observed about this employer beats
// a country generalisation; a fact researched for ANOTHER country loses to the local default (a German CV for
// a German posting is not written to US habits because the HQ is in Texas). If the prompt merged them in a
// different order from the design ranking, one document would be WRITTEN for one country and DESIGNED for
// another — which is the bug designFit's W_RESEARCH / W_COUNTRY_DEFAULT / W_FOREIGN_RESEARCH weights exist for.
//
// ⚠️ THE BLOCK SAYS EACH MERGED ANSWER ONCE. The doc prompt already carries the employer's own researched
// conventions (employerResearch.conventionsPromptBlock) and the rules built from them (docFormattingBlock), so
// every cv.* value that CAME from that research is suppressed here: the playbook block speaks only where the
// country baseline is the answer. Provenance travels on a non-enumerable `_from` (invisible to JSON, so a
// deep-equal determinism check is unaffected) — see fromOf().
'use strict';

const regionUtil = require('../utils/regionFromCountry');

// The document we generate has exactly these sections (the employer-doc / parse JSON schema), so a section
// order is written in THESE keys. A country habit the schema cannot render (Israel's military-service block,
// Australia's named referees, a Philippine trainings list) is a NOTE instead, never a section key the model
// has no slot for.
const SECTION_KEYS = ['contact', 'personal_details', 'summary', 'skills', 'experience', 'projects',
  'education', 'certifications', 'languages', 'achievements'];

// The closed vocabularies. cv.* is deliberately employerResearch conventions.cv's vocabulary — the same words
// sanitiseConventions / docConventionsOf check against — so a researched value and a country default are read
// by one piece of code downstream, with no translation layer.
const ENUMS = {
  photo: ['expected', 'optional', 'avoid'],
  personalDetails: ['include', 'avoid'],
  length: ['one_page', 'two_pages', 'flexible'],
  format: ['tabular', 'narrative', 'europass', 'ats_plain'],
  projects: ['all', 'selected', 'omit'],
  projectDetail: ['full', 'brief'],
  projectPlacement: ['section', 'inside_experience'],
  experienceDetail: ['deep', 'standard', 'concise'],
  metrics: ['expected', 'welcome', 'sparing'],
  summary: ['required', 'optional', 'avoid'],
  skills: ['detailed', 'standard', 'brief'],
  educationPlacement: ['top', 'after_experience'],
  tier: ['giant', 'enterprise', 'sme', 'startup', 'public_sector', 'ngo', 'academia', 'agency'],
};

// A date pattern must survive the doc lane's own re-sanitiser (docDateFormatOf: ASCII, ≤24 chars, names a
// year), or it is dropped there and the prompt falls back to "Month YYYY". So every pattern below is written
// in the latin MM/YYYY vocabulary even where the country writes it in its own script (Japan's 年月).
const DATE_RE = /^[A-Za-z0-9 .,/-]{1,24}$/;

// ── The profile playbooks ─────────────────────────────────────────────────────────────────────────
// One row per regionFromCountry CV profile (17 today). cv.photo / personalDetails / length / format are NOT
// here — cvDefaultsFor owns them. These are the columns that table has no slot for, and the WHY of each row
// is in its notes: they are what a writer in that country would be told, in the order that country reads.
//
// ⚠️ bulletsRecent / bulletsOlder are CALIBRATION, not law. Almost no national guidance states a number
// (Italy's "about 6 recent, about 4 older" and real Indian IT résumés running 7-13 per project block are the
// two that do); the rest are read off worked examples in each market's guidance. They are a deterministic
// default for a prompt, not a threshold anyone enforces.
const CV_PLAYBOOKS = {
  // US, Israel, Puerto Rico. The one market where a page limit is a screening rule rather than a style: one
  // page until roughly ten years, achievement-first bullets, no Projects section once real employment exists.
  anglo1: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 6], bulletsOlder: [2, 3],
    metrics: 'expected', summary: 'required', summaryWords: [30, 60], skills: 'brief',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'summary', 'skills', 'experience', 'education', 'projects', 'certifications'],
    notes: [
      'One page until roughly ten years of experience; a second page must be earned by relevance, never by retelling older roles in full.',
      'Every bullet is action verb plus what changed. A duty statement appears only where the material states no outcome.',
      'Roles older than about fifteen years compress to one "Earlier experience" line: title, employer, years.',
      'Education is one or two lines and sits below Experience — above it only for a current student or someone within a year of graduating.',
    ],
    letter: ['Open on the role and the single strongest matching result the material states; short paragraphs, no formal flourishes.'],
    sources: ['https://atsverification.com/blog/us-resume-format-2026/', 'https://resumevera.com/resume-format/us',
      'https://hireflow.net/blog/resume-length-that-works-in-2026', 'https://resumeworded.com/blog/bullet-points-per-job-on-resume/'],
  },
  // UK, Ireland, Canada, Australia, NZ and the Commonwealth by proxy. Two pages, and the extra page buys
  // CONTEXT: a real personal statement at the top and a labelled key-skills block, not repetition.
  anglo2: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [4, 6], bulletsOlder: [2, 3],
    metrics: 'welcome', summary: 'required', summaryWords: [50, 150], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'summary', 'skills', 'experience', 'education', 'certifications', 'projects'],
    notes: [
      'The personal statement at the top is a convention, not decoration: three or four lines naming the specialism, the level and the strongest thing already done.',
      'Key skills belong in a short labelled block of 8-12 terms near the top; no proficiency percentages or star ratings.',
      'Each role opens with one plain line of context (employer, remit) before its bullets; older roles shrink to title, employer, dates and a line or two.',
      'Where the posting lists essential and desirable criteria, order the recent bullets to answer them in the posting\'s own order.',
    ],
    letter: ['Answer the posting\'s stated criteria in the order it lists them, in its own words.'],
    sources: ['https://atsverification.com/blog/uk-cv-format-2026/', 'https://altercv.com/cv-format/united-kingdom/',
      'https://www.visualcv.com/international/new-zealand/', 'https://novoresume.com/career-blog/canada-resume-format'],
  },
  // Germany, Austria, Switzerland, Liechtenstein. The tabular Lebenslauf: a gapless two-column timeline where
  // the grid IS the format, duties carry the entry and achievements are added on top rather than replacing them.
  dach: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'deep', bulletsRecent: [4, 6], bulletsOlder: [1, 3],
    metrics: 'welcome', summary: 'optional', summaryWords: [40, 80], skills: 'detailed',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'skills', 'languages', 'certifications'],
    notes: [
      'Antichronological and GAPLESS: every station carries MM/YYYY - MM/YYYY, employer, city and title, and an interruption is a plainly labelled row rather than a hidden one.',
      'Duties carry the entry (scope, responsibility, tools, team) and achievements are added on top — a purely achievement-led entry reads as incomplete here.',
      'Skills split into their own lines: languages with the CEFR level the material states, then IT skills, then further training and certificates.',
      'A short profile at the top is worth it for a career changer or a senior hire; otherwise the table speaks for itself.',
    ],
    letter: ['State the role and where it was seen in the first line, then evidence in the order the posting asks for it.'],
    sources: ['https://karrierebibel.de/lebenslauf/', 'https://www.lebenslauf.de/ratgeber/lebenslauf/tabellarischer-lebenslauf/',
      'https://www.die-bewerbungsschreiber.de/lebenslauf-aufbau'],
  },
  // France, Belgium, Luxembourg, Monaco and the French overseas territories. A French CV without a TITLE line
  // reads as unfinished; the last 10-15 years carry the detail and everything older is one summary block.
  franco: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [1, 2],
    metrics: 'welcome', summary: 'required', summaryWords: [25, 60], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'summary', 'experience', 'education', 'skills', 'languages', 'achievements'],
    notes: [
      'Lead with a precise job title line including the level ("Directeur marketing", not "Marketing") and a two-or-three-line accroche under it.',
      'Keep the last 10-15 years in full detail and roll older roles into one "Expériences antérieures" block of a line each.',
      'Skills are plain words with languages on their own lines — gauges, stars and pictograms parse as nothing.',
      'Education rises above Experience only for a recent graduate, where the diploma is the strongest card.',
    ],
    letter: ['Name the exact post applied for in the opening line; the register stays formal and impersonal.'],
    sources: ['https://www.apec.fr/candidat/optimiser-votre-candidature/candidature/fiches-conseils/comment-decrire-ses-experiences-professionnelles-dans-son-cv.html',
      'https://adem.public.lu/dam-assets/fr/publications/adem/guides/Guide-CV-FR.pdf'],
  },
  // Maghreb, francophone and lusophone Africa, Haiti. The French shape with an état-civil header kept and
  // languages ranked: multilingual capability is a selection criterion across this profile, not a footnote.
  franco_ext: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [2, 3],
    metrics: 'welcome', summary: 'required', summaryWords: [30, 55], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'projects', 'skills', 'languages'],
    notes: [
      'Experience leads for anyone with a real record; education leads only within a year or two of graduating.',
      'One page up to roughly five years, two beyond that — a third page is read as padding.',
      'Keep the languages block prominent and carry over the état-civil line exactly as the material gives it, adding no field.',
      'Engineering and school-leaver CVs keep their end-of-study project (PFE) as an entry with its title, means and result.',
    ],
    letter: ['Formal and courteous; name the exact post applied for in the opening line.'],
    sources: ['https://www.9rayti.com/article/comment-rediger-un-bon-cv-maroc', 'https://macarrierepro.com/cv-format-ivoirien-2026-modele-conforme/',
      'https://modelos-de-curriculo.com/cv-examples/angola-pais'],
  },
  // Italy, Portugal, Greece, Malta, Cyprus, San Marino, Vatican City. Europass is what the public sector,
  // concorsi and EU-funded employers expect; a private company reads the same sections faster in a plain CV.
  south_eu: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [4, 6], bulletsOlder: [2, 4],
    metrics: 'welcome', summary: 'required', summaryWords: [40, 90], skills: 'detailed',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'skills', 'languages', 'certifications'],
    notes: [
      'Italy states the count outright: about six bullets on the recent, relevant roles and about four on older ones, everything inside two pages.',
      'Give a language a CEFR level ONLY where the material already states one, and keep digital and technical skills as their own block.',
      'Where the material carries the Italian data-processing consent line (Reg. UE 2016/679), keep it and keep it last; never add one.',
      'Education rises above Experience for graduates and anyone whose experience is thin.',
    ],
    letter: [],
    sources: ['https://career.uoa.gr/viografiko-simeioma/', 'https://www.livecareer.it/curriculum-vitae/esperienze-lavorative-curriculum',
      'https://www.onlinecv.it/europass/formato/'],
  },
  // Spain, Andorra. The perfil profesional under the name is the first thing read; the header lost its DNI
  // and postal address years ago.
  iberia: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [1, 2],
    metrics: 'welcome', summary: 'required', summaryWords: [40, 80], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'summary', 'experience', 'education', 'skills', 'languages', 'certifications'],
    notes: [
      'Open with a professional profile of at most five lines under the name — a Spanish recruiter reads it first.',
      'Header is name, city, phone, email and LinkedIn: no national ID, no full postal address, no marital status.',
      'One page under about ten years, two for a senior profile — never more.',
      'A standalone highlighted-projects section is for graduates and career changers; otherwise the project belongs inside the role.',
    ],
    letter: [],
    sources: ['https://plantillascv.es/formato-de-curriculum-espana/', 'https://www.cvwizard.com/es/articulos/perfil-laboral-profesional-curriculum',
      'https://misscv.com/blog/curriculum-dos-paginas/'],
  },
  // Netherlands, Nordics, Iceland, Faroes, Greenland. A retitled profile paragraph per vacancy, plain local
  // headings, and national ID numbers deliberately absent.
  north_eu: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [1, 2],
    metrics: 'welcome', summary: 'required', summaryWords: [30, 70], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM-YYYY',
    sectionOrder: ['contact', 'summary', 'experience', 'education', 'skills', 'languages', 'certifications'],
    notes: [
      'A three-to-five-line profile at the top, retitled for this vacancy, is read before anything else.',
      'Plain conventional headings only — an invented heading parses as nothing.',
      'No national ID number, marital status or family detail: city, phone, email and a link are the whole header.',
      'A separate projects section is for consultants, freelancers and contractors; otherwise the project sits inside the role that ran it.',
    ],
    letter: ['Plain and direct: three or four short paragraphs, evidence over adjectives.'],
    sources: ['https://www.cv-mallen.se/skriva-cv/', 'https://www.ntnu.no/karriere/skrive-cv',
      'https://nl.indeed.com/carrieregids/cv-motivatiebrief/welke-volgorde-werkervaring-op-cv'],
  },
  // Baltics, Poland, Czechia, Slovakia, Hungary, the Balkans, Moldova, Ukraine, Belarus. A project section is
  // normal and often decisive for junior and IT candidates; Europass still rules the public sector.
  cee: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'section',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [1, 2],
    metrics: 'welcome', summary: 'required', summaryWords: [25, 60], skills: 'detailed',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'projects', 'education', 'skills', 'languages', 'certifications'],
    notes: [
      'Open with a two-or-three-sentence professional summary retitled to the advert.',
      'Split skills into hard and soft, and give languages their own lines with the levels the material states.',
      'A projects section carries real weight for junior and IT candidates: the problem, the technologies, the candidate\'s own part.',
      'Where the material carries a GDPR/RODO consent clause, keep it as the last line; never add one.',
    ],
    letter: [],
    sources: ['https://maparynkupracy.pl/co-powinno-zawierac-cv-poradnik-ats-rodo-osiagniecia-2026',
      'https://www.zivotopisy.cz/strukturovany-zivotopis', 'https://www.visualcv.com/international/lithuania-cv/'],
  },
  // Russia, Turkey, the Caucasus, Central Asia, Mongolia. A CIS résumé is read as an application for ONE
  // named position, headed by that position, with each job written as duties plus the results they produced.
  cis: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [1, 3],
    metrics: 'welcome', summary: 'required', summaryWords: [30, 70], skills: 'detailed',
    educationPlacement: 'after_experience', dateFormat: 'MM.YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'skills', 'languages', 'certifications'],
    notes: [
      'Name the target position at the top: this document is read as an application for one named role, not as a career history.',
      'Each job carries the employer plus a short line on what that employer does, then the key duties, then the concrete results.',
      'Two pages is the ceiling even at twenty years — cut older roles to one line rather than spilling onto a third page.',
      'Education rises above Experience for a recent graduate only.',
    ],
    letter: ['Name the position applied for in the first line.'],
    sources: ['https://hh.ru/article/kak-sostavit-rezyume', 'https://www.kariyer.net/kariyer-rehberi/ozgecmis-hazirlama-tuyolari-ve-cv-ornegi/',
      'https://kariyer.omu.edu.tr/en/kariyer-rehberi/oezgecmis-cv-hazirlama'],
  },
  // The Gulf, Levant, Egypt, Libya, Iran. Recruiters read for SCOPE as much as for results, and NAMED
  // projects, clients and employers are what they cross-check — "a major regional project" reads as junior.
  gulf: {
    projects: 'selected', projectDetail: 'full', projectPlacement: 'section',
    experienceDetail: 'deep', bulletsRecent: [4, 6], bulletsOlder: [2, 3],
    metrics: 'expected', summary: 'required', summaryWords: [40, 70], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'projects', 'education', 'certifications', 'skills', 'languages'],
    notes: [
      'Name projects, clients and employers explicitly, exactly as the material names them — unnamed "large regional project" phrasing is the most-cited local weakness.',
      'Project-delivery trades (EPC, oil and gas, construction, large IT delivery) carry a Key Projects block ahead of the older roles: project, client, role, period, scope, outcome.',
      'Carry the header\'s nationality, residency or location line exactly as the material gives it; reorder and tighten it, never add a field.',
      'Skills are plain lines — no rating bars, percentages or self-scored charts.',
    ],
    letter: ['Name the projects, clients and employers the material states: an unnamed "major project" reads as junior here.'],
    sources: ['https://www.bayt.com/en/blog/32538/cv-format-for-uae-jobs-the-complete-2026-guide/',
      'https://www.visualcv.com/international/saudi-arabia-cv/', 'https://stylingcv.com/gcc-guide/gulf-cv-template/'],
  },
  // Anglophone Africa. The single most-penalised local habit is a bare duty list, so every bullet is written
  // as what was done, at what scale, with what outcome — and the document closes with referees.
  africa_en: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [2, 3],
    metrics: 'expected', summary: 'required', summaryWords: [35, 60], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'summary', 'experience', 'education', 'skills', 'certifications', 'projects'],
    notes: [
      'Every bullet carries three parts: what was done, the context or scale, and the outcome or tool — recruiters here state outright that they already know what the job involves.',
      'Where the material names referees, keep them at the end with their title and organisation; where it does not, close with nothing rather than an invented name.',
      'Two pages is the working norm; a third only for a senior or executive record.',
      'A separate projects section is for early-career, tech and portfolio candidates; otherwise the project sits inside the role.',
    ],
    letter: ['Turn duties into what was done, at what scale, with what outcome — a duty list reads as thin here.'],
    sources: ['https://www.jobberman.com/discover/cv-writing', 'https://careergo.co/blog/cv-format-in-kenya',
      'https://www.citizenhelp.co.za/careers/how-to-write-a-cv-south-africa'],
  },
  // ⚠️ INDIA, Pakistan, Bangladesh, Sri Lanka, Nepal, Bhutan, Maldives, Afghanistan — THE ROW THAT MATTERS
  // MOST HERE, and the one that contradicts every Western default. An Indian résumé lists EVERY project the
  // material contains, in full, with the employer or client it ran for, its duration, the candidate's role, the
  // technology stack and its own responsibility bullets. A candidate with nine projects shows nine project
  // blocks. That is not padding: Indian screening stack-matches the project inventory before it reads roles,
  // so "trim to look Western" deletes the evidence the reader is actually looking for. Real Indian IT résumés
  // run 7-13 responsibility bullets per project block; the range below is the reconciliation of that with
  // modern advice, and it is deliberately the highest in the table. The categorised technical-skills block sits
  // ABOVE experience for the same reason.
  south_asia: {
    projects: 'all', projectDetail: 'full', projectPlacement: 'inside_experience',
    experienceDetail: 'deep', bulletsRecent: [4, 8], bulletsOlder: [3, 5],
    metrics: 'welcome', summary: 'required', summaryWords: [40, 70], skills: 'detailed',
    educationPlacement: 'after_experience', dateFormat: 'MMM YYYY',
    sectionOrder: ['contact', 'summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'achievements', 'personal_details'],
    notes: [
      'Every project is evidence here: screening stack-matches the project inventory before it reads the roles, so a merged or trimmed project list deletes exactly what the reader is looking for.',
      'The categorised technical-skills block sits ABOVE experience, for the same reason.',
      'Responsibility coverage is evidence in this market, not filler — keep the duty bullets the material has and add the outcomes on top of them.',
      'Education sits above Experience for freshers and up to roughly three years, below it after that; a trailing personal-details block or declaration is kept only where the material already carries one.',
    ],
    letter: [],
    sources: ['https://www.hireitpeople.com/resume-database/79-other-resumes/22526-senior-software-engineer-resume-india',
      'https://talenlio.ai/blogs/it-jobs-india-resume-tips', 'https://www.naukri.com/campus/career-guidance/resume-format-for-freshers',
      'https://www.kickresume.com/en/blog/indian-resume-format-guide/'],
  },
  // Singapore, Hong Kong, Macau. The most metrics-driven profile in Asia: outcome-first bullets are the stated
  // screening norm, and a full project inventory reads as padding — the ROLE is the unit of evidence.
  sg: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'section',
    experienceDetail: 'standard', bulletsRecent: [4, 6], bulletsOlder: [2, 3],
    metrics: 'expected', summary: 'required', summaryWords: [30, 55], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MMM YYYY',
    sectionOrder: ['contact', 'summary', 'experience', 'education', 'skills', 'certifications', 'projects', 'languages'],
    notes: [
      'Lead every bullet with the outcome, then the action; keep the figures the material already carries and put them at the front.',
      'Projects are an optional supporting section of two to four that match the advert — a full inventory reads as padding here.',
      'Keep a work-pass or citizenship line only where the material already states it; never add an ID number, address, date of birth or marital status.',
      'British spelling, and date ranges written out as "Jan 2021 - Mar 2024".',
    ],
    letter: [],
    sources: ['https://www.visualcv.com/international/singapore-resume/',
      'https://www.robertwalters.com.sg/insights/career-advice/e-guide/how-to-write-a-resume.html', 'https://sg.jobstreet.com/career-advice/article/resume-format'],
  },
  // Malaysia, Indonesia, Philippines, Thailand, Vietnam and neighbours. Duties are still legitimate content,
  // and attended trainings and certifications are read as real evidence rather than a footnote.
  sea: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [4, 6], bulletsOlder: [2, 4],
    metrics: 'welcome', summary: 'required', summaryWords: [30, 60], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MMM YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'skills', 'certifications', 'languages'],
    notes: [
      'Keep the personal-details header the material supplies as the local documentary custom — and add no field it does not give.',
      'Trainings, seminars and certifications attended get their own visible block: attendance is read as real evidence here.',
      'A responsibilities-led history is not a defect in this market; add outcomes on top of the duties rather than replacing them.',
      'Close with references or a declaration only where the material already carries them.',
    ],
    letter: [],
    sources: ['https://my.jobstreet.com/career-advice/article/cv-format-guide-how-to-structure-curriculum-vitae',
      'https://globalresumehub.com/philippines/', 'https://globalresumehub.com/indonesia/'],
  },
  // China, Taiwan, Japan, Korea. A dated, fact-dense table rather than prose: scale facts (team size, users,
  // volume, schedule) belong in the entry's header line, and projects are organised UNDER the employer.
  east_asia: {
    projects: 'selected', projectDetail: 'full', projectPlacement: 'inside_experience',
    experienceDetail: 'deep', bulletsRecent: [4, 6], bulletsOlder: [2, 4],
    metrics: 'welcome', summary: 'required', summaryWords: [50, 120], skills: 'detailed',
    educationPlacement: 'top', dateFormat: 'YYYY.MM',
    sectionOrder: ['contact', 'personal_details', 'summary', 'education', 'experience', 'projects', 'skills', 'certifications', 'languages'],
    notes: [
      'Write it as a dated table, not prose: year-month rows, entry and exit facts stated plainly.',
      'Under each employer, list its projects: period, one-line overview, the candidate\'s role, team size, technologies, outcome — all from the material.',
      'Scale facts the material already states (team size, users, transaction volume, schedule) belong in the entry header, not buried in a bullet.',
      'Open with a short career summary; a self-introduction block is kept only where the material already has that text.',
    ],
    letter: ['Keep it factual and modest — scope, scale and outcome, with no self-promotion.'],
    sources: ['https://japan-dev.com/blog/japanese-cv-shokumu-keirekisho', 'https://www.visualcv.com/international/korea/',
      'https://thetailorcv.com/blog/chinese-resume-format-guide-2026'],
  },
  // Latin America. Logros over funciones, a three-or-four-line professional profile at the top, and a header
  // stripped of the national ID numbers that older local templates carried.
  latam: {
    projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
    experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [2, 3],
    metrics: 'expected', summary: 'required', summaryWords: [30, 55], skills: 'standard',
    educationPlacement: 'after_experience', dateFormat: 'MM/YYYY',
    sectionOrder: ['contact', 'summary', 'experience', 'projects', 'education', 'skills', 'certifications', 'languages'],
    notes: [
      'Open with a three-or-four-line professional profile: specialisation, years, area, and the strongest result the material states.',
      'Each role opens with what was achieved; the responsibility framing sits behind it.',
      'Header carries city and country only — no national ID number, no street address, no marital status, no date of birth.',
      'One page under roughly five years, two beyond; three only for an academic or very senior record.',
    ],
    letter: ['Open on the role and the strongest result the material states; the register is formal and courteous.'],
    sources: ['https://www.livecareer.es/curriculum-vitae/mexico', 'https://www.prepara.cv/blog/o-que-colocar-no-curriculo',
      'https://blog.krowdy.com/blog/como-hacer-un-cv-en-peru-guia-paso-a-paso/'],
  },
};

// ── Country overrides ─────────────────────────────────────────────────────────────────────────────
// Keyed by ISO-2, laid over the profile row. A row is here ONLY where that country genuinely departs from its
// profile in a way a writer would notice — not to restate it. `cv` here may correct photo / personalDetails /
// length / format against cvDefaultsFor, and only where the research for THAT country was specific about it.
//
// ⚠️ INDIA HAS NO ROW ON PURPOSE: the south_asia profile IS the Indian convention (every project, in full,
// stack line included). The rows below are its NEIGHBOURS departing from it.
const COUNTRY_OVERRIDES = {
  // ── Anglo / DACH ──
  IL: { // Filed under the US profile, but not governed by US screening: two pages is normal at senior level.
    cv: { length: 'flexible' },
    sectionOrder: ['contact', 'summary', 'skills', 'experience', 'education', 'projects', 'certifications'],
    notes: ['One page early and mid-career, two once the record needs it — the hard US one-page rule does not apply.',
      'Where the material includes military service, keep it as its own labelled entry (unit, role, dates) near Education rather than merged into Experience.',
      'Front-load the technical skills block for technical roles; the read is fast and scan-driven.'],
    sources: ['https://www.metaintro.com/blog/israeli-resume-format-guide', 'https://anglo-list.com/your-israel-resume/'],
  },
  CA: { // Reads as a US résumé with one extra page: a short summary, metrics expected, referees never printed.
    summary: 'required', summaryWords: [30, 60], metrics: 'expected',
    sectionOrder: ['contact', 'summary', 'skills', 'experience', 'education', 'certifications'],
    notes: ['Tighten the profile into a two-or-three-line professional summary — the long UK-style paragraph reads as padding here.',
      'No referees and no "references available on request" line: references live on a separate sheet.',
      'One page for graduates, two for established professionals, three only for senior or technical specialists.'],
    sources: ['https://novoresume.com/career-blog/canada-resume-format', 'https://resumevera.com/resume-format/canada'],
  },
  AU: { // 2-3 pages is normal (expected in government), and a NAMED referee block is the expectation.
    cv: { length: 'flexible' },
    notes: ['Two to three pages is normal; three is standard for government and senior roles, and cramming to two is the error.',
      'End with the named referees the material gives (name, title, organisation) rather than an "available on request" line.',
      'Where the posting lists selection criteria, mirror its wording and order in the recent-role bullets.'],
    sources: ['https://atsverification.com/blog/australian-resume-format-2026/', 'https://enhancv.com/blog/australian-resume/'],
  },
  NZ: { // Australia's length with the OPPOSITE referees habit — "available on request" is the norm here.
    cv: { length: 'flexible' },
    notes: ['Two pages for most roles, one for graduates, three or four only for senior, academic or government records.',
      'Close with a single "Referees available on request" line; names and numbers come later in the process.'],
    sources: ['https://candidjobs.co.nz/resources/cv-format-nz', 'https://www.cvexperts.co.nz/free-nz-cv-template-2026-recommended-structure/'],
  },
  CH: { // Swiss practice inverts two DACH habits: the photo is usual, and the CV is NOT signed.
    cv: { photo: 'expected' },
    notes: ['Do not append a place, date and signature — a Swiss CV is left unsigned.',
      'Keep the CV to two tight pages: work certificates and diplomas travel as separate dossier attachments, not as CV content.',
      'German-speaking Switzerland rewards precision: exact periods, exact titles, explicit further-training and IT-skills blocks.'],
    sources: ['https://www.cv-builder.ch/en/swiss-cv', 'https://www.bewerbio.ch/ratgeber/lebenslauf-schweiz-2026'],
  },
  AT: { // The German table, but a written-out date is DD.MM.YYYY and Austrian qualification names stay Austrian.
    dateFormat: 'DD.MM.YYYY',
    notes: ['Periods stay MM/YYYY - MM/YYYY; a single written-out date is DD.MM.YYYY.',
      'Keep Austrian qualification and school names as the material writes them (Matura, HTL, FH) rather than converting them.',
      'Europass is genuinely expected for public-sector and EU-funded postings; a private employer reads the tabular CV.'],
    sources: ['https://nudgio.eu/blog/de/oesterreichisches-lebenslauf-format.html'],
  },
  LI: { // Mapped to the German row, but the labour market is effectively Swiss.
    cv: { photo: 'expected' },
    notes: ['Swiss practice applies: an unsigned CV, a permit slot in the personal-data block, certificates as dossier attachments.',
      'Keep it to two tight pages in the Swiss dossier style.'],
    sources: ['https://www.cv-builder.ch/en/swiss-cv'],
  },
  // ── Europe / CIS ──
  BE: { // Not France: two pages is unremarkable, and the ID-style block modern French CVs dropped is kept.
    cv: { length: 'two_pages', personalDetails: 'include' },
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'languages', 'skills', 'achievements'],
    notes: ['One to two A4 sides; two pages is unremarkable here, unlike in France.',
      'Languages sit high — Dutch, French and English capability is a ranked criterion.'],
    sources: ['https://www.expatica.com/be/working/finding-a-job/cv-interview-tips-belgium-102376/'],
  },
  LU: { // The official ADEM guide allows a deliberate two-page CV for senior profiles; languages are first-class.
    cv: { length: 'two_pages', personalDetails: 'include' }, skills: 'detailed', dateFormat: 'MM.YYYY',
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'languages', 'skills', 'certifications'],
    notes: ['A deliberate two-page CV is right for a senior or ten-year-plus record: use the room to detail the projects led, the teams managed and the results reached.',
      'Languages are their own section in a trilingual market, each with the level the material states.'],
    sources: ['https://adem.public.lu/dam-assets/fr/publications/adem/guides/Guide-CV-FR.pdf'],
  },
  PL: { // The one CEE market where one A4 page is the stated ideal and the consent clause is make-or-break.
    cv: { length: 'one_page', photo: 'expected' },
    notes: ['One A4 page unless the career genuinely cannot fit; two is the exception, not the default.',
      'Keep the RODO consent clause as the last line where the material carries one.'],
    sources: ['https://maparynkupracy.pl/co-powinno-zawierac-cv-poradnik-ats-rodo-osiagniecia-2026', 'https://interviewme.pl/blog/jak-napisac-cv-eyetracking'],
  },
  RO: { cv: { format: 'europass' }, notes: ['Europass is actively expected by many employers here, especially public sector and entry level.'], sources: ['https://enhancv.com/blog/europass-cv/'] },
  BG: { cv: { format: 'europass' }, notes: ['Europass is actively expected by many employers here, especially public sector and entry level.'], sources: ['https://enhancv.com/blog/europass-cv/'] },
  UA: { // Skills sit ABOVE experience, and experience and projects share one slot.
    sectionOrder: ['contact', 'summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages'],
    notes: ['Skills sit above experience, and experience and projects share one slot — a project-led record is a normal shape here, not a graduate exception.'],
    sources: ['https://www.jobkit.com.ua/guides/yak-napysaty-rezume'],
  },
  SE: { dateFormat: 'YYYY-MM', notes: ['Dates are written ISO-first (YYYY-MM); the personnummer never appears.'], sources: ['https://overblicken.se/blogg/skriva-datum-sverige-guide/'] },
  TR: { // The CIS photo custom, but not its mechanics: slashes in dates, a narrower header, two pages flat.
    dateFormat: 'MM/YYYY',
    notes: ['Two pages maximum, even at twenty years of experience.',
      'Header carries name, contact and city — leave out national ID number, age, marital status and place of birth.'],
    sources: ['https://www.kariyer.net/kariyer-rehberi/cvnde-asla-olmamasi-gereken-6-sey/'],
  },
  GR: { // Greek profiles run long, and date of birth / marital status are no longer expected.
    cv: { personalDetails: 'avoid' }, summaryWords: [60, 150],
    sectionOrder: ['contact', 'summary', 'experience', 'education', 'skills', 'languages', 'certifications'],
    notes: ['The personal profile runs longer here than in Italy — up to about 150 words.',
      'Date of birth and marital status are no longer expected, and there is no Italian-style data-consent line.'],
    sources: ['https://career.uoa.gr/viografiko-simeioma/', 'https://career.auth.gr/services/advisory/for-work/viografiko-simeioma/'],
  },
  PT: { cv: { photo: 'avoid' }, notes: ['Two pages is already generous here rather than the target.'], sources: ['https://www.cvmaker.pt/blog/curriculum-vitae/incluir-uma-fotografia-no-seu-cv'] },
  MT: { // English, Anglo header, and none of the Italian consent-line habit.
    cv: { personalDetails: 'avoid' },
    notes: ['A UK-style reverse-chronological CV is read as readily as Europass; two pages maximum.',
      'No data-processing consent line — that convention is Italian, not Maltese.'],
    sources: ['https://www.angel-jobs.mt/blogs/european-standard-cv-and-cover-letter/read'],
  },
  CY: {
    cv: { personalDetails: 'avoid' }, summaryWords: [60, 150],
    notes: ['Applications are in English; Europass and a UK-style CV are both accepted, and there is no data-consent line.'],
    sources: ['https://www.angel-jobs.mt/blogs/european-standard-cv-and-cover-letter/read'],
  },
  // ── Asia ──
  JP: { // Two documents: the one worth generating is the career history, and education lives on the other.
    cv: { length: 'two_pages' }, metrics: 'expected', educationPlacement: 'after_experience', summaryWords: [120, 300],
    sectionOrder: ['contact', 'summary', 'experience', 'projects', 'skills', 'certifications', 'languages'],
    notes: ['This is the career-history document (shokumu-keirekisho): a career summary first, then work history per employer with its projects beneath, then skills and qualifications.',
      'Each employer block is followed by its projects: period, project name and overview, role, team scale, tools, and the outcome the material states.',
      'The fixed personal-record form (rirekisho) is a separate document — never invent its entries here.'],
    sources: ['https://japan-dev.com/blog/japanese-cv-shokumu-keirekisho', 'https://www.daijob.com/en/tipsadvice-jobinjapan/resume/syokureki.html'],
  },
  KR: { // Project- and result-centred, weighted to the last three years; blind-hiring forms forbid the photo.
    cv: { photo: 'optional', length: 'two_pages' }, metrics: 'expected',
    notes: ['Organise the career description by project or stack: employer, period, project, role keywords, then the before-and-after results the material states.',
      'Weight the last three years, but keep older achievements that match the target role.',
      'The self-introduction essay is a separate document — do not compress it into the summary.'],
    sources: ['https://www.visualcv.com/international/korea/', 'https://blog.searchright.net/career-description-form-free-download/'],
  },
  CN: { // Deliberately short: one page, a dedicated project section, education above experience early on.
    cv: { length: 'one_page' }, projects: 'selected', projectPlacement: 'section', projectDetail: 'brief', educationPlacement: 'top',
    notes: ['One page (two at the very most) — trim much harder than in Japan or Korea.',
      'Projects get their own section of two to four entries, each one line of context plus stack plus outcome.',
      'Education sits above work experience until roughly two years of relevant experience, then they swap.'],
    sources: ['https://thetailorcv.com/blog/chinese-resume-format-guide-2026', 'https://www.visualcv.com/international/china-cv/'],
  },
  TW: { cv: { length: 'one_page' }, notes: ['One page, and most applications are filed through job-bank templates — stay close to that field order rather than inventing headings.'], sources: ['https://go.104.com.tw/expats/article/foreigner-resume-tips/'] },
  HK: { // Much closer to a Western CV than the rest of its row: no photo, no age, and length genuinely open.
    cv: { photo: 'avoid', personalDetails: 'avoid', length: 'flexible' },
    notes: ['Professional-services and foreign-owned employers expect no age and no marital status in the header.',
      'Length is genuinely open — a fifteen-year history routinely runs three to four pages.'],
    sources: ['https://jobera.com/hong-kong-resume-writing-guide/', 'https://hoisum.hk/en/knowledge/hong-kong-cv-guide/'],
  },
  PH: { // Character references and an attended-trainings block are first-class sections here.
    sectionOrder: ['contact', 'personal_details', 'summary', 'experience', 'education', 'skills', 'certifications', 'achievements'],
    notes: ['A character-references block at the end is expected — but only the referees the material already names.',
      'Seminars and trainings attended are a first-class section, not a footnote.',
      'The personal-information header is local custom for domestic employers and is dropped for multinational and remote applications.'],
    sources: ['https://globalresumehub.com/philippines/', 'https://stylingcv.com/how-to-make-resume-philippines-2026-guide/'],
  },
  ID: { // Runs longer, and organisational experience is read seriously.
    cv: { length: 'flexible' },
    notes: ['Two to three pages is normal here.',
      'Organisational experience sits between work experience and skills and is read seriously; the degree GPA is shown as IPK out of 4.00 where the material states it.'],
    sources: ['https://globalresumehub.com/indonesia/', 'https://www.qarera.com/resume-templates/indonesia'],
  },
  MY: { // The most MNC-shaped market in its row: photo optional, particulars dropped, metrics expected.
    cv: { photo: 'optional', personalDetails: 'avoid' }, metrics: 'expected',
    notes: ['One to two pages, and the header is the multinational-shaped one: contact details only.',
      'Race, religion and marital particulars are increasingly treated as unnecessary — carry over only what the material gives.'],
    sources: ['https://rezumea.com/resume-format/malaysia', 'https://www.visualcv.com/international/malaysia/'],
  },
  PK: { // Keeps the formal personal-information block more consistently than India, and lists fewer projects.
    cv: { personalDetails: 'include' },
    notes: ['The personal-information block (father\'s name, date of birth, nationality, marital status, domicile) is kept where the material gives it and dropped wholesale for international applications — never constructed.',
      'Project blocks under each employer as in the regional convention, but keep the ones matching the advert rather than an exhaustive inventory; preserve the stack line.'],
    sources: ['https://ilm.com.pk/learning-articles/best-cv-format-in-pakistan/'],
  },
  LK: {
    cv: { personalDetails: 'include' }, educationPlacement: 'top',
    notes: ['A formal personal-details section opens the CV: full name and name with initials, date of birth, NIC, civil status, nationality — exactly as the material gives them.',
      'Non-academic referees are commonly named at the end where the material supplies them.'],
    sources: ['https://www.uslegalforms.com/form-library/569198-cv-format-sri-lanka'],
  },
  BD: {
    cv: { personalDetails: 'include' }, educationPlacement: 'top',
    notes: ['The document is still shaped as a bio-data: a fuller personal block up front and a strong academic listing.',
      'Current guidance strips passport number, religion, blood group, height and weight unless the employer asks — keep the block only in the reduced form the material supplies.'],
    sources: ['https://jobsbd.works/cv-format-for-bangladesh/'],
  },
  NP: { cv: { personalDetails: 'avoid', length: 'flexible' }, notes: ['The lightest of the region on personal data: date of birth and marital status are employer-requested extras rather than defaults, and one to two pages is the target.'], sources: ['https://www.kumarijob.com/blog/career-tips/how-to-make-a-cv-for-a-job-in-nepal'] },
  TH: { cv: { photo: 'expected', personalDetails: 'include', length: 'two_pages' }, notes: ['Thailand holds the regional personal-details custom more firmly than its neighbours — keep the supplied personal block intact rather than trimming it toward a Western shape.'], sources: ['https://globalresumehub.com/thailand/'] },
  // ── Middle East, Africa, LatAm ──
  SA: { // Reads for completeness, not compression: three pages is fine when the record earns it.
    cv: { length: 'flexible' }, bulletsRecent: [4, 7],
    notes: ['Three pages is acceptable when the record genuinely has the history — Saudi recruiters prefer full detail to a trimmed one-pager.',
      'Keep Saudi and wider Gulf employers, projects and certifications visible near the top of each entry.'],
    sources: ['https://www.visualcv.com/international/saudi-arabia-cv/', 'https://astrsa.com/en/blog/saudi-cv-template-format-examples-2026'],
  },
  EG: { // A domestic market, not a Gulf expat one: the visa/residency header line means nothing here.
    notes: ['Drop the visa or residency-status line — that is a Gulf expat convention; keep the city or governorate instead.',
      'One to two pages: a three-page CV reads as padding here.',
      'Keep a military-service status line only where the material already supplies one.'],
    sources: ['https://www.prosumely.com/blogs/egyptian-resume-format-guide'],
  },
  LB: {
    notes: ['Drop the visa or sponsorship line; keep nationality and city only.',
      'Put languages high on the page — Arabic, French and English proficiency is a primary criterion here, not a closing detail.',
      'One to two pages, with fuller narrative detail for client-facing sectors such as banking and hospitality.'],
    sources: ['https://proresumes.io/resume-guidelines-for-job-seekers-in-lebanon/'],
  },
  ZA: { // Longer than the rest of its row, with NQF levels and three named referees.
    cv: { length: 'flexible' },
    notes: ['Two to three pages as standard, four only for an executive record.',
      'Three named professional referees is the local standard, and NQF levels stay attached to each qualification the material states them for.'],
    sources: ['https://www.citizenhelp.co.za/careers/how-to-write-a-cv-south-africa', 'https://cvjury.com/how-to-write-a-cv-in-south-africa/'],
  },
  NG: { // The traditional order puts education and NYSC status ABOVE experience; tech employers invert it.
    cv: { length: 'flexible' }, educationPlacement: 'top',
    sectionOrder: ['contact', 'personal_details', 'summary', 'education', 'experience', 'certifications', 'skills', 'projects'],
    notes: ['Traditional sectors (banking, oil and gas, public service) read Education — with the class of degree and NYSC status — above Experience; tech and remote-first employers use the trimmed Western order.',
      'Two to three pages; graduates one to two.',
      'Name two or three referees with title, organisation and contact where the material gives them.'],
    sources: ['https://www.resumeble.com/career-advice/what-is-the-current-cv-format-in-nigeria', 'https://www.jobberman.com/discover/cv-writing'],
  },
  MU: { cv: { photo: 'expected' }, notes: ['A bilingual French/English market: keep a prominent languages section, and two pages (three at the outside).'], sources: ['https://resume-example.com/cv/mauritius-cv-country'] },
  BR: { // The one LatAm market that actively removes the photo and the whole personal block, on bias grounds.
    cv: { photo: 'avoid', personalDetails: 'avoid' },
    notes: ['No national ID number, no marital status, no date of birth and no street address — city and state only.',
      'Open with a one-line objective for an early-career record, or a three-or-four-line summary of the strongest results the material states.'],
    sources: ['https://www.prepara.cv/blog/o-que-colocar-no-curriculo', 'https://www.livecareer.com.br/curriculo/dados-pessoais'],
  },
  CL: { cv: { photo: 'avoid' }, notes: ['One page, two at most; the header drops the national ID, date of birth, marital status and family details.'], sources: ['https://aitalnt.cl/blog/cv-formato-chile'] },
  CO: { cv: { photo: 'expected' }, notes: ['Public-sector applications are filed on the mandatory government form, which a designed CV cannot substitute for; the header still stays free of ID number and family details.'], sources: ['https://www.oie.es/como-hacer-una-hoja-de-vida/'] },
  VE: { cv: { photo: 'expected' }, notes: ['The header stays free of ID number, exact address and family details.'], sources: ['https://www.oie.es/como-hacer-una-hoja-de-vida/'] },
  EC: { cv: { photo: 'expected' }, notes: ['The header stays free of ID number, exact address and family details.'], sources: ['https://www.oie.es/como-hacer-una-hoja-de-vida/'] },
};

// ── Region rows ───────────────────────────────────────────────────────────────────────────────────
// When only a REGION word resolved ("Europe", "APAC", "Middle East") there is no country whose habits apply,
// so these carry ONLY what every country in that gallery bucket shares — the same discipline REGION_PROFILES
// uses for cv.*. `profile` names the nearest CV profile for the record; the CONTENT is this row, not that
// profile's (a "eu" answer must not quietly become a French one).
const REGION_ROWS = {
  us_ca: { profile: 'anglo1', dateFormat: 'MM/YYYY', metrics: 'expected', skills: 'brief', summaryWords: [30, 60],
    notes: ['Achievement-first bullets, and a number only where the material states one.'] },
  uk_au: { profile: 'anglo2', dateFormat: 'MM/YYYY', notes: ['A short profile at the top, then evidence over adjectives; no rating bars in the skills block.'] },
  india: { profile: 'south_asia', dateFormat: 'MMM YYYY', notes: ['Keep every project the material names, with the stack it states, alongside the roles that ran them.'] },
  dach: { profile: 'dach', dateFormat: 'MM/YYYY', notes: ['A gapless dated table: period, employer, city, title, then duties with the results on top.'] },
  eu: { profile: 'iberia', dateFormat: 'MM/YYYY', notes: ['A short professional profile at the top, then reverse-chronological roles; languages get their own lines with the levels the material states.'] },
  sg: { profile: 'sg', dateFormat: 'MMM YYYY', notes: ['Outcome-first bullets, two pages, and no ID numbers in the header.'] },
};
const REGION_LABEL = {
  us_ca: 'the United States and Canada', uk_au: 'the UK, Ireland and Australasia', india: 'South Asia',
  dach: 'the German-speaking countries', eu: 'continental Europe', sg: 'Singapore and the wider Asian hubs',
};

// ⚠️ A REGION ID IS A GALLERY BUCKET, NOT A PLACE — AND THIS BLOCK NAMES THE PLACE OUT LOUD. regionLabelOf
// folds "Middle East", "GCC", "LATAM", "North Africa" and "EMEA" into 'eu' because their DESIGN defaults match
// Iberia's (photo, personal details, length, format), which is true of a TEMPLATE and false of a SENTENCE: a
// block headed "HOW A CV IS WRITTEN IN CONTINENTAL EUROPE" is simply wrong about a Gulf posting, and the
// Iberian content under it (metrics, no personal-details habit, a profile-led order) is wrong about it too.
// `country` is free text off the job / employer record, so every one of those words is reachable in production.
//
// So a region ROW answers only for the region WORDS its own label covers. Any other word that lands in the
// same bucket falls through to GENERIC_ROW and the general header, which claims nothing about anywhere — the
// same discipline as the rest of the file: one rule fewer beats one rule that is wrong. A region reached some
// other way (a .eu site, a researched HQ) is a real place and is untouched: only a WORD is checked here.
const REGION_ROW_WORDS = {
  us_ca: /(?<![a-z])(north america)(?![a-z])/,
  uk_au: /(?<![a-z])(oceania|australasia|anz)(?![a-z])/,                                   // NOT "east africa"
  india: /(?<![a-z])(south asia|indian subcontinent)(?![a-z])/,
  dach: /(?<![a-z])dach(?![a-z])/,
  // NOT latin america / latam / south america / central america / middle east / mena / gcc / arabian gulf /
  // persian gulf / maghreb / north africa — and not "emea", which names three continents that share nothing.
  eu: /(?<![a-z])(europe|european union|eu|eea|nordics?|scandinavia|benelux|baltics?|balkans|iberia)(?![a-z])/,
  sg: /(?<![a-z])(apac|asia-pacific|asia pacific|southeast asia|south-east asia|east asia|asean|greater china|asia)(?![a-z])/,
};
/**
 * Does the region ROW for `region` describe the region WORD the caller typed? True when no word was typed at
 * all (the region then came from a country, a ccTLD or a researched HQ — a real place, not a bucket label).
 */
function regionRowSpeaksFor(region, country) {
  const word = regionUtil.regionLabelOf(typeof country === 'string' ? country : '');
  if (!word) return true;
  const re = REGION_ROW_WORDS[region];
  if (!re) return false;
  return re.test(String(country).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

// The baseline for a caller who knows nothing at all: the habits that are safe everywhere and claim nothing
// about any country — no photo rule, no personal-details rule, no page count, no date pattern.
const GENERIC_ROW = {
  projects: 'selected', projectDetail: 'brief', projectPlacement: 'inside_experience',
  experienceDetail: 'standard', bulletsRecent: [3, 5], bulletsOlder: [2, 3],
  metrics: 'welcome', summary: 'required', summaryWords: [30, 70], skills: 'standard',
  educationPlacement: 'after_experience', dateFormat: null,
  sectionOrder: ['contact', 'summary', 'skills', 'experience', 'education', 'projects', 'certifications'],
  notes: ['Recent roles carry the detail; older ones condense to a line or two — condense, never drop an entry.',
    'Keep every figure the material already states and put it at the front of its bullet; where there is none, state the scope instead.'],
  letter: [],
  sources: [],
};

// ── The employer size / type modifier ─────────────────────────────────────────────────────────────
// WHAT THIS TIER MAY AND MAY NOT DO, and why it is so narrow: the country decides the document, the employer's
// size decides how it is READ. So a tier may tighten rendering, raise the bar on numbers, and add notes — and
// it may NEVER override the country on the photo, the personal details, the document's language or its format
// family. A giant multinational hiring in Germany still gets a German CV. Only two tiers touch the page count,
// and both for a documented reason: a public-sector application cannot fit its evidence on one page, and an
// academic CV is a complete record that no country's page limit applies to.
//
// `apply(pb)` mutates the merged draft and returns the list of fields it changed, which lands in size.applied.
const SIZE_TIERS = {
  giant: {
    notes: ['The first pass is a parser and the second is a seven-second human scan: one column, standard section headings, and employer, title and dates on their own line at the top of each entry.',
      'Spell a skill the way the posting spells it, but only where the material already evidences it — never add one to match.'],
    apply(pb) {
      const changed = [];
      if (!pb.cv.format) { pb.cv.format = 'ats_plain'; changed.push('cv.format'); }         // filling a gap, never overriding a country's format
      if (pb.content.metrics === 'welcome' || pb.content.metrics === 'sparing') { pb.content.metrics = 'expected'; changed.push('metrics'); }
      return changed;
    },
  },
  enterprise: {
    notes: ['A named hiring manager is more likely to read this one: the summary earns its space by stating scope (team, function, sector) the material already gives.',
      'Employer, title and dates stay on one predictable line so the career arc reads top-down in seconds.'],
    apply(pb) {
      const changed = [];
      if (!pb.cv.format) { pb.cv.format = 'ats_plain'; changed.push('cv.format'); }
      if (pb.content.metrics === 'sparing') { pb.content.metrics = 'welcome'; changed.push('metrics'); }
      return changed;
    },
  },
  sme: {
    notes: ['The reader is usually the person this candidate would report to: plain sentences, no keyword wall.',
      'Surface breadth where the material already spans several functions — the end-to-end work they owned.'],
    apply() { return []; },
  },
  startup: {
    notes: ['Lead each recent role with the bullet that shows ownership — built, launched, ran, shipped — where such a bullet already exists in the material.',
      'The stack goes high: the reader is often the person who would work beside this candidate.'],
    apply(pb) {
      const changed = [];
      if (pb.content.skills !== 'detailed') { pb.content.skills = 'detailed'; changed.push('skills'); }
      // ⚠️ A startup promotes projects to their own detailed section — EXCEPT where the country already says
      // "all projects, nested under the employer" (South Asia). That nesting is the stronger convention and the
      // local reader's expectation; a tier must not flatten it.
      if (pb.content.projects === 'selected') {
        if (pb.content.projectPlacement !== 'section') { pb.content.projectPlacement = 'section'; changed.push('projectPlacement'); }
        if (pb.content.projectDetail !== 'full') { pb.content.projectDetail = 'full'; changed.push('projectDetail'); }
      }
      return changed;
    },
  },
  public_sector: {
    notes: ['Eligibility, not flair: each stated requirement must be evidenced somewhere, with dates, in the posting\'s own words — over experience the material already describes.',
      'Every role carries month AND year; never compress to year-only here.',
      'A qualifying role from twelve years ago keeps its substantive bullets: qualifying experience counts wherever it sits in the timeline.'],
    apply(pb) {
      const changed = [];
      // ⚠️ ONE DIRECTION ONLY: a public-sector application cannot fit its evidence on ONE page, which is an
      // argument for RAISING a one-page country and none at all for lowering a country that already reads
      // long. Clamping 'flexible' down to two pages told an Australian, South African, Saudi or Nigerian
      // government applicant the opposite of that country's own guidance — and, because the change stamped
      // from.length = 'size', it then SILENCED the country note that said so ("three is standard for
      // government and senior roles"). The one tier that legitimately lengthens a document is academia.
      if (pb.cv.length === 'one_page') { pb.cv.length = 'two_pages'; changed.push('cv.length'); }
      if (pb.content.experienceDetail !== 'deep') { pb.content.experienceDetail = 'deep'; changed.push('experienceDetail'); }
      if (pb.content.bulletsOlder[1] < 3) { pb.content.bulletsOlder = [2, 3]; changed.push('bulletsOlder'); }
      return changed;
    },
  },
  ngo: {
    notes: ['Languages are a scored field in this sector: keep them as their own section, with only the levels the material states.',
      'Format volunteer and unpaid programme work exactly like paid roles — same heading shape, same bullets, same dates.',
      'Reach and resource are the numbers here (beneficiaries, budget, grants, sites, staff) — carried across only where the material states them.'],
    apply(pb) {
      const changed = [];
      if (pb.content.metrics === 'sparing') { pb.content.metrics = 'welcome'; changed.push('metrics'); }
      return changed;
    },
  },
  academia: {
    notes: ['The itemised lists carry this document — publications, grants, conferences, supervision, teaching — so the appointment entries stay light.',
      'Nothing is dropped for space: older appointments keep their entry and their dates.',
      'Projects means funded research and grants: role, funder and period exactly as the material states them, never inferred.'],
    apply(pb) {
      const changed = ['cv.length', 'educationPlacement', 'summary', 'experienceDetail', 'skills'];
      pb.cv.length = 'flexible';                       // a complete record; no country page limit applies
      pb.content.educationPlacement = 'top';
      pb.content.summary = 'avoid';
      pb.content.summaryWords = [0, 0];
      pb.content.experienceDetail = 'concise';
      pb.content.skills = 'brief';
      pb.content.bulletsRecent = [2, 3];
      pb.content.bulletsOlder = [1, 2];
      changed.push('bulletsRecent', 'bulletsOlder');
      if (pb.content.projectDetail !== 'full') { pb.content.projectDetail = 'full'; changed.push('projectDetail'); }
      if (pb.content.projectPlacement !== 'section') { pb.content.projectPlacement = 'section'; changed.push('projectPlacement'); }
      return changed;
    },
  },
  agency: {
    notes: ['A consultant reformats this document onto their own template before a client sees it: plain text in the body, nothing that lives only in a header, footer or text box.',
      'The summary must be liftable — a self-contained block a consultant can drop into their template unedited.',
      'Month and year on every role: switching to year-only to hide a gap is spotted, and the gap is the candidate\'s to explain.'],
    apply(pb) {
      const changed = [];
      if (!pb.cv.format) { pb.cv.format = 'ats_plain'; changed.push('cv.format'); }
      if (pb.content.skills === 'brief') { pb.content.skills = 'standard'; changed.push('skills'); }
      return changed;
    },
  },
};

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);
/** Flattened, capped free text — "===" runs collapse so a value can never fake a prompt header. */
function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\p{Cc}+/gu, ' ').replace(/={3,}/g, '—').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : (s.slice(0, max + 1).replace(/\s+\S*$/, '').trim() || s.slice(0, max));
}
const pair = (v, fallback) => (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])
  ? [Math.trunc(v[0]), Math.trunc(v[1])] : fallback.slice());
const dateOf = (v) => (typeof v === 'string' && DATE_RE.test(v.trim()) && /y{2,4}|year/i.test(v) ? v.trim() : null);

/** research.conventions when it is a usable object (the same reading the doc lane makes), else null. */
function conventionsOf(conventions, research) {
  if (isObj(conventions)) return conventions;
  const r = isObj(research) ? research.conventions : null;
  return isObj(r) ? r : null;
}

// Free-text company size: the two readings designFit.sizeClassOf already makes, plus the one it does not —
// "giant". There is no employer-size enum in the research (companySize is free text), so a giant is only ever
// derived from an employerType of 'enterprise' PLUS household-name or tens-of-thousands language; with nothing
// in companySize it stays 'enterprise', never guessed upward.
const GIANT_WORDS = /\b(fortune\s?(500|100)|global\s?500|multinational|conglomerate|household name|tens of thousands)\b/i;
const STARTUP_WORDS = /\b(start-?up|scale-?up|seed|series\s[a-c]|early[- ]stage|pre-?seed)\b/i;
const LARGE_WORDS = /\b(enterprise|large|global corporation)\b/i;
const SMALL_WORDS = /\b(small|boutique|micro)\b/i;
function headcountOf(s) {
  const nums = (String(s).replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(\.\d+)?\s*k?/gi) || [])
    .map((x) => (/k/i.test(x) ? parseFloat(x) * 1000 : parseFloat(x)))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 5e6);
  return nums.length ? Math.max(...nums) : null;
}
/** The one size/type reading, for the prompt AND for anything that ranks on it — never two that disagree. */
function tierFor(conv, research) {
  const declared = conv ? oneOf(conv.employerType, ENUMS.tier) : null;   // 'giant' is never declared, only derived
  const sizeText = (isObj(research) ? text(research.companySize, 120) : null) || '';
  const head = headcountOf(sizeText);
  if (declared === 'enterprise' && (GIANT_WORDS.test(sizeText) || (head !== null && head >= 20000))) return 'giant';
  if (declared) return declared;
  if (conv && typeof conv.employerType === 'string') return null;        // 'other' (or junk) means "asked and not known"
  if (!sizeText) return null;
  if (STARTUP_WORDS.test(sizeText)) return 'startup';
  if (GIANT_WORDS.test(sizeText) || LARGE_WORDS.test(sizeText) || (head !== null && head >= 1000)) return 'enterprise';
  if (SMALL_WORDS.test(sizeText) || (head !== null && head <= 200)) return 'sme';
  return null;
}

/** The content row for a profile key, as a fresh object (the table is never handed out). */
function rowOf(key) {
  const r = CV_PLAYBOOKS[key] || GENERIC_ROW;
  return {
    projects: r.projects, projectDetail: r.projectDetail, projectPlacement: r.projectPlacement,
    experienceDetail: r.experienceDetail, bulletsRecent: r.bulletsRecent.slice(), bulletsOlder: r.bulletsOlder.slice(),
    metrics: r.metrics, summary: r.summary, summaryWords: r.summaryWords.slice(), skills: r.skills,
    educationPlacement: r.educationPlacement, sectionOrder: r.sectionOrder.slice(), notes: [],
    _dateFormat: r.dateFormat || null, _notes: (r.notes || []).slice(), _letter: (r.letter || []).slice(),
    _sources: (r.sources || []).slice(),
  };
}

const CONTENT_FIELDS = ['projects', 'projectDetail', 'projectPlacement', 'experienceDetail', 'bulletsRecent',
  'bulletsOlder', 'metrics', 'summary', 'summaryWords', 'skills', 'educationPlacement', 'sectionOrder'];

// ── Silencing a note the merged answer has just contradicted ──────────────────────────────────────
// A note that ASKS FOR a personal block cannot stand in a block whose rule is "leave them empty"; a note that
// says to DROP one agrees with it and carries detail the rule does not (Brazil's street address, Chile's
// national ID, Sweden's personnummer, Nepal's page target). So the test is two-part and deliberately narrow:
// the note must name a personal-details item AND ask to keep it. "Personal statement" is a SUMMARY convention
// (anglo2) and matches neither half.
const PERSONAL_ITEM = /\b(personal[ -](details|information|data|particulars|block)|(the|personal) block|bio-?data|date of birth|nationality|marital|civil status|domicile|father's name|NIC)\b/i;
// ⚠️ THE KEEP WORDS ARE NARROW ON PURPOSE. "expected" is not one of them: half the table uses it in the
// negative ("date of birth and marital status are no longer expected"), which is the rule agreeing with
// itself. Nor is a bare "carries": "Header carries city and country only — no national ID, no date of birth"
// is a DROP instruction. What marks a real keep is the note pointing back at the material and saying to take
// the block from it — "as the material gives it / states them / supplies".
const PERSONAL_KEEP = /\b(keeps?|kept|keeping|intact|includ(e|es|ed|ing)|opens the CV|up front|shaped as|supplies|supplied|(gives?|states?) (it|them))\b/i;

/** Provenance for the five cv fields: 'research' | 'country' | 'region' | 'size' | null. Never throws. */
function fromOf(playbook) {
  const f = playbook && playbook._from;
  return isObj(f) ? { ...f } : {};
}

// ── playbookFor ───────────────────────────────────────────────────────────────────────────────────
/**
 * How a CV is written where this application is going: a merged, deterministic playbook, or null only when
 * the ARGUMENT itself is unusable (a number, a string, an array, null). A caller with nothing to say —
 * playbookFor() or playbookFor({}) — gets the generic baseline, never a throw and never null.
 *
 *   playbookFor({ country: 'India' })                       → source 'country', profile 'south_asia', projects 'all'
 *   playbookFor({ website: 'https://acme.ch' })             → source 'country', Switzerland (the ccTLD)
 *   playbookFor({ country: 'Europe' })                      → source 'region',  the 'eu' row
 *   playbookFor({})                                         → source 'generic'
 *
 * `conventions` defaults to research.conventions, exactly as the doc lane reads it.
 */
function playbookFor(input) {
  const arg = input === undefined ? {} : input;
  if (!isObj(arg)) return null;
  try {
    const country = typeof arg.country === 'string' ? arg.country : null;
    const website = typeof arg.website === 'string' ? arg.website : null;
    const research = isObj(arg.research) ? arg.research : null;
    const conv = conventionsOf(arg.conventions, research);

    // 1. WHERE. The same chain designFit and employerResearch use — never a second country table.
    const place = regionUtil.placeFor({ country, website, conventions: conv });
    let region = regionUtil.resolveRegion({ country, website, conventions: conv });
    if (!regionUtil.REGION_IDS.includes(region)) region = 'generic';
    let source = place ? 'country' : (region !== 'generic' && REGION_ROWS[region] ? 'region' : 'generic');
    // ⚠️ …but a region row may not answer for a word it does not describe — see REGION_ROW_WORDS. `region`
    // itself is left exactly as resolveRegion answered it: it is the DESIGN bucket designFit ranks in, and
    // this module never forks that chain. Only the WRITING falls back to the generic row and its header.
    if (source === 'region' && !regionRowSpeaksFor(region, country)) source = 'generic';

    // 2. THE BASELINE. Profile row, then the country override laid over it.
    const regionRow = REGION_ROWS[region] || null;
    const profileKey = source === 'country' ? place.profile : (source === 'region' ? regionRow.profile : null);
    const content = source === 'generic' ? rowOf(null) : rowOf(profileKey);
    const cvDefaults = regionUtil.cvDefaultsFor(source === 'country' ? place : (source === 'region' ? region : null)) || {};
    const cv = {
      photo: oneOf(cvDefaults.photo, ENUMS.photo),
      personalDetails: oneOf(cvDefaults.personalDetails, ENUMS.personalDetails),
      length: oneOf(cvDefaults.length, ENUMS.length),
      dateFormat: null,
      format: oneOf(cvDefaults.format, ENUMS.format),
    };
    const from = { photo: null, personalDetails: null, length: null, dateFormat: null, format: null };
    const whence = source === 'generic' ? null : (source === 'country' ? 'country' : 'region');
    for (const f of ['photo', 'personalDetails', 'length', 'format']) if (cv[f]) from[f] = whence;

    if (source === 'region') {
      // A region knows less than a country by construction: only the shared columns move.
      for (const f of ['dateFormat', 'metrics', 'skills', 'summaryWords']) {
        if (regionRow[f] === undefined) continue;
        if (f === 'dateFormat') content._dateFormat = regionRow.dateFormat;
        else if (f === 'summaryWords') content.summaryWords = pair(regionRow.summaryWords, content.summaryWords);
        else content[f] = regionRow[f];
      }
      content._notes = (regionRow.notes || []).slice();
      content._letter = [];
      content._sources = [];
    }

    const override = source === 'country' ? COUNTRY_OVERRIDES[place.iso2] : null;
    if (override) {
      for (const f of CONTENT_FIELDS) {
        if (override[f] === undefined) continue;
        if (f === 'bulletsRecent' || f === 'bulletsOlder' || f === 'summaryWords') content[f] = pair(override[f], content[f]);
        else if (f === 'sectionOrder') content[f] = override[f].filter((k) => SECTION_KEYS.includes(k));
        else content[f] = override[f];
      }
      if (override.dateFormat !== undefined) content._dateFormat = override.dateFormat;
      if (isObj(override.cv)) {
        for (const f of ['photo', 'personalDetails', 'length', 'format']) {
          const v = oneOf(override.cv[f], ENUMS[f]);
          if (v) { cv[f] = v; from[f] = 'country'; }
        }
      }
      content._notes = (override.notes || []).concat(content._notes);
      content._sources = (override.sources || []).concat(content._sources);
    }
    cv.dateFormat = dateOf(content._dateFormat);
    if (cv.dateFormat) from.dateFormat = whence;

    // 3. THE EMPLOYER'S SIZE AND TYPE. Narrow by design — see SIZE_TIERS.
    const tier = tierFor(conv, research);
    const draft = { cv, content };
    let applied = [];
    if (tier && SIZE_TIERS[tier]) {
      applied = (SIZE_TIERS[tier].apply(draft) || []).slice();
      for (const f of applied) if (f.startsWith('cv.')) from[f.slice(3)] = 'size';
      // ⚠️ THE TIER GETS ONE SLOT, AND EXACTLY ONE. The country's own lines are what this module exists to say
      // and the block prints three notes, so a three-note tier in front of them would push the country out of
      // its own block — but appending the tier's notes wholesale was the other failure, and the quieter one:
      // the country's own notes filled all three slots first, so EVERY tier note was structurally unreachable
      // (measured: 0 of 40 country blocks carried one, for every tier except academia, which only got there by
      // silencing the country). "A giant employer gets read differently" then reduced to a reworded metrics
      // line. So the tier's FIRST note is spliced in behind the country's first two, and the rest follow at the
      // back where they belong: two lines of the country, then one of the employer's size.
      const tierNotes = SIZE_TIERS[tier].notes || [];
      if (tierNotes.length) {
        content._notes = content._notes.slice(0, 2).concat(tierNotes.slice(0, 1), content._notes.slice(2), tierNotes.slice(1));
        if (!applied.includes('notes')) applied.push('notes');
      }
    }

    // 4. THE RESEARCHED CONVENTIONS FOR THIS EMPLOYER. A fact observed about this employer beats a country
    // generalisation — unless it was researched for ANOTHER country's hiring, which loses to the local default
    // (designFit.employerContext's W_RESEARCH / W_COUNTRY_DEFAULT / W_FOREIGN_RESEARCH, in the same order).
    if (conv) {
      const convPlace = regionUtil.countryOf(typeof conv.roleCountry === 'string' ? conv.roleCountry : '')
        || regionUtil.countryOf(typeof conv.hqCountry === 'string' ? conv.hqCountry : '');
      const foreign = !!(convPlace && region !== 'generic' && convPlace.region !== region);
      if (!foreign) {
        const convCv = isObj(conv.cv) ? conv.cv : {};
        for (const f of ['photo', 'personalDetails', 'length', 'format']) {
          const v = oneOf(convCv[f], ENUMS[f]);
          if (v) { cv[f] = v; from[f] = 'research'; }
        }
        const d = dateOf(convCv.dateFormat);
        if (d) { cv.dateFormat = d; from.dateFormat = 'research'; }
      }
    }

    // One page cannot hold eight bullets a role: whoever set the page count, the bullet ranges follow it, so
    // the block never asks for a depth the same block's length rule forbids.
    if (cv.length === 'one_page') {
      content.bulletsRecent = [Math.min(content.bulletsRecent[0], 3), Math.min(content.bulletsRecent[1], 4)];
      content.bulletsOlder = [Math.min(content.bulletsOlder[0], 1), Math.min(content.bulletsOlder[1], 2)];
    }

    // ⚠️ THE MERGED ANSWER HAS TO AGREE WITH ITSELF. A tier that drops the summary or moves education cannot
    // leave the country's section order contradicting its own rules three lines later, and a tier that
    // overrode the country's page rule (academia, the public sector) must silence the country notes that
    // state a page count — one rule fewer is always better than two rules that disagree in the same block.
    if (content.summary === 'avoid') content.sectionOrder = content.sectionOrder.filter((k) => k !== 'summary');
    // ⚠️ AND THE SAME FOR THE PERSONAL BLOCK, whichever layer said "avoid". A playbook that leaves
    // 'personal_details' in the order prints "Section order read here: contact → personal details → …" three
    // lines above "leave the date of birth and nationality empty" — and the country notes underneath then ask
    // for the very block the order was told to drop ("keep the supplied personal block intact", "full name and
    // name with initials, date of birth, NIC, civil status"). Four rules, two of them the opposite of the other
    // two, in one block. Worse where the RESEARCH said avoid: applyPersonalDetailsConvention blanks those
    // fields in code afterwards, so the model would be writing a section the lane then deletes.
    // ⚠️ Removal only, never insertion: adding a section a country's own row does not carry would be inventing
    // document structure, and the personal fields exist on the schema whether or not an order names them.
    if (cv.personalDetails === 'avoid') content.sectionOrder = content.sectionOrder.filter((k) => k !== 'personal_details');
    const iEdu = content.sectionOrder.indexOf('education');
    const iExp = content.sectionOrder.indexOf('experience');
    if (iEdu >= 0 && iExp >= 0 && (content.educationPlacement === 'top') !== (iEdu < iExp)) {
      const order = content.sectionOrder.filter((k) => k !== 'education');
      order.splice(order.indexOf('experience') + (content.educationPlacement === 'top' ? 0 : 1), 0, 'education');
      content.sectionOrder = order;
    }
    const silenced = [];   // predicates, because one of them needs two conditions at once
    // ⚠️ THE NOTES BELONG TO THE COUNTRY (or the region), so ANY later layer that moved a value has to silence
    // the note that states the old one — not only the tier. A RESEARCHED page count is the primary path and it
    // was the one left contradicted: the block correctly suppresses its own LENGTH_RULE when the research
    // already stated the length in docFormattingBlock, so the only page sentence left standing in the whole
    // block was the country note disagreeing with it ("one page" from FORMATTING, "three to four pages" from
    // the country notes, in one prompt). Whoever won the length, the country's page note loses.
    if (from.length === 'size' || from.length === 'research') silenced.push((n) => /\bpages?\b/i.test(n));
    // The same for the personal block, whether the "avoid" came from the country override or from the research.
    if (cv.personalDetails === 'avoid') silenced.push((n) => PERSONAL_ITEM.test(n) && PERSONAL_KEEP.test(n));
    if (applied.includes('educationPlacement')) silenced.push((n) => /education[^.]*\b(sits|above|below|first)\b|\b(above|below) experience\b/i.test(n));
    if (applied.includes('summary') && content.summary === 'avoid') silenced.push((n) => /\b(summary|profile|personal statement|objective|accroche)\b/i.test(n));
    if (silenced.length) content._notes = content._notes.filter((n) => !silenced.some((hits) => hits(n)));

    content.notes = [];
    for (const n of content._notes) {
      const s = text(n, 260);
      if (s && !content.notes.some((x) => x.toLowerCase() === s.toLowerCase())) content.notes.push(s);
      if (content.notes.length >= 6) break;
    }
    const sources = [];
    for (const s of content._sources) {
      const u = text(s, 200);
      if (u && /^https?:\/\//i.test(u) && !sources.includes(u)) sources.push(u);
      if (sources.length >= 6) break;
    }
    const letter = content._letter.map((n) => text(n, 200)).filter(Boolean).slice(0, 2);

    const playbook = {
      country: source === 'country' ? place.name : null,
      region,
      profile: source === 'generic' ? 'generic' : profileKey,
      source,
      cv: { photo: cv.photo, personalDetails: cv.personalDetails, length: cv.length, dateFormat: cv.dateFormat, format: cv.format },
      content: {
        projects: content.projects,
        projectDetail: content.projects === 'omit' ? null : content.projectDetail,
        projectPlacement: content.projects === 'omit' ? null : content.projectPlacement,
        experienceDetail: content.experienceDetail,
        bulletsRecent: content.bulletsRecent, bulletsOlder: content.bulletsOlder,
        metrics: content.metrics,
        summary: content.summary, summaryWords: content.summaryWords,
        skills: content.skills,
        educationPlacement: content.educationPlacement,
        sectionOrder: content.sectionOrder,
        notes: content.notes,
      },
      size: { tier: tier || null, applied },
      sources,
    };
    // Provenance and the letter lines ride along invisibly: JSON.stringify and a deep-equal determinism check
    // see exactly the documented shape, while playbookPromptBlock can still tell a researched answer (already
    // in the prompt, from the conventions block) from a country default (its own to say).
    Object.defineProperty(playbook, '_from', { value: from, enumerable: false });
    Object.defineProperty(playbook, '_letter', { value: letter, enumerable: false });
    return playbook;
  } catch (e) {
    return null;
  }
}

// ── The prompt block ──────────────────────────────────────────────────────────────────────────────
const LENGTH_RULE = {
  one_page: 'Length: ONE page. Keep every entry, but give each role at most 3-4 highlights and older roles one or two, and merge minor bullets. Condense — never drop an entry.',
  two_pages: 'Length: up to two pages is normal here — keep the detail the material has rather than cutting highlights to save space.',
  flexible: 'Length: no fixed page limit here — as long as the record genuinely needs, and no longer.',
};
const FORMAT_RULE = {
  tabular: 'Tabular CV: each entry is crisp and factual — period, employer, city, title, then short highlights — because the page is read as a table.',
  europass: 'Europass-style CV: the standard sections in order, and a language level only where the material states it.',
  narrative: 'Profile-led CV: a short professional profile, then achievement bullets under each role.',
  ats_plain: 'Plain single column for screening software: standard section headings, no tables, symbols, emoji or decorative separators, and no ALL-CAPS phrases.',
};
const DETAILS_RULE = {
  include: 'Personal details: employers here expect them — keep the date of birth and nationality exactly as the material states them, and leave them empty where it does not. Never guess one.',
  avoid: 'Personal details: leave the date of birth and nationality empty even where the material states them — they are not expected on a CV here.',
};
const EXPERIENCE_RULE = {
  deep: 'Experience: full depth. Each role carries its scope and responsibilities as well as its results — an achievement-only entry reads as incomplete here.',
  standard: 'Experience: results first, then the responsibility framing behind them.',
  concise: 'Experience: keep the appointment entries light — the itemised lists below carry the document.',
};
const METRICS_RULE = {
  expected: 'Numbers: lead the bullet with the figure the material already states. Where it states none, name the scope it does give (team, volume, cadence, region) — never invent a number or a percentage.',
  welcome: 'Numbers: keep every figure the material states and put it early in its bullet; where there is none, describe the scope instead. Never invent one.',
  sparing: 'Numbers: use only the figures the material states — scope and responsibility carry the entry here.',
};
const SKILLS_RULE = {
  detailed: 'Skills: a categorised block naming every tool, platform and method the material evidences, in the material\'s own words; languages on their own lines with only the levels it states.',
  standard: 'Skills: one compact block of the terms the material evidences, most relevant first. No ratings, bars or percentages.',
  brief: 'Skills: a short plain list of the terms the material evidences. No ratings, bars or percentages.',
};
const SECTION_WORD = {
  contact: 'contact', personal_details: 'personal details', summary: 'summary', skills: 'skills',
  experience: 'experience', projects: 'projects', education: 'education', certifications: 'certifications',
  languages: 'languages', achievements: 'achievements',
};

/** The projects rule — the one place a country convention genuinely contradicts the Anglo default. */
function projectsRule(c, who) {
  if (c.projects === 'omit') return 'Projects: no separate projects section — the work belongs inside the role that ran it.';
  if (c.projects === 'all') {
    // ⚠️ THE INDIAN RULE, AND IT IS NOT A STYLE PREFERENCE. Screening here stack-matches the project inventory
    // before it reads the roles, so a merged or trimmed project list deletes the evidence being looked for.
    // The document's schema has one projects list, so "nested under the employer" is written as: every project
    // its own entry, naming the employer or client it ran for.
    return 'Projects: list EVERY project the material contains — one entry each, none merged, none summarised away, none left out. '
      + 'Each entry names the employer or client it ran for and its duration, the candidate\'s own role, the technology stack the material states for it, and 2-3 responsibility bullets. '
      + 'Nine projects in the material means nine entries. Add length rather than merge two projects, and never invent a project, a client or a technology.';
  }
  if (c.projectPlacement === 'section') {
    return c.projectDetail === 'full'
      ? `Projects: their own section, holding the ones that match this role${who ? ` at ${who}` : ''} — each with its context or client, the candidate's role, the period, the means or stack, and the outcome the material states. Never a project, client or figure the material does not contain.`
      : `Projects: a short projects section of the 2-4 that match this role${who ? ` at ${who}` : ''} — each one line of context, the candidate's part, the stack, and the outcome the material states. Never a full inventory.`;
  }
  return 'Projects: name the projects that matter inside the experience entry that ran them (one line each: what it was, the candidate\'s part, the outcome the material states). A separate projects section only where the employment history is thin.';
}

/**
 * The playbook as a prompt section, or '' when there is nothing actionable to say.
 *
 * ⚠️ FORMAT AND EMPHASIS ONLY, and it says so in its own last two lines. Every rule moves, condenses, orders or
 * re-words the candidate's material; none adds a fact.
 * ⚠️ NO PHOTO RULE, EVER — the photo is a template slot decided by the design ranking, and a model cannot make
 * one. A "German CVs carry a photo" line in a writing prompt is an invitation to invent one.
 * ⚠️ SAID ONCE. Any cv value that came from the employer's own researched conventions is already in the prompt
 * (conventionsPromptBlock + docFormattingBlock), so it is suppressed here; this block speaks only where the
 * country baseline is the answer.
 * ⚠️ THE LETTER VARIANT CARRIES NO CV HABIT — no photo, no personal details, no page count, no date pattern, no
 * CV format, no section order. Those belong to the resume and the letter prompt bans them outright.
 */
function playbookPromptBlock(playbook, company, options) {
  try {
    const pb = playbook;
    if (!isObj(pb) || !isObj(pb.cv) || !isObj(pb.content)) return '';
    const opts = isObj(options) ? options : {};
    const forLetter = opts.forLetter === true;
    const who = text(company, 120);
    const c = pb.content;
    const where = pb.source === 'country' ? text(pb.country, 60)
      : (pb.source === 'region' ? REGION_LABEL[pb.region] || null : null);
    const from = fromOf(pb);
    const rules = [];

    if (forLetter) {
      // Letter-safe only: emphasis, not the document's habits. letterStyleFor already carries the employer
      // type's register and one note per REGION, so these are the country's own lines and the two emphasis
      // rules that follow from what the country reads for — never a restatement of either.
      for (const n of (pb._letter || [])) rules.push(`- ${n}`);
      if (c.metrics === 'expected') rules.push('- Name the concrete results the candidate\'s material states, early — not adjectives about them.');
      else if (c.metrics === 'sparing') rules.push('- Keep to the few figures the material states; scope and responsibility carry more weight here.');
      if (c.experienceDetail === 'deep') rules.push('- Answer what the posting asks for one point at a time, in its own terms, using only experience the material describes.');
      if (!rules.length) return '';
      return [
        where ? `=== HOW A COVER LETTER READS IN ${where.toUpperCase()} ===` : '=== HOW A COVER LETTER READS (GENERAL CONVENTION) ===',
        ...rules,
        '- These are habits of the place, not facts about the candidate: never add anything their material does not contain, and never mention this guidance.',
      ].join('\n');
    }

    rules.push(`- ${projectsRule(c, who)}`);
    rules.push(`- ${EXPERIENCE_RULE[c.experienceDetail] || EXPERIENCE_RULE.standard} Recent roles carry ${c.bulletsRecent[0]}-${c.bulletsRecent[1]} highlights, older ones ${c.bulletsOlder[0]}-${c.bulletsOlder[1]}. Condense an older role — never drop it.`);
    rules.push(`- ${METRICS_RULE[c.metrics] || METRICS_RULE.welcome}`);
    // ⚠️ THE SUMMARY'S SIZE IS NOT THIS BLOCK'S TO STATE, so it no longer states one. The doc prompt that
    // carries this block already fixes the shape twice and unconditionally — "a tight paragraph of 3-4
    // sentences … then exactly 3 bullets" in its WRITING RULES, and the same sentence again in its REQUIRED
    // OUTPUT SCHEMA (resumeBuilderController). That shape runs ~75-115 words, so every word band this table
    // holds (12 distinct ones, most below 70) was a second, unreachable budget in the same prompt — and the
    // model picks between two budgets non-deterministically, under a fingerprint that does not hash prompt
    // text, which makes both answers cache-interchangeable for ever. summaryWords stays a column of the
    // merged answer (it is the country's researched guidance, and academia zeroes it); what this block says
    // is only what it alone knows: whether a summary is read here at all, and what it must earn.
    // ⚠️ "optional" is EMPHASIS, never permission to return an empty field: the schema makes `summary`
    // required, and an empty one silently costs the corrective pass its two strongest sameness signals
    // (docSamenessOf's summarySim and openingSim both go null). So the DACH convention — the table speaks for
    // itself, a profile is worth it for a career changer or a senior hire — is said as a BAR to clear.
    // ⚠️ AND NEITHER IS ITS EXISTENCE — the same lesson one step further, and the expensive half. "avoid" (the
    // academia tier, the only layer that sets it) used to print "No summary or objective paragraph", into a
    // prompt that orders the summary WRITTEN four times over: the WRITING RULES, the REQUIRED OUTPUT SCHEMA,
    // docTopLinesBlock's "summary, first sentence: LEAD with …" and — for this very tier — "Emphasis
    // (academia): … lead the summary with them". One line against four, with no tie-break, and honouring the
    // one was the costly branch: docSummaryTextOf then reads '', summarySim and openingSim both go null, and
    // the corrective pass on a document the user has already paid for collapses to the title plus the
    // highlights share. So "avoid" says what it alone knows — the REGISTER this opening is written in — and
    // never that the field may be left out. The merged answer still carries summary 'avoid': it is the true
    // convention, and it is what zeroes summaryWords, drops the summary from the section ORDER (a list of what
    // the reader ranks, not of what the schema carries) and silences the country's own profile note.
    if (c.summary === 'avoid') rules.push('- Summary: this document is read record-first, so the opening states rather than sells — only what the entries below already evidence, in their own register. Never a profile that would suit any employer, and never a sentence those entries do not carry.');
    else if (c.summary === 'optional') rules.push('- Summary: it earns its place here only by saying something the entries themselves do not — the dated record is what is read first, so never restate the timeline in prose.');
    else rules.push('- Summary: written for this role from the material\'s own facts — never a general profile that would suit any employer.');
    rules.push(`- ${SKILLS_RULE[c.skills] || SKILLS_RULE.standard}`);
    // Order and education placement travel on ONE line: the corrective pass re-sends this whole prompt, so every
    // rule is paid for twice and the block is kept to docFormattingBlock's order of size (≤13 rules + 2 closers).
    const edu = c.educationPlacement === 'top' ? 'ABOVE experience here' : 'BELOW experience, one or two lines per entry';
    rules.push(c.sectionOrder.length
      ? `- Section order read here: ${c.sectionOrder.map((k) => SECTION_WORD[k] || k).join(' → ')} — education sits ${edu}.`
      : `- Education sits ${edu}.`);
    // The cv.* rules the employer's own research did NOT already put in this prompt.
    if (pb.cv.length && from.length !== 'research' && LENGTH_RULE[pb.cv.length]) rules.push(`- ${LENGTH_RULE[pb.cv.length]}`);
    if (pb.cv.dateFormat && from.dateFormat !== 'research') rules.push(`- Dates: write every start and end date as ${pb.cv.dateFormat} ("Present" for an ongoing role); an education year alone is fine where the material gives only a year.`);
    if (pb.cv.personalDetails && from.personalDetails !== 'research' && DETAILS_RULE[pb.cv.personalDetails]) rules.push(`- ${DETAILS_RULE[pb.cv.personalDetails]}`);
    if (pb.cv.format && from.format !== 'research' && FORMAT_RULE[pb.cv.format]) rules.push(`- ${FORMAT_RULE[pb.cv.format]}`);
    for (const n of c.notes.slice(0, 3)) rules.push(`- ${n}`);

    return [
      where ? `=== HOW A CV IS WRITTEN IN ${where.toUpperCase()} ===` : '=== HOW A CV IS WRITTEN (GENERAL CONVENTION) ===',
      ...rules,
      '- These rules change FORMAT and EMPHASIS only: what is named first, what is condensed, how much detail each role carries. They NEVER add a fact — no photo, no date of birth, no nationality, no project, no client, no technology, no date and no number that the candidate\'s own material does not already contain.',
      `- Never mention${who ? ` ${who},` : ''} this guidance or these conventions anywhere in the resume.`,
    ].join('\n');
  } catch (e) {
    return '';
  }
}

module.exports = {
  playbookFor,
  playbookPromptBlock,
  // exposed for tests / diagnostics only
  _internals: {
    CV_PLAYBOOKS, COUNTRY_OVERRIDES, REGION_ROWS, REGION_LABEL, GENERIC_ROW, SIZE_TIERS,
    SECTION_KEYS, ENUMS, DATE_RE, CONTENT_FIELDS, tierFor, headcountOf, conventionsOf, fromOf, text,
  },
};
