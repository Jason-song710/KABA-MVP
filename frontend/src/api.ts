import type { AuthResponse, ExcludedKeyword, FinalCategory, Keyword, Notice, NoticeListResponse, User } from "./types";

const jsonHeaders = { "Content-Type": "application/json" };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem("accessToken");
  const headers = new Headers(options?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.detail || message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export function login(payload: { email: string; password: string }) {
  return request<AuthResponse>("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  });
}

export function register(payload: {
  email: string;
  password: string;
  company_name: string;
  contact_name: string;
  phone?: string;
  member_type?: string;
  preferred_industries: string[];
}) {
  return request<User>("/api/auth/register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  });
}

export function fetchMe() {
  return request<User>("/api/auth/me");
}

export function fetchNotices(params: {
  q?: string;
  category?: FinalCategory | "";
  today?: boolean;
  active_only?: boolean;
  limit?: number;
  offset?: number;
}) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.category) search.set("category", params.category);
  if (params.today) search.set("today", "true");
  if (params.active_only) search.set("active_only", "true");
  search.set("limit", String(params.limit ?? 50));
  search.set("offset", String(params.offset ?? 0));
  return request<NoticeListResponse>(`/api/notices?${search.toString()}`);
}

export function fetchKeywords() {
  return request<Keyword[]>("/api/admin/keywords");
}

export function createKeyword(payload: { keyword: string; grade: string; score?: number }) {
  return request<Keyword>("/api/admin/keywords", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  });
}

export function deleteKeyword(id: number) {
  return request<void>(`/api/admin/keywords/${id}`, { method: "DELETE" });
}

export function fetchExcludedKeywords() {
  return request<ExcludedKeyword[]>("/api/admin/excluded-keywords");
}

export function createExcludedKeyword(payload: { keyword: string; is_strong: boolean }) {
  return request<ExcludedKeyword>("/api/admin/excluded-keywords", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  });
}

export function deleteExcludedKeyword(id: number) {
  return request<void>(`/api/admin/excluded-keywords/${id}`, { method: "DELETE" });
}

export function fetchUsers(approvalStatus?: string) {
  const search = new URLSearchParams();
  if (approvalStatus) search.set("approval_status", approvalStatus);
  const query = search.toString();
  return request<User[]>(`/api/admin/users${query ? `?${query}` : ""}`);
}

export function updateUserApproval(
  id: number,
  payload: { approval_status: "pending" | "approved" | "rejected"; role?: "viewer" | "admin"; member_type?: string; approval_notes?: string }
) {
  return request<User>(`/api/admin/users/${id}/approval`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ role: "viewer", ...payload })
  });
}

export function uploadCsv(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return request<{ created_count: number; updated_count: number; duplicate_count: number; classified_count: number; errors: string[] }>(
    "/api/notices/upload-csv",
    { method: "POST", body: formData }
  );
}

export function collectNotices(payload: { start_date?: string; end_date?: string; run_ai: boolean }) {
  return request<{ fetched_count: number; created_count: number; updated_count: number; duplicate_count: number; classified_count: number; errors: string[] }>(
    "/api/admin/collect",
    { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }
  );
}

export function reclassifyNotice(id: number, runAi: boolean) {
  return request<Notice>(`/api/admin/notices/${id}/reclassify`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ run_ai: runAi })
  });
}

export function reclassifyAllNotices(runAi: boolean) {
  return request<{ updated_count: number; ai_count: number; errors: string[] }>("/api/admin/notices/reclassify-all", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ run_ai: runAi })
  });
}

export function updateManualClassification(id: number, finalCategory: FinalCategory, manualReason: string) {
  return request<Notice>(`/api/admin/notices/${id}/classification`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ final_category: finalCategory, manual_reason: manualReason })
  });
}
