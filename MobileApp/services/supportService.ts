// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Client for the in-app support feature. Mirrors server/services/supportService.js.
//
// Note what is NOT here: no way to say who a message is from. The server decides that from which
// middleware authenticated the request, so there is no field to get wrong or to forge.

import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

export type SupportIssue = { key: string; icon: string; title: string; blurb: string };

export type SupportThread = {
  id: string;
  issue_key: string;
  issue_title: string;
  issue_icon: string;
  subject: string;
  status: 'open' | 'resolved';
  last_message_at: string;
  last_sender: 'user' | 'admin' | null;
  last_body: string;
  created_at: string;
  unread: number;
  muted?: boolean;
  /** Admin view only. */
  user?: { id: number; name: string; email: string };
};

/** `sender` is 'you' | 'support' on the user side, 'user' | 'admin' on the admin side. */
export type SupportMessage = {
  id: string;
  sender: 'you' | 'support' | 'user' | 'admin';
  sender_user_id?: number | null;
  body: string;
  created_at: string;
};

export type SupportThreadView = {
  thread: SupportThread;
  messages: SupportMessage[];
  hasMore: boolean;
  oldestId: string | null;
};

async function authHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.token) return { Authorization: `Bearer ${s.token}` };
    }
  } catch { /* fall through — the request will 401 and the screen will say so */ }
  return {};
}

/** Turn an axios failure into the server's own message when it sent one. */
function err(e: unknown, fallback: string): Error {
  const any = e as any;
  const d = any?.response?.data;
  const msg = (d && (d.error || d.message)) || any?.message || fallback;
  const out = new Error(String(msg));
  (out as any).code = d?.code;
  (out as any).status = any?.response?.status;
  (out as any).waitSeconds = d?.waitSeconds;
  return out;
}

// ── user ─────────────────────────────────────────────────────────────────────
export async function fetchSupportIssues(): Promise<{ issues: SupportIssue[]; detailsMax: number; bodyMax: number }> {
  try {
    const { data } = await axios.get(`${API_BASE}/support/issues`, { headers: await authHeader(), timeout: 20000 });
    return { issues: data.issues || [], detailsMax: data.detailsMax || 1500, bodyMax: data.bodyMax || 2000 };
  } catch (e) { throw err(e, 'Could not load the help topics'); }
}

export async function fetchMyThreads(): Promise<{ threads: SupportThread[]; unread: number }> {
  try {
    const { data } = await axios.get(`${API_BASE}/support/threads`, { headers: await authHeader(), timeout: 20000 });
    return { threads: data.threads || [], unread: data.unread || 0 };
  } catch (e) { throw err(e, 'Could not load your reports'); }
}

export async function startSupportThread(issueKey: string, details?: string): Promise<{ thread: SupportThread }> {
  try {
    const { data } = await axios.post(`${API_BASE}/support/threads`, { issueKey, details: details || '' },
      { headers: await authHeader(), timeout: 25000 });
    return { thread: data.thread };
  } catch (e) { throw err(e, 'Could not start the report'); }
}

export async function fetchThread(threadId: string, before?: string): Promise<SupportThreadView> {
  try {
    const { data } = await axios.get(`${API_BASE}/support/threads/${threadId}/messages`, {
      headers: await authHeader(), params: before ? { before } : undefined, timeout: 20000,
    });
    return data as SupportThreadView;
  } catch (e) { throw err(e, 'Could not load the conversation'); }
}

export async function sendSupportMessage(threadId: string, body: string): Promise<SupportMessage> {
  try {
    const { data } = await axios.post(`${API_BASE}/support/threads/${threadId}/messages`, { body },
      { headers: await authHeader(), timeout: 25000 });
    return data.message;
  } catch (e) { throw err(e, 'Could not send your message'); }
}

export async function markThreadRead(threadId: string): Promise<void> {
  try { await axios.post(`${API_BASE}/support/threads/${threadId}/read`, {}, { headers: await authHeader(), timeout: 15000 }); }
  catch { /* a badge that stays lit is not worth an error dialog */ }
}

export async function setThreadMuted(threadId: string, muted: boolean): Promise<boolean> {
  try {
    const { data } = await axios.post(`${API_BASE}/support/threads/${threadId}/mute`, { muted },
      { headers: await authHeader(), timeout: 15000 });
    return !!data.muted;
  } catch (e) { throw err(e, 'Could not update'); }
}

// ── admin ────────────────────────────────────────────────────────────────────
export type SupportInbox = {
  threads: SupportThread[];
  counts: { open: number; waiting: number; total: number };
};

export async function fetchSupportInbox(status: 'open' | 'resolved' | 'all' = 'open'): Promise<SupportInbox> {
  try {
    const { data } = await axios.get(`${API_BASE}/admin/support/threads`, {
      headers: await authHeader(), params: { status, limit: 100 }, timeout: 25000,
    });
    return { threads: data.threads || [], counts: data.counts || { open: 0, waiting: 0, total: 0 } };
  } catch (e) { throw err(e, 'Could not load the support inbox'); }
}

export async function fetchAdminThread(threadId: string, before?: string): Promise<SupportThreadView> {
  try {
    const { data } = await axios.get(`${API_BASE}/admin/support/threads/${threadId}/messages`, {
      headers: await authHeader(), params: before ? { before } : undefined, timeout: 20000,
    });
    return data as SupportThreadView;
  } catch (e) { throw err(e, 'Could not load the conversation'); }
}

export async function sendAdminReply(threadId: string, body: string): Promise<{ message: SupportMessage; push: any }> {
  try {
    const { data } = await axios.post(`${API_BASE}/admin/support/threads/${threadId}/messages`, { body },
      { headers: await authHeader(), timeout: 30000 });
    return { message: data.message, push: data.push };
  } catch (e) { throw err(e, 'Could not send the reply'); }
}

/** Staff reaching out first — the one support action gated by type-to-confirm in the UI. */
export async function adminStartSupportThread(
  userId: number | string, issueKey: string, message: string,
): Promise<{ thread: SupportThread; push: any }> {
  try {
    const { data } = await axios.post(`${API_BASE}/admin/support/threads`, { userId, issueKey, message },
      { headers: await authHeader(), timeout: 30000 });
    return { thread: data.thread, push: data.push };
  } catch (e) { throw err(e, 'Could not start the conversation'); }
}

export async function setThreadStatus(threadId: string, status: 'open' | 'resolved'): Promise<SupportThread> {
  try {
    const { data } = await axios.post(`${API_BASE}/admin/support/threads/${threadId}/status`, { status },
      { headers: await authHeader(), timeout: 20000 });
    return data.thread;
  } catch (e) { throw err(e, 'Could not update'); }
}

export async function markAdminThreadRead(threadId: string): Promise<void> {
  try { await axios.post(`${API_BASE}/admin/support/threads/${threadId}/read`, {}, { headers: await authHeader(), timeout: 15000 }); }
  catch { /* best effort */ }
}
