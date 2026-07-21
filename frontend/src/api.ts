import type { AIStatus, AuthResponse, CollectionLog, ExcludedKeyword, FinalCategory, Keyword, Notice, NoticeListResponse, User, UserAdminUpdatePayload } from "./types";

const jsonHeaders = { "Content-Type": "application/json" };

const fieldLabels: Record<string, string> = {
  email: "이메일",
  password: "비밀번호",
  company_name: "회사명",
  contact_name: "담당자명",
  phone: "연락처",
  member_type: "회원사 유형",
  preferred_industries: "관심 분야",
  business_areas: "전문 분야",
  main_products: "주요 제품",
  main_services: "주요 사업",
  recommendation_keywords: "추천 키워드"
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getIssueField(issue: Record<string, unknown>): string | null {
  const loc = issue.loc;
  if (!Array.isArray(loc)) return null;
  const field = [...loc].reverse().find((part) => typeof part === "string" && part !== "body");
  return typeof field === "string" ? field : null;
}

function cleanIssueMessage(message: string, field?: string | null): string {
  const cleaned = message.replace(/^Value error,\s*/i, "").trim();
  if (field === "password" && /at least 8|8 characters|too short/i.test(cleaned)) {
    return "비밀번호는 8자 이상 입력하세요.";
  }
  if (/field required/i.test(cleaned)) {
    return "필수 입력값입니다.";
  }
  return cleaned;
}

function formatErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((issue) => {
        const record = asRecord(issue);
        if (!record) return String(issue);
        const field = getIssueField(record);
        const label = field ? fieldLabels[field] ?? field : "";
        const message = typeof record.msg === "string" ? cleanIssueMessage(record.msg, field) : JSON.stringify(record);
        return label ? `${label}: ${message}` : message;
      })
      .filter(Boolean);
    return messages.join("\n") || fallback;
  }

  const record = asRecord(detail);
  if (record) {
    if (typeof record.message === "string") return record.message;
    if (typeof record.msg === "string") return cleanIssueMessage(record.msg);
    return JSON.stringify(record);
  }

  return fallback;
}

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
      const record = asRecord(parsed);
      message = formatErrorDetail(record && "detail" in record ? record.detail : parsed, message);
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
  business_areas?: string;
  main_products?: string;
  main_services?: string;
  recommendation_keywords?: string;
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

export function fetchRecommendedNotices(params: {
  q?: string;
  active_only?: boolean;
  limit?: number;
  offset?: number;
}) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.active_only !== false) search.set("active_only", "true");
  search.set("limit", String(params.limit ?? 50));
  search.set("offset", String(params.offset ?? 0));
  return request<NoticeListResponse>(`/api/notices/recommended?${search.toString()}`);
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

export function fetchAIStatus() {
  return request<AIStatus>("/api/admin/ai-status");
}

export function fetchCollectionLogs(limit = 150) {
  return request<CollectionLog[]>(`/api/admin/collection-logs?limit=${limit}`);
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

export function updateUserAdmin(id: number, payload: UserAdminUpdatePayload) {
  return request<User>(`/api/admin/users/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  });
}

export function withdrawUser(id: number, reason?: string) {
  return request<User>(`/api/admin/users/${id}/withdraw`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ reason })
  });
}

export function uploadCsv(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return request<{ created_count: number; updated_count: number; duplicate_count: number; classified_count: number; message?: string | null; errors: string[] }>(
    "/api/notices/upload-csv",
    { method: "POST", body: formData }
  );
}

export function collectNotices(payload: { start_date?: string; end_date?: string; run_ai: boolean; title_query?: string }) {
  return request<{ fetched_count: number; created_count: number; updated_count: number; duplicate_count: number; classified_count: number; message?: string | null; errors: string[] }>(
    "/api/admin/collect",
    { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) }
  );
}

export function cancelCollection() {
  return request<{ fetched_count: number; created_count: number; updated_count: number; duplicate_count: number; classified_count: number; message?: string | null; errors: string[] }>(
    "/api/admin/collect/cancel",
    { method: "POST", headers: jsonHeaders }
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
  return request<{ updated_count: number; ai_count: number; ai_success_count: number; ai_failed_count: number; errors: string[] }>("/api/admin/notices/reclassify-all", {
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
