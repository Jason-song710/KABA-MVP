export type FinalCategory = "주소산업 핵심공고" | "주소산업 관련공고" | "참고공고" | "제외공고";

export interface Classification {
  id: number;
  primary_score: number;
  primary_category: string;
  matched_keywords: Record<string, string[]>;
  excluded_keyword_hits: string[];
  final_category: FinalCategory;
  effective_category: FinalCategory;
  ai_relevance_score: number | null;
  matched_industries: string[];
  recommended_member_types: string[];
  risk_notes: string[];
  ai_reason: string | null;
  ai_summary: string | null;
  ai_status: string;
  is_manual: boolean;
  manual_category: FinalCategory | null;
  manual_reason: string | null;
  classified_at: string;
  updated_at: string;
}

export interface Notice {
  id: number;
  notice_no: string | null;
  title: string;
  ordering_agency: string | null;
  posted_at: string | null;
  deadline_at: string | null;
  budget_amount: string | null;
  notice_url: string | null;
  detail_content: string | null;
  attachment_urls: string[];
  source: string;
  created_at: string;
  updated_at: string;
  classification: Classification | null;
}

export interface NoticeListResponse {
  items: Notice[];
  total: number;
  limit: number;
  offset: number;
}

export interface Keyword {
  id: number;
  keyword: string;
  grade: "S" | "A" | "B" | "C" | "D";
  score: number;
  is_active: boolean;
}

export interface ExcludedKeyword {
  id: number;
  keyword: string;
  is_strong: boolean;
  is_active: boolean;
}

export interface User {
  id: number;
  email: string;
  role: "viewer" | "admin";
  company_name: string | null;
  contact_name: string | null;
  phone: string | null;
  member_type: string | null;
  preferred_industries: string[];
  approval_status: "pending" | "approved" | "rejected";
  approval_notes: string | null;
  approved_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
}
