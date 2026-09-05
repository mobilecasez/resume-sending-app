// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Design tokens for the employer-focused Home, lifted from the Claude Design mockup
// ("cvApplyr Home Employer Focus"). Kept in one file so the screen and its parts can never
// drift apart on a colour.
export const E = {
  stage: '#070A18',          // the dark hero
  bg: '#E5EAF3', surface: '#FFFFFF', inputBg: '#F1F4FA',
  ink: '#0B0F22', textMuted: '#5B6B8A', textFaint: '#8896B0',
  border: 'rgba(11,15,34,0.06)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', purpleLite: '#9D8CFF',
  teal: '#14B8A6', tealDeep: '#0E9B6F', emerald: '#10B981', mint: '#5EEAD4',
  onDark: 'rgba(255,255,255,0.58)',
  glass: 'rgba(255,255,255,0.08)', glassBorder: 'rgba(255,255,255,0.14)',
};

// ⚠️ THE MOCKUP'S ACCENT LINE IS A GRADIENT-FILLED SERIF, AND THIS APP CANNOT DRAW ONE.
// Gradient text needs an SVG <text> fill or a masked view; neither react-native-svg nor
// @react-native-masked-view is in package.json, and CLAUDE.md forbids adding dependencies.
// So the gradient is reproduced by SAMPLING it: each word gets the colour the gradient would
// have at its position along the line (#9DBEFF → #C4BBFF → #7AF0DE). At display size the eye
// reads a continuous sweep, and it costs nothing.
const STOPS: Array<[number, number, number]> = [
  [0x9d, 0xbe, 0xff],  // 0.0
  [0xc4, 0xbb, 0xff],  // 0.5
  [0x7a, 0xf0, 0xde],  // 1.0
];
export function gradientAt(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [STOPS[i], STOPS[i + 1]];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Split a phrase into words, each carrying its colour along the sweep. Rendered as sibling
// <Text> inside one wrapping <Text> so the line still wraps naturally.
export function sweepWords(phrase: string): Array<{ w: string; c: string }> {
  const words = phrase.split(' ');
  const n = Math.max(1, words.length - 1);
  return words.map((w, i) => ({ w, c: gradientAt(i / n) }));
}

// The system serif — the mockup uses Instrument Serif italic and no custom font is bundled.
// Georgia (iOS) / serif (Android) is the closest system face and needs no expo-font load.
import { Platform } from 'react-native';
export const SERIF = Platform.select({ ios: 'Georgia', default: 'serif' }) as string;
