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
import React, { useMemo, useRef } from 'react';
import { Modal } from 'react-native';
import { useEventCosts } from '../hooks/useEventCosts';
import BrowseFetch, { googleSearchUrl, directUrlOf } from './BrowseFetch';
import type { LiveJobCard } from '../services/aiHubService';

// The helpers live in BrowseFetch (it needs them for its own address bar; importing back from
// here would be a cycle). Re-exported so existing imports keep working.
export { googleSearchUrl, directUrlOf };

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
  // A pasted link opens DIRECTLY (the user then saves it via the robot → Fetch job);
  // anything else is a Google search, exactly as before.
  const home = useMemo(() => directUrlOf(query) || googleSearchUrl(query), [query]);
  // On Android a <Modal> intercepts the hardware back key and calls onRequestClose — the
  // BackHandler inside BrowseFetch never sees it. Route the press into BrowseFetch's own decision
  // so back means "previous page", not "throw away the whole search".
  const backRef = useRef<(() => boolean) | null>(null);

  if (!visible) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={() => { if (!backRef.current || !backRef.current()) onClose(); }}>
      <BrowseFetch
        // Re-key on the query so a new search always starts a fresh browsing session rather than
        // resuming wherever the last one wandered off to.
        key={home}
        url={home}
        homeUrl={home}
        backRef={backRef}
        fetchCost={fetchCost}
        onClose={onClose}
        // Saving is BrowseFetch's own job (it stores server-side and shows "Saved ✓"); the parent
        // refreshes its Saved count when this closes, so there is nothing to do per fetch.
        onFetched={() => {}}
        // ⚠️ CLOSE THIS MODAL FIRST. The apply tools are a pushed ROUTE, so pushing while a
        // full-screen Modal is still mounted puts the new screen BEHIND it — the user taps
        // "Apply here", agrees, and nothing appears to happen.
        onApplyHere={onApplyHere ? (applyUrl, pageTitle) => {
          onClose();
          setTimeout(() => onApplyHere(applyUrl, pageTitle || '', null), 350);
        } : undefined}
      />
    </Modal>
  );
}
