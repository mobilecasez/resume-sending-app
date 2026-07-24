// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Search jobs on Google" — the REAL Google, full screen, in the app.
//
// This replaces the old masked experience (LiveJobSearch), which ran a hidden Google/LinkedIn scrape
// and re-rendered whatever it found as our own cards. That looked tidy but lied about the web: the
// scraper only reliably matched a handful of board layouts, so the card list came back dominated by
// LinkedIn and buried everything else Google actually returned.
//
// Here the user sees exactly the page they'd see on their phone's browser for "dotnet jobs in
// netherlands", taps whichever result they like, browses freely — and when they land on a real job
// page, the floating robot → "Fetch job" saves it into CVApplyr with full AI-extracted details.
// Translate, Apply-here, LinkedIn sign-in and the persistent cookie jar all come from BrowseFetch,
// so a login done once here is remembered for every later session.
//
// ⚠️ BrowseFetch is a full-screen overlay VIEW, never its own <Modal> — a Modal dismissed from
// inside another Modal hard-crashed iOS (build 87). It is mounted directly as this Modal's content.
import React, { useMemo } from 'react';
import { Modal } from 'react-native';
import { useEventCosts } from '../hooks/useEventCosts';
import BrowseFetch from './BrowseFetch';
import type { LiveJobCard } from '../services/aiHubService';

// Google's plain results page. `ie/oe` keep it UTF-8 on every locale; nothing else is forced, so the
// user gets their own country/language exactly as they would in their browser.
export function googleSearchUrl(query: string): string {
  const q = String(query || '').trim();
  return 'https://www.google.com/search?ie=UTF-8&oe=UTF-8&q=' + encodeURIComponent(q || 'jobs near me');
}

export default function GoogleJobBrowser({ visible, query, onClose, onApplyHere }: {
  visible: boolean;
  query: string;
  onClose: () => void;
  // "Apply here" from the dock: hand the page to the full apply experience (AI auto-fill, resume
  // upload, cover letter). There is no result card in this flow, so the parent gets null and
  // synthesizes a minimal job from the page title.
  onApplyHere?: (applyUrl: string, pageTitle: string, card: LiveJobCard | null) => void;
}) {
  const { costOf } = useEventCosts();
  const fetchCost = costOf('live_fetch') ?? 0;
  const home = useMemo(() => googleSearchUrl(query), [query]);

  if (!visible) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <BrowseFetch
        // Re-key on the query so a new search always starts a fresh browsing session rather than
        // resuming wherever the last one wandered off to.
        key={home}
        url={home}
        homeUrl={home}
        fetchCost={fetchCost}
        onClose={onClose}
        // Saving is BrowseFetch's own job (it stores server-side and shows "Saved ✓"); the parent
        // refreshes its Saved count when this closes, so there is nothing to do per fetch.
        onFetched={() => {}}
        onApplyHere={onApplyHere ? (applyUrl, pageTitle) => onApplyHere(applyUrl, pageTitle || '', null) : undefined}
      />
    </Modal>
  );
}
