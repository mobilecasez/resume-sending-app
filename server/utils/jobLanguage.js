// Lightweight, dependency-free language detection for job cards.
//
// Used only to decide whether to show the per-card "Translate to English" icon
// (the actual translation is done by Gemini). ATS-sourced jobs (SuccessFactors,
// Workday, etc.) are parsed straight from HTML with NO AI, so they keep their
// original language (often German/French/Dutch). AI-extracted jobs are already
// English. We flag a job as "non-English" so the client can show the toggle.
//
// Bias: when uncertain, classify as NON-English (show the icon). A false icon on
// an English job is harmless (translating returns ~the same text); a MISSING icon
// on a German job is the real failure, so we favour recall of non-English.
'use strict';

// Common stopwords / function words per language. English is the negative class.
const EN = ['the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'we', 'to', 'of', 'in', 'on', 'as', 'is', 'be', 'or', 'an', 'at', 'this', 'that', 'have', 'from', 'experience', 'team', 'work', 'role', 'skills', 'responsibilities', 'requirements'];
const NON_EN = {
  de: ['und', 'der', 'die', 'das', 'für', 'mit', 'sie', 'ihre', 'ihr', 'wir', 'sind', 'eine', 'einen', 'zu', 'im', 'von', 'den', 'auf', 'aufgaben', 'kenntnisse', 'erfahrung', 'bereich', 'unternehmen', 'mitarbeiter', 'abgeschlossene', 'sowie', 'unserer', 'arbeiten'],
  fr: ['les', 'des', 'une', 'pour', 'avec', 'vous', 'nous', 'votre', 'notre', 'dans', 'est', 'sur', 'aux', 'compétences', 'expérience', 'entreprise', 'poste', 'missions', 'profil', 'équipe'],
  nl: ['het', 'een', 'van', 'voor', 'met', 'wij', 'jij', 'jouw', 'onze', 'zijn', 'aan', 'ervaring', 'vaardigheden', 'functie', 'bedrijf', 'werkzaamheden', 'binnen'],
  es: ['los', 'las', 'una', 'para', 'con', 'usted', 'nosotros', 'nuestro', 'experiencia', 'habilidades', 'empresa', 'puesto', 'equipo', 'desarrollo'],
  it: ['gli', 'una', 'per', 'con', 'noi', 'vostro', 'nostro', 'esperienza', 'competenze', 'azienda', 'ruolo', 'sviluppo', 'siamo'],
  pt: ['uma', 'para', 'com', 'você', 'nós', 'nosso', 'experiência', 'habilidades', 'empresa', 'função', 'equipe', 'desenvolvimento'],
};
// Diacritics that strongly signal a non-English Latin-script language.
const DIACRITICS = /[äöüßàâçéèêëîïôûùœñãõ]/i;
// German/EU job-ad gender marker: (m/w/d), w/m/d, m/f/x, (m/w/divers) … An
// unambiguous non-English signal that survives in title-only ATS cards.
const GENDER_MARKER = /\(?\s*[mwfdx]\s*\/\s*[mwfdx]\s*\/\s*[mwfdx]\s*\)?/i;
// Clearly-non-English title morphemes (no common-English substring overlap), so
// even a one-word foreign title is caught. Matched as substrings of tokens.
const DE_MORPH = ['entwickler', 'mitarbeiter', 'sachbearbeiter', 'projektleiter', 'bauleiter', 'schichtleiter', 'vertrieb', 'ausbildung', 'kaufmann', 'kauffrau', 'fachkraft', 'gesucht', 'geschäft', 'buchhalt', 'verkäufer', 'monteur', 'techniker', 'ingenieur', 'mechaniker', 'elektroniker', 'anlagen', 'betreuer', 'pflege', 'kundenberat', 'einkäufer', 'lagerist', 'meister', 'reinigung', 'mitarbeit'];
const FR_MORPH = ['ingénieur', 'développeur', 'chargé', 'responsable', 'technicien', 'comptable', 'vendeur', 'gestionnaire', 'conducteur', 'recruteur', 'apprenti'];
const DE_SUFFIX = /(ung|keit|schaft|ungen|tät|heit|lich)$/i;

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-zà-ÿ]+/gi) || [];
}

function morphemeLang(tokens) {
  for (const t of tokens) {
    if (DE_MORPH.some((m) => t.includes(m)) || DE_SUFFIX.test(t)) return 'de';
    if (FR_MORPH.some((m) => t.includes(m))) return 'fr';
  }
  return null;
}

/**
 * @param {string} text  Combined job text (title + responsibilities + skills).
 * @returns {{ isEnglish: boolean, lang: string }}  lang is an ISO-ish hint
 *          ('en' | 'de' | 'fr' | 'nl' | 'es' | 'it' | 'pt' | 'non-en').
 */
function detectJobLanguage(text) {
  const raw = String(text || '');

  // Strong, unambiguous signals first — these must work even for a non-English
  // TITLE-ONLY card (the dominant shape for ATS sitemap jobs), before any
  // short-text bail-out.
  if (GENDER_MARKER.test(raw)) return { isEnglish: false, lang: 'de' };

  const tokens = tokenize(raw);
  const set = new Set(tokens);
  const hasDiacritics = DIACRITICS.test(raw);
  const enHits = EN.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  let bestLang = null, bestHits = 0;
  for (const [lang, words] of Object.entries(NON_EN)) {
    const hits = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; bestLang = lang; }
  }
  const morph = morphemeLang(tokens);

  // Diacritics with weak English signal (e.g. "Développeur Full Stack").
  if (hasDiacritics && enHits <= 2) return { isEnglish: false, lang: bestLang || morph || 'non-en' };
  // Non-English morpheme and no clear English word (e.g. "Softwareentwickler",
  // "Bauleiter Hochbau gesucht").
  if (morph && enHits === 0) return { isEnglish: false, lang: morph };
  // Foreign stopwords clearly outweigh English (longer text).
  if (bestHits >= 2 && bestHits >= enHits) return { isEnglish: false, lang: bestLang };
  if (bestHits >= 1 && enHits === 0) return { isEnglish: false, lang: bestLang };

  // No non-English signal found → treat as English (also covers very short
  // English titles like "Product Manager" — don't nag with a useless toggle).
  return { isEnglish: true, lang: 'en' };
}

// Build the text blob a job card shows, for detection.
function jobTextForDetection(job) {
  const parts = [];
  if (job.title) parts.push(job.title);
  const resp = job.responsibilities;
  if (Array.isArray(resp)) parts.push(resp.join(' '));
  else if (typeof resp === 'string') parts.push(resp);
  const skills = job.skills;
  if (Array.isArray(skills)) parts.push(skills.join(' '));
  return parts.join(' ');
}

module.exports = { detectJobLanguage, jobTextForDetection };
