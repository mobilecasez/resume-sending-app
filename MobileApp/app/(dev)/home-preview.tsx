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
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import EmployerHome from '../../components/employer-home/EmployerHome';
import { E } from '../../components/employer-home/theme';
import type { Target, HomeCard, DownloadHistoryItem } from '../../services/employerHomeService';

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
const TARGETS: Target[] = [
  { key: 'job_a1', jobId: 'a1', company: 'Airbus', role: 'Senior Software Engineer', initial: 'A', colors: ['#4F8DFF', '#7C6BFF'], match: 100, skills: ['C++', 'Embedded', 'DO-178C'], location: 'Toulouse' },
  { key: 'job_a2', jobId: 'a2', company: 'Airbus', role: 'Team Lead', initial: 'A', colors: ['#4F8DFF', '#7C6BFF'], match: 88, skills: ['Leadership', 'Agile'], location: 'Hamburg' },
  { key: 'job_i1', jobId: 'i1', company: 'iwell B.V.', role: 'Senior .NET Developer', initial: 'I', colors: ['#7C6BFF', '#DB2777'], match: 94, skills: ['.NET Core', 'Azure', 'React'], location: 'Amsterdam' },
  { key: 'job_e1', jobId: 'e1', company: 'Eneco', role: 'Platform Engineer', initial: 'E', colors: ['#10B981', '#06B6D4'], match: 78, skills: ['Azure', 'SAP'], location: 'Rotterdam' },
];

export default function HomePreview() {
const DAY = 86400000;
// Fixed offsets from a fixed epoch: a fixture that used Date.now() would render differently on
// every run and make a visual diff of this screen worthless.
const T0 = Date.parse('2026-09-09T10:00:00Z');
// ⚠️ THREE DIFFERENT COLOUR PAIRS IN THE TOP THREE, DELIBERATELY. gradFor hashes the company name
// into one of seven pairs, so real companies collide often — Airbus, Zalando and Siemens all land on
// the same amber. A fixture that shows one colour three times cannot tell you whether the wash is
// working, which is the whole reason this harness exists. The locked row is kept inside the visible
// three for the same reason: the padlock is the state most worth looking at.
const RESUME_HISTORY: DownloadHistoryItem[] = [
  { id: 1, kind: 'resume', employer: 'Klarna', templateId: CATALOGUE[0].id, templateName: CATALOGUE[0].name, format: 'pdf', mode: 'a4', times: 3, downloadedAt: new Date(T0).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 2, kind: 'resume', employer: 'Revolut', templateId: CATALOGUE[2].id, templateName: CATALOGUE[2].name, format: 'docx', mode: '', times: 1, downloadedAt: new Date(T0 - 2 * DAY).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 3, kind: 'resume', employer: 'Airbus', templateId: CATALOGUE[4].id, templateName: CATALOGUE[4].name, format: 'pdf', mode: 'onepage', times: 1, downloadedAt: new Date(T0 - 9 * DAY).toISOString(), ownsEmployer: false, unlocked: false },
  { id: 4, kind: 'resume', employer: 'Zalando SE', templateId: 'not-in-the-deck', templateName: 'Berlin Serif', format: 'pdf', mode: 'a4', times: 2, downloadedAt: new Date(T0 - 40 * DAY).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 5, kind: 'resume', employer: 'Siemens', templateId: CATALOGUE[1].id, templateName: CATALOGUE[1].name, format: 'pdf', mode: 'a4', times: 1, downloadedAt: new Date(T0 - 400 * DAY).toISOString(), ownsEmployer: false, unlocked: false },
];
const LETTER_HISTORY: DownloadHistoryItem[] = [
  { id: 11, kind: 'cover_letter', employer: 'Airbus', templateId: 'ats_pro', templateName: 'ATS Professional', format: 'pdf', mode: 'a4', times: 1, downloadedAt: new Date(T0 - DAY).toISOString(), ownsEmployer: true, unlocked: true },
  { id: 12, kind: 'cover_letter', employer: 'Siemens', templateId: 'german', templateName: 'German Professional', format: 'docx', mode: '', times: 1, downloadedAt: new Date(T0 - 12 * DAY).toISOString(), ownsEmployer: false, unlocked: false },
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
            targets: async () => TARGETS,
            // `sample: true` mirrors an account that has not uploaded a resume yet — the state a
            // brand-new user actually lands in, and the one worth checking on screen.
            cards: async () => ({ preferred: CATALOGUE[0].id, cards: CATALOGUE.slice(0, 5), sample: true }),
            catalogue: async () => CATALOGUE,
            paid: async () => false,
            // ⚠️ The library, from fixtures. EmployerHome's image-hydration effect short-circuits
            // entirely when `loaders` is present, so this has to be self-contained — every row
            // borrows a thumbnail from CATALOGUE by template id, with no follow-up fetch.
            // One locked row on purpose: the padlock is the state most worth looking at.
            history: async (kind) => ({
              unlimited: false,
              items: (kind === 'cover_letter' ? LETTER_HISTORY : RESUME_HISTORY) as DownloadHistoryItem[],
            }),
            setup: async () => ({ profile: true, resume: false, photo: false, signature: false, complete: false }),
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: E.stage },
  fill: { flex: 1, backgroundColor: E.bg },
});
