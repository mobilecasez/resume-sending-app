// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The Job Agent's client (server: server/routes/jobAgentRoutes.js, server/services/jobAgent.js).
// The agent finds matching jobs, scores the fit, prepares a tailored résumé + letter for the best ones within the
// plan's monthly allowance, and — only when the user chose it — emails applications whose posting gives an email.
// Company forms are never submitted for the user: they open in the in-app apply browser with Auto Fill.
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import { storeEnvHeader } from './storeEnv';
import { deviceHeader } from './deviceId';

export type AgentCriteria = {
  roles: string[]; locations: string[]; countries: string[];
  remote: 'any' | 'remote' | 'onsite' | 'hybrid'; minFit: number; excludeEmployers: string[];
};
export type AgentSettings = {
  enabled: boolean; criteria: AgentCriteria; sendMode: 'review' | 'auto_email'; dailyCap: number;
  lastRunAt: string | null; lastSummary: AgentRunSummary | null;
};
export type AgentAllowance = { planKey: string; monthly: number; used: number; remaining: number; since: string; canSend: boolean; preview: boolean };
export type AgentOverview = { settings: AgentSettings; allowance: AgentAllowance; counts: Record<string, number>; dailyCapMax: number };
export type AgentFit = {
  score: number; band: 'strong' | 'good' | 'moderate' | 'weak' | 'poor'; strengths: string[]; gaps: string[];
  language: 'pass' | 'flag' | 'fail'; languageQuote: string; eligibility: 'pass' | 'fail' | 'unverified'; deadline: string | null;
};
export type AgentItem = {
  id: number; jobUrl: string; title: string; employer: string; location: string; country: string;
  channel: 'email' | 'form' | 'web'; applyEmail: string | null;
  status: 'matched' | 'preparing' | 'ready' | 'sending' | 'sent' | 'applied' | 'skipped' | 'failed' | 'blocked';
  error: string | null; resumeDocId: string | null; letterDocId: string | null; fit: AgentFit | null;
  preparedAt: string | null; appliedAt: string | null; createdAt: string;
};
export type AgentRunSummary = {
  at: string; found: number; scored: number; matched: number; prepared: number; sent: number;
  skippedReason?: string; stoppedReason?: string; sendBlocked?: string; error?: string;
  allowance?: { monthly: number; used: number; remaining: number; planKey: string };
};

/** A refusal the screen can word: the server's machine reason, plus what it said. */
export class AgentError extends Error {
  reason: string; status: number; extra: any;
  constructor(reason: string, status: number, extra?: any) { super(reason); this.reason = reason; this.status = status; this.extra = extra; }
}

async function headers(): Promise<Record<string, string>> {
  let token = '';
  try { token = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}')?.token || ''; } catch { /* signed out */ }
  if (!token) throw new AgentError('signed_out', 401);
  const env = await storeEnvHeader().catch(() => ({}));
  const dev = await deviceHeader().catch(() => ({}));
  return { Authorization: `Bearer ${token}`, ...env, ...dev };
}

function toError(e: any): AgentError {
  const status = e?.response?.status || 0;
  const data = e?.response?.data || {};
  return new AgentError(String(data.error || (status ? `http_${status}` : 'network')), status, data);
}

async function call<T>(method: 'get' | 'put' | 'post', path: string, body?: any, timeout = 20000): Promise<T> {
  try {
    const h = await headers();
    const { data } = await axios.request({ method, url: `${API_BASE}${path}`, data: body, headers: h, timeout });
    return data as T;
  } catch (e: any) { throw e instanceof AgentError ? e : toError(e); }
}

/** Long work (a run, a preparation, a send) runs as a server job: start it async, then poll until it settles. */
async function runJob<T>(path: string, body: any = {}, maxMs = 12 * 60 * 1000): Promise<T> {
  const start = await call<any>('post', path, { ...body, __async: true });
  if (!start || !start.jobId) {
    if (start && start.success === false) throw new AgentError(String(start.error || 'failed'), 400, start);
    return start as T;   // an older server answered synchronously
  }
  const h = await headers();
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (Date.now() > deadline) throw new AgentError('poll_timeout', 0);
    await new Promise((r) => setTimeout(r, 2500));
    let data: any;
    try { ({ data } = await axios.get(`${API_BASE}/ai-hub/job-status/${start.jobId}`, { headers: h, timeout: 15000 })); }
    catch (e: any) { if (e?.response?.status === 404) throw new AgentError('job_lost', 404); continue; }
    if (data.status === 'completed') {
      const out = data.data || {};
      if (out.success === false) throw new AgentError(String(out.error || 'failed'), 400, out);
      return out as T;
    }
    if (data.status === 'failed') {
      const r = (data.data && (data.data.reason || data.data.error)) || data.error || 'failed';
      throw new AgentError(String(r), 400, data.data);
    }
  }
}

export const fetchOverview = () => call<{ success: boolean } & AgentOverview>('get', '/job-agent');
export const saveSettings = (patch: Partial<Omit<AgentSettings, 'lastRunAt' | 'lastSummary'>>) =>
  call<{ success: boolean; settings: AgentSettings }>('put', '/job-agent/settings', patch);
export const fetchQueue = (status?: string) =>
  call<{ success: boolean; items: AgentItem[] }>('get', `/job-agent/queue${status ? `?status=${encodeURIComponent(status)}` : ''}`);
export const runNow = () => runJob<{ success: boolean; summary: AgentRunSummary }>('/job-agent/run');
export const prepareItem = (id: number) => runJob<{ success: boolean; item: AgentItem }>(`/job-agent/queue/${id}/prepare`);
export const sendItem = (id: number) => runJob<{ success: boolean; item: AgentItem }>(`/job-agent/queue/${id}/send`, {}, 4 * 60 * 1000);
export const markApplied = (id: number) => call<{ success: boolean }>('post', `/job-agent/queue/${id}/applied`);
export const skipItem = (id: number) => call<{ success: boolean }>('post', `/job-agent/queue/${id}/skip`);

/** What a refusal means, in the user's words. */
export function reasonText(reason: string): string {
  switch (reason) {
    case 'roles_required': return 'Add at least one role you want, so the agent knows what to look for.';
    case 'too_soon': return 'The agent searched less than an hour ago. New matches come with the next run.';
    case 'already_running': return 'The agent is already working on this. Give it a few minutes.';
    case 'monthly_limit': return 'You have used this month’s applications. Upgrade your plan to prepare more.';
    case 'quota_exhausted': return 'Today’s free résumés and letters are used. The agent continues when more open up, or with a plan.';
    case 'paid_required': case 'plan_required': return 'Sending applications needs a plan.';
    case 'downloads_used': return 'This month’s downloads in your plan are used, and sending attaches your documents. Upgrade in Plans to send more.';
    case 'unknown_outcome': return 'Your mailbox stopped answering just as this was sent, so it may have gone out. Check your Sent folder — the agent will not send it again.';
    case 'payer_changed': return 'Your plan or free allowance changed while preparing. Nothing was charged — try again.';
    case 'interrupted': return 'Preparing was interrupted. Tap Prepare to try again — anything already written is reused at no cost.';
    case 'run_failed': case 'ai_busy': case 'ai_down': return 'Our AI is busy right now. Nothing was charged — try again in a few minutes.';
    case 'daily_cap': return 'Today’s applications are prepared. The agent continues tomorrow.';
    case 'disabled': return 'Switch the agent on first.';
    case 'no_roles': return 'Add at least one role you want, so the agent knows what to look for.';
    case 'no_mail_account': return 'Connect your Gmail or Outlook first, so applications go out from your own address.';
    case 'reconnect': return 'Your mailbox needs to be reconnected before the agent can send.';
    case 'scope': return 'Your mailbox was connected without permission to send. Reconnect it and allow sending.';
    case 'no_resume': return 'Upload your résumé first — the agent tailors from your own experience.';
    case 'not_email_channel': return 'This job is applied to on the employer’s site. Tap “Open & apply”.';
    case 'signed_out': return 'Please sign in again.';
    case 'poll_timeout': case 'job_lost': return 'This is taking longer than usual. Pull down to refresh in a minute.';
    default: return 'Something went wrong. Please try again.';
  }
}
