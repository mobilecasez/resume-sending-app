// AI Hub — new feature. Safe to delete without affecting existing app.
//
// A signed-out preview of the employer Home, for LOOKING AT IT.
//
// The first build of that screen shipped a duplicate header and hard-edged rectangles across the
// hero — both instantly obvious on screen and both invisible to a type-check. This route renders
// the real component against fixtures so the design can be inspected without an account, which is
// how those two were found and how the next one will be.
//
// ⚠️ THE FIXTURES MUST MATCH THE REAL SHAPE OF THE SCREEN, not a convenient subset. An earlier
// version supplied four cards, so the preview showed four designs while the real app offers the
// whole catalogue — and the preview was then used to judge a feature it was not exercising. The
// catalogue below mirrors the server's 15 families and their recolour variants.
//
// Reachable only by deep link (cvapplyr://dev/home-preview) — nothing in the app links here.
// Add ?sample=1 to see the brand-new-account state (sample pages, no saved documents).
//
// ⚠️ THE SAVED DOCUMENTS ARE FIXTURES TOO, AND THEY REPLACE THE NETWORK. Every employer now has its
// own resume and letter with a ranked design list, so the loaders below answer the three document
// reads (doc / docCards / docList) — one chip with a ranked deck and fit badges, one whose document is
// stale (the Refresh pill), and chips with nothing saved (the Tailor / Write action). Nothing here can
// start a build: this harness has no account, and a build needs one.
//
// ⚠️ A LETTER PAGE HAS BOTH DOORS NOW, AND A LIBRARY CARD OPENS A PAGE (2026-09-13). A zoomed cover letter
// offers Customize and View PDF like a resume, and a card under "Your library" opens the same zoom instead of
// downloading — so the library fixtures cover every way a card resolves (EmployerHome.openHistoryItem):
//   • a saved document whose page the deck on screen already has — the Airbus "Executive Professional"
//     card (the Airbus chip leads, and that design tops its ranking, so the deck's first wave renders it);
//   • a saved document whose page is not in hand, filled from `docCards` — Eneco's locked card, whose
//     document is not the one on screen at all, and the Azure Airbus card behind "See all";
//   • nothing saved — the ASML resume card opens the base resume in that design (Bold Banner is one of
//     the five base pages the `cards` fixture has);
//   • a letter with a saved letter — the Airbus letter cards (one locked: looking is free, the padlock is
//     about downloading), and the Airbus chip's own letter deck in Letter mode;
//   • a letter with NOTHING to preview — the Siemens letter card falls back to getting the file, which
//     signed out is a "Preview only" alert, as are the letter's Customize and View PDF.
//
// ⚠️ THE LIBRARY IS A SHELF OF PAPER CARDS, TWO TO A LINE (2026-09-15), and its picture comes per card from
// EmployerHome.imageFor — the employer's own page when it is in hand, the base page in that design for a
// resume, nothing for a letter (the drawn letter page). So the resume-mode fixture is FIVE MIXED CARDS: four
// resumes (one locked, one downloaded twice, three employers so three ribbon colours) plus ONE COVER LETTER
// card, so both kinds of paper — a rendered page and the drawn letter — sit side by side in one grid and can
// be judged together, and "See all 5" is on screen behind the four the collapsed shelf shows. The server
// never mixes kinds in one list; the harness does, on purpose, and the card decides by its own `kind`.
//
// ⚠️ THE TAILOR HINT AND THE CONFIRM SHEET (2026-09-14). ?hint=1 leads the chip row with iwell B.V., which has
// nothing saved in either kind, so the first paint is the base resume with the "Scroll down to tailor…" pill
// over it (and, in Letter mode, "…write your cover letter…"). The `confirm` loader answers what the sheet
// would say for a chip, so Tailor / Write / Refresh OPEN it in every state worth looking at:
//   resume — iwell: NONE LEFT on the free allowance (the $0.99 once + See plans sheet) · Airbus Team Lead:
//            12 of 15 left this month on Plus · Eneco's Refresh: 2 of 3 free left;
//   letter — iwell: covered by the one-time pass for iwell · Airbus Team Lead: 2 of 3 free left ·
//            Eneco: none left this month on Plus.
// Every button on that sheet is a close or a "Preview only" alert: nothing here builds or buys.
// ?empty=1 empties the library, so the "Nothing downloaded yet" card can be checked at any width/text size.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import EmployerHome from '../../components/employer-home/EmployerHome';
import { E } from '../../components/employer-home/theme';
import { LETTER_DESIGNS } from '../../services/employerHomeService';
import type { Target, HomeCard, DownloadHistoryItem } from '../../services/employerHomeService';
import type { DocKind } from '../../services/homeAddEmployer';
import type { useHomeBuilds } from '../../components/employer-home/useHomeBuilds';
import type { DocMeta, DocLookup, DocCard, DocListItem } from '../../services/employerDocs';

// ── Paper, drawn six ways, so the deck reads as genuinely different LAYOUTS and not one design
// recoloured. Each returns a data URI the carousel can lay out without a server round-trip.
type Shape = 'banner' | 'rightrail' | 'sidebar' | 'minimal' | 'timeline' | 'mono';

const lines = (x: number, y: number, w: number, n: number, c = '#E7ECF4', gap = 14) =>
  Array.from({ length: n }, (_, i) =>
    `<rect x="${x}" y="${y + i * gap}" width="${Math.round(w * (i % 3 === 2 ? 0.72 : 1))}" height="6" rx="3" fill="${c}"/>`).join('');

const heading = (x: number, y: number, accent: string, w = 66) =>
  `<rect x="${x}" y="${y}" width="${w}" height="7" rx="3" fill="${accent}"/>`;

// ⚠️ SOME PAGES ARE TALLER THAN THE CARD, on purpose. A real resume rendered in A4 mode runs to
// two pages, so its thumbnail is far taller than the card's own ratio and MUST be cropped to fit.
// Fixtures that all happened to match the card exactly never exercised that, which is how a
// centre-cropped page — losing the candidate's name off the top — went unnoticed here.
function paper(accent: string, shape: Shape, tall = false) {
  const body = {
    banner: `
      <rect width="300" height="86" fill="${accent}"/>
      <circle cx="42" cy="43" r="20" fill="rgba(255,255,255,0.9)"/>
      <rect x="74" y="30" width="150" height="10" rx="4" fill="rgba(255,255,255,0.95)"/>
      <rect x="74" y="48" width="96" height="7" rx="3" fill="rgba(255,255,255,0.6)"/>
      ${[0, 1, 2].map((b) => heading(22, 112 + b * 92, accent) + lines(22, 128 + b * 92, 256, 3)).join('')}`,
    rightrail: `
      <rect x="206" width="94" height="424" fill="${accent}14"/>
      <rect x="222" y="26" width="62" height="62" rx="31" fill="${accent}33"/>
      ${lines(222, 104, 62, 6, accent + '44', 12)}
      <rect x="22" y="26" width="150" height="12" rx="5" fill="#111827"/>
      <rect x="22" y="46" width="104" height="7" rx="3" fill="#9AA6B8"/>
      ${[0, 1, 2].map((b) => heading(22, 80 + b * 104, accent) + lines(22, 96 + b * 104, 160, 4)).join('')}`,
    sidebar: `
      <rect width="104" height="424" fill="${accent}"/>
      <circle cx="52" cy="54" r="26" fill="rgba(255,255,255,0.9)"/>
      ${lines(18, 100, 68, 7, 'rgba(255,255,255,0.45)', 12)}
      <rect x="124" y="26" width="150" height="12" rx="5" fill="#111827"/>
      <rect x="124" y="46" width="96" height="7" rx="3" fill="#9AA6B8"/>
      ${[0, 1, 2].map((b) => heading(124, 80 + b * 104, accent, 54) + lines(124, 96 + b * 104, 152, 4)).join('')}`,
    minimal: `
      <rect x="22" y="30" width="168" height="13" rx="5" fill="#111827"/>
      <rect x="22" y="52" width="112" height="7" rx="3" fill="#9AA6B8"/>
      <rect x="22" y="74" width="256" height="1" fill="${accent}"/>
      ${[0, 1, 2, 3].map((b) => heading(22, 92 + b * 78, accent, 52) + lines(22, 106 + b * 78, 256, 3)).join('')}`,
    timeline: `
      <rect x="22" y="26" width="150" height="12" rx="5" fill="#111827"/>
      <rect x="22" y="46" width="96" height="7" rx="3" fill="#9AA6B8"/>
      <rect x="40" y="78" width="2" height="300" fill="${accent}33"/>
      ${[0, 1, 2, 3].map((b) => `
        <circle cx="41" cy="${92 + b * 72}" r="6" fill="${accent}"/>
        ${heading(58, 88 + b * 72, accent, 60)}${lines(58, 104 + b * 72, 214, 2)}`).join('')}`,
    mono: `
      <rect width="300" height="424" fill="#FAFBFD"/>
      <rect x="22" y="28" width="140" height="11" rx="2" fill="#111827"/>
      <rect x="22" y="46" width="92" height="7" rx="2" fill="${accent}"/>
      ${[0, 1, 2, 3].map((b) => `
        <rect x="22" y="${78 + b * 80}" width="46" height="7" rx="2" fill="${accent}"/>
        ${lines(22, 94 + b * 80, 256, 3, '#E3E8F0', 13)}`).join('')}`,
  }[shape];
  const h = tall ? 760 : 424;
  const tailBlocks = tall
    ? [0, 1, 2, 3].map((b) => heading(22, 440 + b * 78, accent, 52) + lines(22, 456 + b * 78, 256, 3)).join('')
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${h}" viewBox="0 0 300 ${h}">
  <rect width="300" height="${h}" fill="#fff"/>${body}${tailBlocks}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// The 15 families the server actually ships, each with its recolour variants — same shape the
// metadata endpoint returns, so the preview exercises the real paging behaviour.
const FAMILIES: Array<{ id: string; name: string; shape: Shape; tints: Array<[string, string]> }> = [
  { id: 'banner',    name: 'Bold Banner',           shape: 'banner',    tints: [['', '#1d4ed8'], ['Crimson', '#b91c1c'], ['Teal', '#0f766e'], ['Plum', '#7e22ce'], ['Amber', '#b45309'], ['Slate', '#334155']] },
  { id: 'rightrail', name: 'Right Rail',            shape: 'rightrail', tints: [['', '#0f766e'], ['Sapphire', '#1d4ed8'], ['Plum', '#7e22ce'], ['Rose', '#be123c'], ['Olive', '#4d7c0f'], ['Ink', '#1f2937']] },
  { id: 'azure',     name: 'Azure Sidebar',         shape: 'sidebar',   tints: [['', '#2563eb'], ['Emerald', '#059669'], ['Violet', '#7c3aed'], ['Coral', '#e11d48'], ['Steel', '#475569']] },
  { id: 'minimal',   name: 'Modern Minimal',        shape: 'minimal',   tints: [['', '#111827'], ['Indigo', '#4338ca'], ['Rose', '#be123c'], ['Forest', '#166534']] },
  { id: 'timeline',  name: 'Career Timeline',       shape: 'timeline',  tints: [['', '#ea580c'], ['Sky', '#0284c7'], ['Jade', '#047857'], ['Berry', '#a21caf'], ['Graphite', '#374151'], ['Gold', '#a16207']] },
  { id: 'mono',      name: 'Tech Mono',             shape: 'mono',      tints: [['', '#0f172a'], ['Amber', '#b45309'], ['Cobalt', '#1e40af'], ['Moss', '#3f6212'], ['Rust', '#9a3412'], ['Orchid', '#86198f']] },
  { id: 'elegant',   name: 'Elegant Serif',         shape: 'minimal',   tints: [['', '#7f1d1d'], ['Midnight', '#1e293b'], ['Hunter', '#14532d'], ['Bronze', '#92400e'], ['Wine', '#831843'], ['Ash', '#44403c']] },
  { id: 'executive', name: 'Executive Dark',        shape: 'sidebar',   tints: [['', '#0f172a'], ['Platinum', '#475569'], ['Emerald', '#065f46'], ['Navy', '#1e3a8a']] },
  { id: 'ats',       name: 'ATS Modern',            shape: 'minimal',   tints: [['', '#1f2937'], ['Navy', '#1e3a8a'], ['Green', '#15803d'], ['Maroon', '#7f1d1d']] },
  { id: 'exec_pro',  name: 'Executive Professional', shape: 'rightrail', tints: [['', '#1e293b'], ['Steel', '#475569'], ['Royal', '#1d4ed8'], ['Forest', '#166534']] },
  { id: 'compact',   name: 'Compact Pro',           shape: 'mono',      tints: [['', '#0e7490'], ['Sapphire', '#1d4ed8'], ['Evergreen', '#15803d'], ['Clay', '#9a3412'], ['Iris', '#6d28d9'], ['Char', '#292524']] },
  { id: 'startup',   name: 'Startup Modern',        shape: 'banner',    tints: [['', '#7c3aed'], ['Coral', '#e11d48'], ['Mint', '#0d9488'], ['Sun', '#ca8a04'], ['Ocean', '#0369a1']] },
  { id: 'india',     name: 'India Professional',    shape: 'minimal',   tints: [['', '#b45309'], ['Saffron', '#c2410c'], ['Emerald', '#047857'], ['Indigo', '#4338ca']] },
  { id: 'germany',   name: 'Germany Professional',  shape: 'sidebar',   tints: [['', '#334155'], ['Blue', '#1d4ed8'], ['Warm', '#92400e']] },
  { id: 'europass',  name: 'Europass Premium',      shape: 'rightrail', tints: [['', '#1e40af'], ['Teal', '#0f766e'], ['Violet', '#6d28d9'], ['Slate', '#334155']] },
];

const CATALOGUE: HomeCard[] = FAMILIES.flatMap((f, fi) =>
  f.tints.map(([suffix, accent], vi) => ({
    id: suffix ? `${f.id}_${suffix.toLowerCase()}` : f.id,
    name: suffix ? `${f.name} · ${suffix}` : f.name,
    accent,
    // Every third page runs long, so the deck contains both shapes the real one does.
    image: paper(accent, f.shape, (fi + vi) % 3 === 0),
  })),
);

// ⚠️ Airbus appears TWICE on purpose: a chip identifies a posting, not a company, and two roles at
// one employer are two different applications. If this ever collapses back to one Airbus chip, the
// per-posting behaviour has regressed.
// Each posting carries its URL: a saved document is found by (employer, posting URL), so without one
// the two Airbus roles would share a document — the exact bug the URL identity exists to prevent.
const TARGETS: Target[] = [
  { key: 'job_a1', jobId: 'a1', applyUrl: 'https://careers.airbus.com/job/senior-software-engineer-a1', company: 'Airbus', role: 'Senior Software Engineer', initial: 'A', colors: ['#4F8DFF', '#7C6BFF'], match: 100, skills: ['C++', 'Embedded', 'DO-178C'], location: 'Toulouse' },
  { key: 'job_a2', jobId: 'a2', applyUrl: 'https://careers.airbus.com/job/team-lead-a2', company: 'Airbus', role: 'Team Lead', initial: 'A', colors: ['#4F8DFF', '#7C6BFF'], match: 88, skills: ['Leadership', 'Agile'], location: 'Hamburg' },
  { key: 'job_i1', jobId: 'i1', applyUrl: 'https://iwell.nl/vacatures/senior-net-developer-i1', company: 'iwell B.V.', role: 'Senior .NET Developer', initial: 'I', colors: ['#7C6BFF', '#DB2777'], match: 94, skills: ['.NET Core', 'Azure', 'React'], location: 'Amsterdam' },
  { key: 'job_e1', jobId: 'e1', applyUrl: 'https://werkenbij.eneco.nl/vacature/platform-engineer-e1', company: 'Eneco', role: 'Platform Engineer', initial: 'E', colors: ['#10B981', '#06B6D4'], match: 78, skills: ['Azure', 'SAP'], location: 'Rotterdam' },
];

// ── A cover letter, drawn: letterhead band, sender block, subject, three paragraphs, sign-off. ──
function letterPaper(accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="424" viewBox="0 0 300 424">
  <rect width="300" height="424" fill="#fff"/>
  <rect width="300" height="9" fill="${accent}"/>
  <rect x="22" y="32" width="124" height="11" rx="4" fill="#111827"/>
  <rect x="22" y="50" width="88" height="6" rx="3" fill="#9AA6B8"/>
  <rect x="196" y="32" width="82" height="6" rx="3" fill="#C9D2E0"/>
  <rect x="210" y="44" width="68" height="6" rx="3" fill="#C9D2E0"/>
  <rect x="22" y="84" width="96" height="7" rx="3" fill="${accent}"/>
  ${lines(22, 108, 256, 5)}${lines(22, 188, 256, 5)}${lines(22, 268, 256, 4)}
  <rect x="22" y="344" width="86" height="18" rx="4" fill="${accent}26"/>
  <rect x="22" y="372" width="72" height="6" rx="3" fill="#9AA6B8"/></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// ── Saved per-employer documents, ranked the way the server ranks them ─────────────────────────────
// ⚠️ EVERY DESIGN, NOT A TOP FEW. The server's invariant is that `ranked` lists every template id of
// its kind exactly once, sorted best first; a fixture with five entries would let a deck that drops
// unranked designs look correct here. Scores are per family, each recolour one point below the last.
const FIXTURE_AT = '2026-09-09T09:30:00.000Z';
const FAMILY_OF = new Map<string, string>(
  FAMILIES.flatMap((f) => f.tints.map(([suffix]) => [suffix ? `${f.id}_${suffix.toLowerCase()}` : f.id, f.id] as [string, string])),
);

type FamilyFit = Record<string, [number, string]>;

function rankedResume(fit: FamilyFit) {
  return CATALOGUE
    .map((c, order) => {
      const fam = FAMILY_OF.get(c.id) || c.id;
      const [base, reason] = fit[fam] || [40, ''];
      const step = FAMILIES.find((f) => f.id === fam)?.tints.findIndex(([suffix]) => (suffix ? `${fam}_${suffix.toLowerCase()}` : fam) === c.id) ?? 0;
      return { id: c.id, score: Math.max(0, base - Math.max(0, step)), reason, order };
    })
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .map(({ order, ...r }) => r);
}

function rankedLetter(scores: Record<string, [number, string]>) {
  return LETTER_DESIGNS
    .map((d, order) => ({ id: d.id, score: (scores[d.id] || [30, ''])[0], reason: (scores[d.id] || [30, ''])[1], order }))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .map(({ order, ...r }) => r);
}

const AIRBUS_FIT: FamilyFit = {
  exec_pro: [94, 'Understated two-column layout that aerospace hiring panels read quickly'],
  ats: [91, 'Parses cleanly in the large ATS a 130,000-person employer screens with'],
  executive: [87, 'Senior engineering weight without looking like a sales deck'],
  europass: [84, 'A familiar EU format for a Toulouse and Hamburg employer'],
  minimal: [82, 'Quiet single column that keeps the certifications easy to find'],
  elegant: [78, 'Conservative serif tone that suits an established industrial brand'],
  germany: [74, 'Works for the German sites, though the photo slot is optional here'],
  compact: [70, 'Fits a long embedded career on fewer pages'],
  azure: [64, ''], rightrail: [61, ''], mono: [58, ''], timeline: [55, ''],
  india: [47, ''], banner: [44, ''], startup: [38, 'Reads as a start-up, not a safety-critical engineering team'],
};

const ENECO_FIT: FamilyFit = {
  mono: [89, 'Tooling-first layout for a platform team that lists its stack'],
  compact: [86, 'Dense, scannable one-pager for a hands-on engineering role'],
  minimal: [83, 'Clean single column, the Dutch default for technical roles'],
  europass: [80, ''], ats: [78, ''], rightrail: [72, ''], azure: [70, ''], timeline: [66, ''],
  startup: [62, ''], exec_pro: [58, ''], banner: [55, ''], elegant: [50, ''], executive: [46, ''],
  germany: [44, ''], india: [40, ''],
};

const DOCS: DocMeta[] = [
  {
    docId: 101, kind: 'resume', employer: 'Airbus', employerId: null,
    jobUrl: TARGETS[0].applyUrl || '', jobTitle: 'Senior Software Engineer',
    createdAt: FIXTURE_AT, updatedAt: FIXTURE_AT, editedAt: null, stale: false,
    design: {
      v: 1, kind: 'resume', ranked: rankedResume(AIRBUS_FIT), mode: 'a4', brandColor: '#00205b',
      // The employer's own colour and face, as brandExtract reads them off its website: the deck's
      // skeletons and the shelf's placeholders tint with it, and the renderer recolours the design to it.
      brand: { accent: '#00205b', font: { family: 'Inter', google: true } },
      tone: 'Conservative enterprise', region: 'eu',
      headline: 'Airbus screens senior engineers through a large ATS: a restrained two-column page reads best.',
    },
    summary: { title: 'Senior Embedded Software Engineer', subject: '' },
  },
  {
    // STALE on purpose: the Refresh pill is a state worth looking at.
    docId: 103, kind: 'resume', employer: 'Eneco', employerId: null,
    jobUrl: TARGETS[3].applyUrl || '', jobTitle: 'Platform Engineer',
    createdAt: FIXTURE_AT, updatedAt: FIXTURE_AT, editedAt: null, stale: true,
    design: {
      v: 1, kind: 'resume', ranked: rankedResume(ENECO_FIT), mode: 'onepage', brandColor: '#e4003a',
      // A brand with a colour but no web font: the renderer recolours and leaves the face alone.
      brand: { accent: '#e4003a', font: null },
      tone: 'Hands-on engineering', region: 'eu',
      headline: 'A platform team reads the stack first — a tooling-led one-pager puts it at the top.',
    },
    summary: { title: 'Platform Engineer', subject: '' },
  },
  {
    docId: 201, kind: 'cover_letter', employer: 'Airbus', employerId: null,
    jobUrl: TARGETS[0].applyUrl || '', jobTitle: 'Senior Software Engineer',
    createdAt: FIXTURE_AT, updatedAt: FIXTURE_AT, editedAt: null, stale: false,
    design: {
      v: 1, kind: 'cover_letter', mode: 'a4', brandColor: '#00205b', tone: 'Evidence first', region: 'eu',
      brand: { accent: '#00205b', font: { family: 'Inter', google: true } },
      ranked: rankedLetter({
        technical: [92, 'Leads with the certified embedded work the posting asks for'],
        ats_pro: [88, 'Plain structure that survives an enterprise applicant system'],
        euro_motivation: [83, 'The motivation-letter shape French and German reviewers expect'],
        standard: [79, 'Carries the Airbus letterhead colour'],
        german: [71, ''], exec_leader: [60, ''], graduate: [34, 'Written for a first job, not twelve years of experience'],
      }),
      headline: 'An engineering panel wants the proof first: the technical format opens with it.',
    },
    summary: { title: '', subject: 'Application: Senior Software Engineer' },
  },
];

const sameText = (a?: string | null, b?: string | null) => String(a || '').trim() === String(b || '').trim();

const DOC_LOADERS = {
  doc: async (kind: DocKind, q: DocLookup): Promise<DocMeta | null> =>
    DOCS.find((d) => d.kind === kind && sameText(d.employer, q.employer) && sameText(d.jobUrl, q.jobUrl)) || null,
  docCards: async (kind: DocKind, docId: number, ids: string[]): Promise<{ cards: DocCard[] } | 'gone'> => {
    const d = DOCS.find((x) => x.docId === docId && x.kind === kind);
    if (!d) return 'gone';
    const ranked = new Map((d.design?.ranked || []).map((r) => [r.id, r] as const));
    const cards: DocCard[] = [];
    for (const id of ids) {
      const r = ranked.get(id);
      const fit = r ? r.score : null;
      const reason = r && r.reason ? r.reason : null;
      if (kind === 'cover_letter') {
        const l = LETTER_DESIGNS.find((x) => x.id === id);
        if (l) cards.push({ id: l.id, name: l.name, accent: l.accent, image: letterPaper(l.accent), fit, reason });
      } else {
        const c = CATALOGUE.find((x) => x.id === id);
        if (c) cards.push({ id: c.id, name: c.name, accent: c.accent, image: c.image, fit, reason });
      }
    }
    return { cards };
  },
  docList: async (kind: DocKind): Promise<DocListItem[]> => DOCS
    .filter((d) => d.kind === kind)
    .map((d) => ({
      docId: d.docId, employer: d.employer, employerId: d.employerId, jobUrl: d.jobUrl, jobTitle: d.jobTitle,
      updatedAt: d.updatedAt, topId: d.design?.ranked[0]?.id ?? null, topScore: d.design?.ranked[0]?.score ?? null,
    })),
};

/**
 * ── THE X AND ITS UNDO, SIGNED OUT ────────────────────────────────────────────────────────────────
 * Removing a chip talks to the server (untrack an employer, hide a posting) and so does Undo, so without
 * these two the harness could not exercise the one destructive action on this screen — the one with no
 * dialog in front of it. They answer locally and REMEMBER what is hidden, so the chip stays gone across a
 * reload and Undo brings it back, exactly as it behaves with an account.
 * ⚠️ Nothing here reaches the network: EmployerHome routes both sides through these whenever `loaders` is
 * present, and treats a loader the harness did not supply as a local success.
 */
const HIDDEN = new Set<string>();

/**
 * ── WHAT THE CONFIRM SHEET SAYS, PER CHIP AND KIND ────────────────────────────────────────────────────────────
 * The shape a real gate read hands the sheet (usage + pass); `mode` is 'empty' exactly when nothing covers the
 * build. Keyed by the chip's jobId, so the two Airbus roles can answer differently.
 */
type Confirm = ReturnType<typeof useHomeBuilds>['confirm'];
type Ask = { mode: Confirm['mode']; usage: Confirm['usage']; pass: Confirm['pass'] };
const NO_PASS = { available: false, forThisEmployer: false };
const ASKS: Record<DocKind, Record<string, Ask>> = {
  resume: {
    i1: { mode: 'empty', usage: { kind: 'resume', pool: 'free', planLabel: null, remaining: 0, allowance: 3, used: 3, oneTime: true }, pass: NO_PASS },
    a2: { mode: 'confirm', usage: { kind: 'resume', pool: 'plan', planLabel: 'Plus', remaining: 12, allowance: 15, used: 3, oneTime: false }, pass: NO_PASS },
    e1: { mode: 'confirm', usage: { kind: 'resume', pool: 'free', planLabel: null, remaining: 2, allowance: 3, used: 1, oneTime: true }, pass: NO_PASS },
  },
  cover_letter: {
    i1: { mode: 'confirm', usage: { kind: 'cover_letter', pool: null, planLabel: null, remaining: 0, allowance: 3, used: 3, oneTime: true }, pass: { available: true, forThisEmployer: true } },
    a2: { mode: 'confirm', usage: { kind: 'cover_letter', pool: 'free', planLabel: null, remaining: 2, allowance: 3, used: 1, oneTime: true }, pass: NO_PASS },
    e1: { mode: 'empty', usage: { kind: 'cover_letter', pool: 'plan', planLabel: 'Plus', remaining: 0, allowance: 25, used: 25, oneTime: false }, pass: NO_PASS },
  },
};

export default function HomePreview() {
// `?sample=1` is the brand-new account: stand-in pages and nothing saved yet.
const { sample: sampleParam, hint: hintParam, empty: emptyParam } = useLocalSearchParams<{ sample?: string; hint?: string; empty?: string }>();
const showSample = sampleParam === '1' || sampleParam === 'true';
// `?hint=1`: a chip with nothing saved leads, so the Tailor hint is on the first paint.
const leadUntailored = hintParam === '1' || hintParam === 'true';
// `?empty=1`: nothing downloaded yet — the library's empty card.
const emptyLibrary = emptyParam === '1' || emptyParam === 'true';
const DAY = 86400000;
// Fixed offsets from a fixed epoch: a fixture that used Date.now() would render differently on
// every run and make a visual diff of this screen worthless.
const T0 = Date.parse('2026-09-09T10:00:00Z');
// ⚠️ THREE DIFFERENT COLOUR PAIRS IN THE VISIBLE FOUR, DELIBERATELY. gradFor hashes the company name
// into one of seven pairs, so real companies collide often — Airbus, Zalando and Siemens ALL land on
// the same amber, which is why the base-page card is ASML (purple) and the locked card is Eneco's (teal).
// A fixture that shows one colour four times cannot tell you whether the ribbon and the wash are working,
// which is the whole reason this harness exists. The locked card is kept inside the visible four for the
// same reason: the padlock is the state most worth looking at — and so are the letter card (the drawn
// letter page next to a rendered resume page), the "×2" and the one WORD file.
const RESUME_HISTORY: DownloadHistoryItem[] = [
  // Nothing saved for ASML: the base resume in that design (Bold Banner is one of the five base pages).
  { id: 6, kind: 'resume', employer: 'ASML', templateId: 'banner', templateName: 'Bold Banner', format: 'pdf', mode: 'a4', times: 1, downloadedAt: new Date(T0).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 3, kind: 'resume', employer: 'Airbus', templateId: 'exec_pro', templateName: 'Executive Professional', format: 'pdf', mode: 'onepage', times: 2, downloadedAt: new Date(T0 - 2 * DAY).toISOString(), ownsEmployer: true, unlocked: true },
  // ⚠️ A LETTER IN THE RESUME LIST — harness only (see the header): the drawn letter page beside a real one.
  { id: 9, kind: 'cover_letter', employer: 'Airbus', templateId: 'technical', templateName: 'Technical Specialist', format: 'pdf', mode: 'a4', times: 1, downloadedAt: new Date(T0 - 3 * DAY).toISOString(), ownsEmployer: true, unlocked: true },
  // Eneco has a saved (stale) resume that is not the chip on screen, so its card's page comes from docCards —
  // and it is the LOCKED one: looking is free, the padlock is about downloading it again.
  { id: 4, kind: 'resume', employer: 'Eneco', templateId: 'mono', templateName: 'Tech Mono', format: 'docx', mode: '', times: 1, downloadedAt: new Date(T0 - 40 * DAY).toISOString(), ownsEmployer: false, unlocked: false },
  // Behind "See all 5".
  { id: 2, kind: 'resume', employer: 'Airbus', templateId: 'azure', templateName: 'Azure Sidebar', format: 'pdf', mode: 'a4', times: 1, downloadedAt: new Date(T0 - 9 * DAY).toISOString(), ownsEmployer: true, unlocked: true },
];
// Siemens has no saved letter (nothing to preview: the file fallback); both Airbus rows open letter 201.
const LETTER_HISTORY: DownloadHistoryItem[] = [
  { id: 8, kind: 'cover_letter', employer: 'Siemens', templateId: 'german', templateName: 'German Professional', format: 'docx', mode: 'a4', times: 1, downloadedAt: new Date(T0 - DAY).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 9, kind: 'cover_letter', employer: 'Airbus', templateId: 'technical', templateName: 'Technical Specialist', format: 'pdf', mode: 'a4', times: 1, downloadedAt: new Date(T0 - 3 * DAY).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 7, kind: 'cover_letter', employer: 'Airbus', templateId: 'ats_pro', templateName: 'ATS Professional', format: 'pdf', mode: 'a4', times: 3, downloadedAt: new Date(T0 - 12 * DAY).toISOString(), ownsEmployer: false, unlocked: false },
];

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.fill}>
        <EmployerHome
          firstName="Rishi"
          unreadCount={9}
          onOpenDashboard={() => {}}
          onOpenMenu={() => {}}
          onOpenNotifications={() => {}}
          loaders={{
            targets: async () => (leadUntailored
              ? [...TARGETS.filter((t) => t.jobId === 'i1'), ...TARGETS.filter((t) => t.jobId !== 'i1')]
              : TARGETS).filter((t) => !HIDDEN.has(t.key)),
            // `sample: true` mirrors an account that has not uploaded a resume yet — the state a
            // brand-new user actually lands in. It is behind ?sample=1 now: a sample account has no
            // saved documents, so by default the harness shows the account that DOES have them.
            cards: async () => ({ preferred: CATALOGUE[0].id, cards: CATALOGUE.slice(0, 5), sample: showSample }),
            catalogue: async () => CATALOGUE,
            paid: async () => false,
            // ⚠️ The library, from fixtures. EmployerHome's BASE image-hydration effect short-circuits
            // entirely when `loaders` is present (a saved document's deck fills in from `docCards`
            // below instead), so this has to be self-contained — every row borrows a thumbnail from
            // CATALOGUE by template id, with no follow-up fetch.
            // One locked row on purpose: the padlock is the state most worth looking at.
            history: async (kind) => ({
              unlimited: false,
              items: emptyLibrary ? [] : (kind === 'cover_letter' ? LETTER_HISTORY : RESUME_HISTORY) as DownloadHistoryItem[],
            }),
            // The account this was built against: everything done. That is the state where the
            // wizard entry used to disappear entirely — and where the CTA now reads "Customize your
            // resume" and opens the editor on the selected employer's own version.
            setup: async () => ({ profile: true, resume: true, photo: true, signature: true, complete: true }),
            // The saved documents. ⚠️ Supplying these is what keeps the document reads off the network.
            doc: async (kind, q) => (showSample ? null : DOC_LOADERS.doc(kind, q)),
            docCards: DOC_LOADERS.docCards,
            docList: async (kind) => (showSample ? [] : DOC_LOADERS.docList(kind)),
            // The X (untrack an employer / hide a posting) and Undo (track again / un-hide), locally.
            remove: async (t) => { HIDDEN.add(t.key); return true; },
            unhide: async (t) => { HIDDEN.delete(t.key); return true; },
            // What the confirm sheet says for this chip — opens it; nothing on it can build or buy here.
            confirm: async (kind, t) => ASKS[kind][String(t.jobId || '')] || null,
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: E.stage },
  fill: { flex: 1, backgroundColor: E.stage },
});
