// AI Hub — new feature. Safe to delete without affecting existing app.
// Client for location-based job interests (the redesigned Jobs tab).
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

async function authHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const s = raw ? JSON.parse(raw) : null;
    if (s?.token) return { Authorization: `Bearer ${s.token}` };
  } catch {}
  return {};
}

export type Interest = {
  id: number; label: string; country: string | null; city: string | null;
  skills: string[]; jobUrl?: string | null; jobCount: number; createdAt: string;
};
export type InterestJob = {
  id: string; job_url: string; title: string; employer_name: string | null; employer_domain: string | null;
  location: string | null; work_mode: string | null; job_type: string | null; salary: string | null;
  experience: string | null; responsibilities: string[]; skills: string[]; country: string; first_seen: string;
};

export async function fetchInterests(): Promise<Interest[]> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/interests`, { headers, timeout: 20000 });
  return (data?.items ?? []) as Interest[];
}

export async function createInterest(input: { country?: string; city?: string; skills?: string[]; jobUrl?: string; label?: string }): Promise<boolean> {
  const headers = await authHeader();
  const { data } = await axios.post(`${API_BASE}/interests`, input, { headers, timeout: 20000 });
  return !!data?.success;
}

export async function deleteInterest(id: number): Promise<void> {
  const headers = await authHeader();
  await axios.delete(`${API_BASE}/interests/${id}`, { headers, timeout: 15000 });
}

export async function fetchInterestJobs(id: number, offset = 0, limit = 20): Promise<{ jobs: InterestJob[]; total: number; pendingUrl?: boolean; urlFailed?: boolean }> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/interests/${id}/jobs?offset=${offset}&limit=${limit}`, { headers, timeout: 20000 });
  return { jobs: (data?.jobs ?? []) as InterestJob[], total: data?.total ?? 0, pendingUrl: !!data?.pendingUrl, urlFailed: !!data?.urlFailed };
}

export type PlaceOption = { name: string; jobs: number };
export type SuggestedGroup = { country: string; total: number; jobs: InterestJob[] };

export async function fetchSuggestedByCountry(): Promise<{ groups: SuggestedGroup[]; skills?: string[]; noResume?: boolean }> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/interests/suggested`, { headers, timeout: 20000 });
  return { groups: (data?.groups ?? []) as SuggestedGroup[], skills: data?.skills, noResume: !!data?.noResume };
}

export async function fetchCountryOptions(): Promise<PlaceOption[]> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/interests/meta`, { headers, timeout: 20000 });
  return (data?.countries ?? []) as PlaceOption[];
}

export async function fetchCityOptions(country: string): Promise<PlaceOption[]> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/interests/cities?country=${encodeURIComponent(country)}`, { headers, timeout: 20000 });
  return (data?.cities ?? []) as PlaceOption[];
}
