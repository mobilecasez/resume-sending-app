// AI Hub — new feature. Safe to delete without affecting existing app.
// Loads the admin-configurable AI event credit-cost map once and exposes a lookup.

import { useEffect, useState } from 'react';
import { fetchEventCosts } from '../services/aiHubService';

export function useEventCosts() {
  const [costs, setCosts] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    fetchEventCosts().then((c) => { if (alive) setCosts(c || {}); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const costOf = (key: string): number | null => (key in costs ? costs[key] : null);
  return { costs, costOf };
}
