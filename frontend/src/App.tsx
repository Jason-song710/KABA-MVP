import { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useState } from "react";
import {
  Check,
  ExternalLink,
  FileUp,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  cancelCollection,
  collectNotices,
  createExcludedKeyword,
  createKeyword,
  deleteExcludedKeyword,
  deleteKeyword,
  fetchAIStatus,
  fetchCollectionLogs,
  fetchExcludedKeywords,
  fetchKeywords,
  fetchMe,
  fetchNotices,
  fetchRecommendedNotices,
  fetchUsers,
  login,
  register,
  reclassifyAllNotices,
  reclassifyNotice,
  updateManualClassification,
  updateUserAdmin,
  updateUserApproval,
  uploadCsv,
  withdrawUser
} from "./api";
import type { AIStatus, CollectionLog, ExcludedKeyword, FinalCategory, Keyword, Notice, User, UserAdminUpdatePayload, UserApprovalStatus } from "./types";

const initialUploadCsvTemplate = [
  "notice_no,title,ordering_agency,posted_at,deadline_at,budget_amount,notice_url,detail_content,attachment_urls",
  ""
].join("\n");

function downloadInitialCsvTemplate() {
  const blob = new Blob([`\ufeff${initialUploadCsvTemplate}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "kaba-initial-upload-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const categories: FinalCategory[] = ["주소산업 핵심공고", "주소산업 관련공고", "참고공고", "제외공고"];

const viewTabs: Array<{ key: string; label: string; category?: FinalCategory; today?: boolean; activeOnly?: boolean; closedOnly?: boolean; recommended?: boolean }> = [
  { key: "recommended", label: "내 회사 관련 공고", activeOnly: true, recommended: true },
  { key: "active", label: "입찰 진행중 공고", activeOnly: true },
  { key: "closed", label: "마감공고", closedOnly: true },
  { key: "today", label: "오늘 등록 공고", today: true },
  { key: "core", label: "핵심공고", category: "주소산업 핵심공고" },
  { key: "related", label: "관련공고", category: "주소산업 관련공고" },
  { key: "reference", label: "참고공고", category: "참고공고" },
  { key: "all", label: "전체" }
];

const noticePageSize = 100;

type AdminPage = "notices" | "keywords" | "users";
type SortDirection = "asc" | "desc";
type NoticeColumnKey = "category" | "title" | "agency" | "posted" | "deadline" | "score";
type SortConfig = { key: NoticeColumnKey; direction: SortDirection };
type NoticeCautionLevel = "danger" | "warning" | "info";
type NoticeCaution = { label: string; value: string; level: NoticeCautionLevel };

const noticeColumns: Array<{ key: NoticeColumnKey; label: string; minWidth: number }> = [
  { key: "category", label: "분류", minWidth: 110 },
  { key: "title", label: "공고명", minWidth: 220 },
  { key: "agency", label: "발주기관", minWidth: 130 },
  { key: "posted", label: "공고일", minWidth: 130 },
  { key: "deadline", label: "마감일", minWidth: 130 },
  { key: "score", label: "점수", minWidth: 90 }
];

const defaultColumnWidths: Record<NoticeColumnKey, number> = {
  category: 150,
  title: 420,
  agency: 190,
  posted: 160,
  deadline: 160,
  score: 130
};

const columnWidthStorageKey = "noticeColumnWidths";
const rawG2bFieldNames = [
  "bidNtceNm",
  "bidNtceNo",
  "ntceInsttNm",
  "dminsttNm",
  "cntrctCnclsMthdNm",
  "bidMethdNm",
  "presmptPrce",
  "asignBdgtAmt",
  "bidPrtcptLmtYn",
  "indstrytyLmtYn",
  "pubPrcmntLrgClsfcNm",
  "bidNtceDt",
  "bidClseDt",
  "ntceKindNm",
  "bsnsDivNm",
  "rgnLmtBidLocplcJdgmBssCd",
  "rgnLmtBidLocplcJdgmBssNm",
  "prtcptPsblRgnNm",
  "prtcptPsblRgnCd",
  "prdctClsfcLmtYn",
  "dtilPrdctClsfcNo",
  "dtilPrdctClsfcNoNm",
  "indstrytyLmtCd",
  "indstrytyLmtCdNm",
  "indstrytyNm",
  "indstrytyClsfcNm",
  "indstrytyPrtcptLmtYn",
  "bidprcPsblIndstrytyNm",
  "bidprcPsblIndstrytyCd",
  "bidprcPsblIndstrytyCdNm",
  "prtcptPsblIndstrytyNm",
  "prtcptPsblIndstrytyCd",
  "prtcptPsblIndstrytyCdNm",
  "g2bDetailIndustryLimitText",
  "g2bDetailRegionLimitText",
  "g2bDetailQualificationText",
  "g2bDetailRestrictionSourceUrl"
].join("|");
const rawG2bFieldPattern = new RegExp(`\\b(?:${rawG2bFieldNames})\\b`, "i");
const rawG2bQuotedTaskPattern = new RegExp(`상세내용 기준 주요 과업은\\s*'[^']*(?:${rawG2bFieldNames})[^']*'입니다\\.\\s*`, "gi");
const rawG2bKeyValuePattern = new RegExp(`\\b(?:${rawG2bFieldNames})\\s*:\\s*[^:]{0,160}(?=\\s+\\w+\\s*:|$)`, "gi");

function loadColumnWidths() {
  try {
    const saved = localStorage.getItem(columnWidthStorageKey);
    if (!saved) return defaultColumnWidths;
    return { ...defaultColumnWidths, ...JSON.parse(saved) } as Record<NoticeColumnKey, number>;
  } catch {
    return defaultColumnWidths;
  }
}

function saveColumnWidths(widths: Record<NoticeColumnKey, number>) {
  try {
    localStorage.setItem(columnWidthStorageKey, JSON.stringify(widths));
  } catch {
    // Local storage can be unavailable in private or restricted browser modes.
  }
}

function gridColumnsFromWidths(widths: Record<NoticeColumnKey, number>) {
  return noticeColumns.map((column) => `${Math.max(column.minWidth, widths[column.key])}px`).join(" ");
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTime(value: Date | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

function formatBudget(value: string | null) {
  if (!value) return "-";
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return value;
  return `${new Intl.NumberFormat("ko-KR").format(numeric)}원`;
}

function categoryClass(category?: string) {
  if (category === "주소산업 핵심공고") return "badge core";
  if (category === "주소산업 관련공고") return "badge related";
  if (category === "참고공고") return "badge reference";
  return "badge excluded";
}

function scoreCategoryForNotice(notice: Notice): FinalCategory | "미분류" {
  const classification = notice.classification;
  if (!classification) return "미분류";
  if (classification.effective_category) return classification.effective_category;
  if (classification.is_manual && classification.manual_category) return classification.manual_category;
  if (classification.primary_category === "제외공고 후보" && classification.excluded_keyword_hits.length > 0) return "제외공고";
  if (classification.primary_score >= 20) return "주소산업 핵심공고";
  if (classification.primary_score >= 10) return "주소산업 관련공고";
  return "참고공고";
}

function flattenKeywords(notice: Notice | null) {
  const matched = notice?.classification?.matched_keywords;
  if (!matched) return [];
  return Object.entries(matched).flatMap(([grade, values]) => values.map((value) => `${grade}:${value}`));
}

function splitTags(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return false;
    seen.add(trimmed);
    return true;
  });
}

function extractUrls(value: string | null) {
  return uniqueStrings(value?.match(/https?:\/\/[^\s"'<>]+/g) ?? []);
}

function detailField(notice: Notice, keys: string[]) {
  const detail = notice.detail_content ?? "";
  for (const key of keys) {
    const match = detail.match(new RegExp(`(?:^|\\n)${key}:\\s*([^\\n]+)`, "i"));
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return "";
}

function isEmptyLimitValue(value: string) {
  return /^(n|no|없음|무|해당없음|해당 없음|-|0)$/i.test(value.trim());
}

function displayLimitValue(value: string) {
  if (/^y$/i.test(value.trim())) return "있음";
  if (/^n$/i.test(value.trim())) return "없음";
  return value;
}

function detailHasEnabledFlag(notice: Notice, keys: string[]) {
  const value = detailField(notice, keys);
  return /^(y|yes|있음|유|대상)$/i.test(value.trim());
}

function buildNoticeCautions(notice: Notice): NoticeCaution[] {
  const text = `${notice.title}\n${notice.detail_content ?? ""}`;
  const contractMethod = detailField(notice, ["cntrctCnclsMthdNm"]);
  const bidMethod = detailField(notice, ["bidMethdNm"]);
  const bidLimit = detailField(notice, ["bidPrtcptLmtYn"]);
  const regionLimit = detailField(notice, ["g2bDetailRegionLimitText", "prtcptPsblRgnNm", "rgnLmtBidLocplcJdgmBssNm", "rgnLmtBidLocplcJdgmBssCdNm", "rgnLmtBidLocplcJdgmBssCd", "prtcptPsblRgnCd"]);
  const productClassName = detailField(notice, ["dtilPrdctClsfcNoNm"]);
  const productClassCode = detailField(notice, ["dtilPrdctClsfcNo"]);
  const hasProductClassLimit = detailHasEnabledFlag(notice, ["prdctClsfcLmtYn"]);
  const industryName = detailField(notice, [
    "g2bDetailIndustryLimitText",
    "bidprcPsblIndstrytyNm",
    "bidprcPsblIndstrytyCdNm",
    "prtcptPsblIndstrytyNm",
    "prtcptPsblIndstrytyCdNm",
    "indstrytyNm",
    "indstrytyLmtCdNm",
    "indstrytyClsfcNm"
  ]);
  const industryCode = detailField(notice, ["bidprcPsblIndstrytyCd", "prtcptPsblIndstrytyCd", "indstrytyLmtCd"]);
  const hasIndustryLimit = detailHasEnabledFlag(notice, ["indstrytyLmtYn", "indstrytyPrtcptLmtYn"]);
  const items: NoticeCaution[] = [];

  if (/수의시담/.test(text)) {
    items.push({
      label: "참가 유의",
      value: "수의시담 진행 공고로 일반 입찰참가가 제한될 수 있습니다.",
      level: "danger"
    });
  } else if (/수의견적|수의계약|수의/.test(`${notice.title}\n${contractMethod}\n${bidMethod}`)) {
    items.push({
      label: "참가 유의",
      value: "수의계약/수의견적 공고입니다. 일반 경쟁입찰 여부를 원문에서 확인하세요.",
      level: "warning"
    });
  }

  if (contractMethod) {
    items.push({
      label: "계약방법",
      value: contractMethod,
      level: /제한|수의/.test(contractMethod) ? "warning" : "info"
    });
  }
  if (bidMethod) {
    items.push({
      label: "입찰방식",
      value: bidMethod,
      level: /시담|수의/.test(bidMethod) ? "danger" : "info"
    });
  }
  if (bidLimit && !isEmptyLimitValue(bidLimit)) {
    items.push({ label: "입찰참가제한", value: displayLimitValue(bidLimit), level: "warning" });
  }
  if (regionLimit && !isEmptyLimitValue(regionLimit)) {
    items.push({ label: "지역제한", value: displayLimitValue(regionLimit), level: "warning" });
  }
  if (productClassName && !isEmptyLimitValue(productClassName)) {
    items.push({ label: "물품분류제한", value: productClassName, level: "warning" });
  } else if (productClassCode && !isEmptyLimitValue(productClassCode)) {
    items.push({ label: "물품분류제한", value: `분류번호 ${productClassCode}`, level: "warning" });
  } else if (hasProductClassLimit) {
    items.push({ label: "물품분류제한", value: "제한 분류명은 원문 확인 필요", level: "warning" });
  }
  if (industryName && !isEmptyLimitValue(industryName)) {
    items.push({ label: "업종제한", value: displayLimitValue(industryName), level: "warning" });
  } else if (industryCode && !isEmptyLimitValue(industryCode) && !/^[yn]$/i.test(industryCode)) {
    items.push({ label: "업종제한", value: `업종코드 ${industryCode}`, level: "warning" });
  } else if (hasIndustryLimit) {
    items.push({ label: "업종제한", value: "제한 업종명은 원문 확인 필요", level: "warning" });
  }

  return items;
}

function sanitizeSummaryText(value: string | null) {
  return (value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/[^\s)]+/g, " ")
    .replace(rawG2bQuotedTaskPattern, " ")
    .replace(rawG2bKeyValuePattern, " ")
    .replace(/'[^']*(?:bidNtceNm|ntceInsttNm|dminsttNm|cntrctCnclsMthdNm|bidMethdNm|presmptPrce|asignBdgtAmt|bidPrtcptLmtYn|indstrytyLmtYn|pubPrcmntLrgClsfcNm)[^']*'/gi, " ")
    .replace(/\b(?:function|const|let|var|class|import|export)\b[^\n.]*/gi, " ")
    .replace(/[{}\[\]<>]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordGroups(notice: Notice | null) {
  const matched = notice?.classification?.matched_keywords;
  if (!matched) return [];
  return Object.entries(matched)
    .filter(([, values]) => values.length > 0)
    .map(([grade, values]) => `${grade}등급 ${values.join(", ")}`);
}

function compactDetail(value: string | null, limit = 340) {
  const text = sanitizeSummaryText(value);
  if (rawG2bFieldPattern.test(value ?? "") && !text) return "상세내용은 원문 링크에서 확인할 수 있습니다.";
  if (!text) return "상세내용이 제공되지 않았습니다.";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildDisplaySummary(notice: Notice) {
  const classification = notice.classification;
  const stored = sanitizeSummaryText(classification?.ai_summary ?? null);
  if (stored) return stored;
  const groups = keywordGroups(notice);
  const keywordText = groups.length ? groups.join("; ") : "주소산업 키워드 매칭 없음";
  const excluded = classification?.excluded_keyword_hits?.length
    ? ` 제외 키워드는 ${classification.excluded_keyword_hits.join(", ")}입니다.`
    : " 제외 키워드는 감지되지 않았습니다.";
  return (
    `${notice.ordering_agency ?? "발주기관 미상"}에서 발주한 '${notice.title}' 공고입니다. ` +
    `공고일은 ${formatDate(notice.posted_at)}, 마감일은 ${formatDate(notice.deadline_at)}, 예산은 ${formatBudget(notice.budget_amount)}입니다. ` +
    `상세내용 기준 주요 과업은 '${compactDetail(notice.detail_content)}'입니다. ` +
    `키워드 근거는 ${keywordText}이며, 1차 점수 ${classification?.primary_score ?? 0}점으로 '${scoreCategoryForNotice(notice)}'로 표시됩니다.` +
    excluded
  );
}

function buildDisplayReason(notice: Notice) {
  const classification = notice.classification;
  const manualReason = sanitizeSummaryText(classification?.manual_reason ?? null);
  if (manualReason) return manualReason;
  const aiReason = sanitizeSummaryText(classification?.ai_reason ?? null);
  if (aiReason) return aiReason;
  const groups = keywordGroups(notice);
  const keywordText = groups.length ? groups.join("; ") : "주소산업 키워드가 충분히 매칭되지 않았습니다";
  const excluded = classification?.excluded_keyword_hits?.length
    ? ` 제외 키워드(${classification.excluded_keyword_hits.join(", ")})가 함께 감지되어 감점 또는 제외 판단에 반영했습니다.`
    : "";
  return (
    `1차 키워드 분류 기준 총 ${classification?.primary_score ?? 0}점으로 ` +
    `'${classification?.primary_category ?? "미분류"}'에 해당합니다. 매칭 근거는 ${keywordText}입니다.${excluded}`
  );
}

function aiStatusText(status?: string) {
  if (status === "success") return "성공";
  if (status === "failed") return "실패";
  if (status === "not_requested") return "미실행";
  return status ?? "미실행";
}

function collectionStatusText(status?: string) {
  if (status === "running") return "수집중";
  if (status === "success") return "완료";
  if (status === "failed") return "실패";
  if (status === "cancelled" || status === "canceled") return "중단";
  return "대기";
}

function collectionStatusClass(status?: string) {
  if (status === "running") return "running";
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "idle";
}

function scoreForNotice(notice: Notice) {
  return notice.recommendation_score ?? notice.classification?.primary_score ?? 0;
}

function sortValue(notice: Notice, key: NoticeColumnKey) {
  if (key === "category") return scoreCategoryForNotice(notice);
  if (key === "title") return notice.title;
  if (key === "agency") return notice.ordering_agency ?? "";
  if (key === "score") return scoreForNotice(notice);
  if (key === "posted") return notice.posted_at ? new Date(notice.posted_at).getTime() : 0;
  if (key === "deadline") return notice.deadline_at ? new Date(notice.deadline_at).getTime() : Number.MAX_SAFE_INTEGER;
  return "";
}

function sortNotices(items: Notice[], sortConfig: SortConfig) {
  return [...items].sort((left, right) => {
    const leftValue = sortValue(left, sortConfig.key);
    const rightValue = sortValue(right, sortConfig.key);
    const multiplier = sortConfig.direction === "asc" ? 1 : -1;
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return (leftValue - rightValue) * multiplier;
    }
    return String(leftValue).localeCompare(String(rightValue), "ko") * multiplier;
  });
}

function sortIndicator(sortConfig: SortConfig, key: NoticeColumnKey) {
  if (sortConfig.key !== key) return "";
  return sortConfig.direction === "asc" ? "↑" : "↓";
}

function CollectionStatusPanel({ latestLog, logs }: { latestLog: CollectionLog | null; logs: CollectionLog[] }) {
  const operationLogs = logs.filter((log) => log.operation !== "manual").slice(0, 12);

  if (!latestLog) {
    return (
      <div className="collection-status idle">
        <div>
          <strong>수집 기록 없음</strong>
          <span>수집 버튼을 누르면 진행 상태가 여기에 표시됩니다.</span>
        </div>
      </div>
    );
  }

  const statusTitle = latestLog.source === "csv" ? "CSV 업로드" : "나라장터 수집";

  return (
    <div className={`collection-status ${collectionStatusClass(latestLog.status)}`}>
      <div className="collection-status-main">
        <div>
          <strong>{statusTitle} {collectionStatusText(latestLog.status)}</strong>
          <span>{latestLog.message ?? "상태 메시지가 없습니다."}</span>
          {latestLog.raw_error && <small>{latestLog.raw_error}</small>}
        </div>
        <div className="collection-status-meta">
          <span>{formatDate(latestLog.created_at)}</span>
          <strong>수집 {latestLog.fetched_count}건 · 신규 {latestLog.created_count}건</strong>
        </div>
      </div>
      {operationLogs.length > 0 && (
        <div className="collection-log-list">
          {operationLogs.map((log) => (
            <span key={log.id}>
              {collectionStatusText(log.status)} · {log.message ?? log.operation ?? "수집 로그"} · 신규 {log.created_count}건
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mode, setMode] = useState<"user" | "admin">("user");
  const [adminPage, setAdminPage] = useState<AdminPage>("notices");
  const [activeView, setActiveView] = useState("recommended");
  const [query, setQuery] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [total, setTotal] = useState(0);
  const [noticePage, setNoticePage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelingCollect, setCancelingCollect] = useState(false);
  const [message, setMessage] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "deadline", direction: "asc" });
  const [columnWidths, setColumnWidths] = useState<Record<NoticeColumnKey, number>>(loadColumnWidths);

  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [excludedKeywords, setExcludedKeywords] = useState<ExcludedKeyword[]>([]);
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [collectionLogs, setCollectionLogs] = useState<CollectionLog[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [newGrade, setNewGrade] = useState("S");
  const [newExcludedKeyword, setNewExcludedKeyword] = useState("");
  const [manualCategory, setManualCategory] = useState<FinalCategory>("참고공고");
  const [manualReason, setManualReason] = useState("");
  const [collectStart, setCollectStart] = useState("");
  const [collectEnd, setCollectEnd] = useState("");
  const [runAi, setRunAi] = useState(false);

  const activeTab = viewTabs.find((tab) => tab.key === activeView) ?? viewTabs[0];
  const isAdmin = currentUser?.role === "admin";

  const selectedNotice = useMemo(
    () => notices.find((notice) => notice.id === selectedId) ?? notices[0] ?? null,
    [notices, selectedId]
  );

  const sortedNotices = useMemo(() => sortNotices(notices, sortConfig), [notices, sortConfig]);
  const noticeGridColumns = useMemo(() => gridColumnsFromWidths(columnWidths), [columnWidths]);

  const metrics = useMemo(() => {
    const initial: Record<FinalCategory, number> = {
      "주소산업 핵심공고": 0,
      "주소산업 관련공고": 0,
      "참고공고": 0,
      "제외공고": 0
    };
    notices.forEach((notice) => {
      const category = scoreCategoryForNotice(notice);
      if (category !== "미분류") initial[category] += 1;
    });
    return initial;
  }, [notices]);
  const pendingUserCount = useMemo(
    () => users.filter((user) => user.approval_status === "pending").length,
    [users]
  );
  const latestCollectionLog = useMemo(
    () => collectionLogs.find((log) => log.status === "running") ?? collectionLogs[0] ?? null,
    [collectionLogs]
  );
  const totalPages = Math.max(1, Math.ceil(total / noticePageSize));
  const pageStart = total === 0 ? 0 : noticePage * noticePageSize + 1;
  const pageEnd = Math.min(total, (noticePage + 1) * noticePageSize);

  async function restoreSession() {
    const token = localStorage.getItem("accessToken");
    if (!token) {
      setAuthChecked(true);
      return;
    }
    try {
      const user = await fetchMe();
      setCurrentUser(user);
      setMode(user.role === "admin" ? "admin" : "user");
    } catch {
      localStorage.removeItem("accessToken");
    } finally {
      setAuthChecked(true);
    }
  }

  async function loadNotices(silent = false, page = noticePage) {
    if (!currentUser) return;
    if (!silent) setLoading(true);
    try {
      const useRecommendedEndpoint = activeTab.recommended && !(mode === "admin" && isAdmin);
      const offset = page * noticePageSize;
      const response = useRecommendedEndpoint
        ? await fetchRecommendedNotices({
            q: query,
            active_only: Boolean(activeTab.activeOnly),
            limit: noticePageSize,
            offset
          })
        : await fetchNotices({
            q: query,
            category: activeTab.recommended ? "" : activeTab.category ?? "",
            today: activeTab.recommended ? false : Boolean(activeTab.today),
            active_only: activeTab.recommended ? false : Boolean(activeTab.activeOnly),
            closed_only: activeTab.recommended ? false : Boolean(activeTab.closedOnly),
            limit: noticePageSize,
            offset
          });
      if (response.total > 0 && response.items.length === 0 && page > 0) {
        setNoticePage(0);
        return;
      }
      setNotices(response.items);
      setTotal(response.total);
      setSelectedId((current) => {
        if (current && response.items.some((notice) => notice.id === current)) return current;
        return response.items[0]?.id ?? null;
      });
      setLastLoadedAt(new Date());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "공고 목록을 불러오지 못했습니다.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadAdminData() {
    if (!isAdmin) return;
    try {
      const [keywordList, excludedList, users, status, logs] = await Promise.all([
        fetchKeywords(),
        fetchExcludedKeywords(),
        fetchUsers(),
        fetchAIStatus(),
        fetchCollectionLogs()
      ]);
      setKeywords(keywordList);
      setExcludedKeywords(excludedList);
      setUsers(users);
      setAiStatus(status);
      setCollectionLogs(logs);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "관리자 데이터를 불러오지 못했습니다.");
    }
  }

  async function loadCollectionLogs() {
    if (!isAdmin) return;
    try {
      const logs = await fetchCollectionLogs();
      setCollectionLogs(logs);
    } catch {
      // Collection status is helpful but should not interrupt the notice workflow.
    }
  }

  useEffect(() => {
    restoreSession();
  }, []);

  useEffect(() => {
    if (currentUser) loadNotices();
  }, [currentUser, activeView, mode, noticePage]);

  useEffect(() => {
    if (!currentUser) return undefined;
    const timer = window.setInterval(() => {
      void loadNotices(true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [currentUser, activeView, query, mode, noticePage]);

  useEffect(() => {
    if (mode === "admin") loadAdminData();
  }, [mode, currentUser]);

  useEffect(() => {
    if (mode !== "admin" || !isAdmin) return undefined;
    const timer = window.setInterval(() => {
      void loadCollectionLogs();
      void loadNotices(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [mode, isAdmin, activeView, query]);

  useEffect(() => {
    if (!isAdmin && mode === "admin") setMode("user");
  }, [isAdmin, mode]);

  useEffect(() => {
    if (selectedNotice?.classification?.effective_category) {
      setManualCategory(selectedNotice.classification.effective_category);
      setManualReason(selectedNotice.classification.manual_reason ?? "");
    }
  }, [selectedNotice?.id]);

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    setNoticePage(0);
    await loadNotices(false, 0);
  }

  function handleSort(key: NoticeColumnKey) {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  function handleColumnResizeStart(event: ReactMouseEvent<HTMLButtonElement>, key: NoticeColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[key];
    const minWidth = noticeColumns.find((column) => column.key === key)?.minWidth ?? 80;

    function handleMove(moveEvent: MouseEvent) {
      const nextWidth = Math.max(minWidth, startWidth + moveEvent.clientX - startX);
      setColumnWidths((current) => {
        const next = { ...current, [key]: nextWidth };
        saveColumnWidths(next);
        return next;
      });
    }

    function handleUp() {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  function handleLogout() {
    localStorage.removeItem("accessToken");
    setCurrentUser(null);
    setNotices([]);
    setMode("user");
    setAdminPage("notices");
  }

  async function handleCollect(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await collectNotices({
        start_date: collectStart ? new Date(collectStart).toISOString() : undefined,
        end_date: collectEnd ? new Date(collectEnd).toISOString() : undefined,
        run_ai: runAi,
        title_query: query.trim() || undefined
      });
      setMessage(
        result.message ??
        `수집 ${result.fetched_count}건, 신규 ${result.created_count}건, 갱신 ${result.updated_count}건, 기존/중복 패스 ${result.duplicate_count}건`
      );
      await loadCollectionLogs();
      await loadNotices();
      if (runAi) await loadAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "수집에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelCollect() {
    setCancelingCollect(true);
    try {
      const result = await cancelCollection();
      setMessage(result.message ?? "수집 중단 요청을 보냈습니다.");
      await loadCollectionLogs();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "수집 중단 요청에 실패했습니다.");
    } finally {
      setCancelingCollect(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const result = await uploadCsv(file);
      const errorPreview = result.errors.length ? `\n오류 ${result.errors.length}건: ${result.errors.slice(0, 5).join(" / ")}` : "";
      const noChangeHint =
        result.created_count + result.updated_count + result.duplicate_count === 0
          ? "\n저장된 행이 없습니다. CSV 헤더가 공고명/입찰공고번호/수요기관 등으로 인식되는지 확인해 주세요."
          : "";
      setMessage(
        result.message ??
          `업로드 신규 ${result.created_count}건, 갱신 ${result.updated_count}건, 중복 ${result.duplicate_count}건, 분류 ${result.classified_count}건${errorPreview}${noChangeHint}`
      );
      await loadCollectionLogs();
      await loadNotices();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CSV 업로드에 실패했습니다.");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }

  async function handleCreateKeyword(event: FormEvent) {
    event.preventDefault();
    if (!newKeyword.trim()) return;
    try {
      const created = await createKeyword({ keyword: newKeyword.trim(), grade: newGrade });
      setNewKeyword("");
      setMessage(`${created.grade}등급 키워드 '${created.keyword}'가 저장되었습니다.`);
      await loadAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "키워드를 저장하지 못했습니다.");
    }
  }

  async function handleCreateExcludedKeyword(event: FormEvent) {
    event.preventDefault();
    if (!newExcludedKeyword.trim()) return;
    try {
      const created = await createExcludedKeyword({ keyword: newExcludedKeyword.trim(), is_strong: true });
      setNewExcludedKeyword("");
      setMessage(`제외 키워드 '${created.keyword}'가 저장되었습니다.`);
      await loadAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "제외 키워드를 저장하지 못했습니다.");
    }
  }

  async function handleManualUpdate() {
    if (!selectedNotice) return;
    const updated = await updateManualClassification(selectedNotice.id, manualCategory, manualReason);
    setMessage("관리자 분류가 저장되었습니다.");
    setNotices((items) => items.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function handleReclassify() {
    if (!selectedNotice) return;
    setLoading(true);
    try {
      const updated = await reclassifyNotice(selectedNotice.id, runAi);
      if (runAi) {
        const classification = updated.classification;
        if (classification?.ai_status === "success") {
          setMessage(`AI 재분류가 완료되었습니다. AI 점수 ${classification.ai_relevance_score}점, 최종분류 '${classification.effective_category}'입니다.`);
        } else {
          setMessage(`AI 재분류가 실패했습니다. ${classification?.ai_reason ?? "AI 로그를 확인해 주세요."}`);
        }
        await loadAdminData();
      } else {
        setMessage("1차 키워드 재분류가 완료되었습니다.");
      }
      setNotices((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "재분류에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReclassifyAll() {
    setLoading(true);
    try {
      const result = await reclassifyAllNotices(runAi);
      const aiText = runAi ? `, AI 성공 ${result.ai_success_count}건, 실패 ${result.ai_failed_count}건` : "";
      const errorText = result.errors.length ? `, 오류 ${result.errors.length}건` : "";
      setMessage(`전체 재분류 ${result.updated_count}건${aiText}${errorText} 완료되었습니다.`);
      await loadNotices();
      await loadAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "전체 재분류에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleApproveUser(user: User) {
    await updateUserApproval(user.id, {
      approval_status: "approved",
      role: "viewer",
      member_type: user.member_type ?? "회원사"
    });
    setMessage(`${user.company_name ?? user.email} 회원을 승인했습니다.`);
    await loadAdminData();
  }

  async function handleRejectUser(user: User) {
    await updateUserApproval(user.id, {
      approval_status: "rejected",
      role: "viewer",
      approval_notes: "회원사 확인 불가"
    });
    setMessage(`${user.company_name ?? user.email} 신청을 반려했습니다.`);
    await loadAdminData();
  }

  async function handleUpdateUser(user: User, payload: UserAdminUpdatePayload) {
    await updateUserAdmin(user.id, payload);
    setMessage(`${payload.company_name || user.company_name || user.email} 회원 정보가 저장되었습니다.`);
    await loadAdminData();
  }

  async function handleWithdrawUser(user: User) {
    const label = user.company_name ?? user.email;
    const confirmed = window.confirm(`${label} 계정을 탈퇴 처리할까요? 처리 후 해당 사용자는 로그인할 수 없습니다.`);
    if (!confirmed) return;
    await withdrawUser(user.id, "관리자 탈퇴 처리");
    setMessage(`${label} 계정을 탈퇴 처리했습니다.`);
    await loadAdminData();
  }

  if (!authChecked) {
    return <div className="auth-shell"><div className="empty-state">세션 확인 중입니다.</div></div>;
  }

  if (!currentUser) {
    return <AuthScreen onAuthenticated={(user) => setCurrentUser(user)} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Address Industry Notice Intelligence</p>
          <h1>주소산업 공고 자동수집·자동분류</h1>
        </div>
        <div className="topbar-actions">
          <div className="user-pill">
            <strong>{currentUser.company_name ?? currentUser.email}</strong>
            <span>{currentUser.role === "admin" ? "관리자" : currentUser.member_type ?? "승인 회원"}</span>
          </div>
          <div className="mode-toggle" role="tablist" aria-label="화면 전환">
            <button className={mode === "user" ? "active" : ""} onClick={() => {
              setMode("user");
              setNoticePage(0);
            }}>사용자</button>
            {isAdmin && <button className={mode === "admin" ? "active" : ""} onClick={() => {
              setMode("admin");
              setNoticePage(0);
            }}>관리자</button>}
          </div>
          <button className="icon-text-button" onClick={handleLogout}>
            <LogOut size={17} />
            로그아웃
          </button>
        </div>
      </header>

      {mode === "admin" && (
        <nav className="admin-page-tabs" aria-label="관리자 페이지">
          <button className={adminPage === "notices" ? "active" : ""} onClick={() => setAdminPage("notices")}>공고 관리</button>
          <button className={adminPage === "keywords" ? "active" : ""} onClick={() => setAdminPage("keywords")}>키워드 관리</button>
          <button className={adminPage === "users" ? "active" : ""} onClick={() => setAdminPage("users")}>회원 관리 {pendingUserCount ? `(${pendingUserCount})` : ""}</button>
        </nav>
      )}

      {mode === "admin" && adminPage === "keywords" ? (
        <main className="admin-page">
          {message && <div className="notice-message">{message}</div>}
          <DictionaryPanel
            keywords={keywords}
            excludedKeywords={excludedKeywords}
            newKeyword={newKeyword}
            newGrade={newGrade}
            newExcludedKeyword={newExcludedKeyword}
            setNewKeyword={setNewKeyword}
            setNewGrade={setNewGrade}
            setNewExcludedKeyword={setNewExcludedKeyword}
            onCreateKeyword={handleCreateKeyword}
            onCreateExcludedKeyword={handleCreateExcludedKeyword}
            onDeleteKeyword={async (id) => {
              await deleteKeyword(id);
              await loadAdminData();
            }}
            onDeleteExcludedKeyword={async (id) => {
              await deleteExcludedKeyword(id);
              await loadAdminData();
            }}
          />
        </main>
      ) : mode === "admin" && adminPage === "users" ? (
        <main className="admin-page">
          {message && <div className="notice-message">{message}</div>}
          <UserManagementPanel
            users={users}
            onApprove={handleApproveUser}
            onReject={handleRejectUser}
            onSave={handleUpdateUser}
            onWithdraw={handleWithdrawUser}
          />
        </main>
      ) : (
        <main className="main-grid">
          <section className="list-pane">
            <div className="toolbar">
              <div className="view-tabs">
                {viewTabs.map((tab) => (
                  <button
                    key={tab.key}
                    className={activeView === tab.key ? "active" : ""}
                    onClick={() => {
                      setActiveView(tab.key);
                      setNoticePage(0);
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <form className="search-box" onSubmit={handleSearch}>
                <Search size={18} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="키워드 검색" />
                <button type="submit">검색</button>
              </form>
            </div>
            <div className="sync-status">
              <span>목록 자동 갱신 60초</span>
              <strong>마지막 갱신 {formatTime(lastLoadedAt)}</strong>
            </div>

            <div className="metric-row">
              {categories.map((category) => (
                <div className="metric" key={category}>
                  <span>{category.replace("주소산업 ", "")}</span>
                  <strong>{metrics[category]}</strong>
                </div>
              ))}
              <div className="metric">
                <span>조회 결과</span>
                <strong>{total}</strong>
              </div>
            </div>

            {mode === "admin" && (
              <div className="admin-actions">
                <form onSubmit={handleCollect} className="collect-form">
                  <input type="datetime-local" value={collectStart} onChange={(event) => setCollectStart(event.target.value)} />
                  <input type="datetime-local" value={collectEnd} onChange={(event) => setCollectEnd(event.target.value)} />
                  <label className="check-label">
                    <input type="checkbox" checked={runAi} onChange={(event) => setRunAi(event.target.checked)} />
                    AI 적용
                  </label>
                  <button type="submit" disabled={loading}>
                    <RefreshCw size={16} />
                    수집
                  </button>
                  <button
                    type="button"
                    disabled={cancelingCollect || latestCollectionLog?.status !== "running"}
                    onClick={handleCancelCollect}
                  >
                    <X size={16} />
                    수집 중단
                  </button>
                </form>
                <label className="file-button">
                  <FileUp size={16} />
                  CSV 업로드
                  <input type="file" accept=".csv" onChange={handleUpload} />
                </label>
                <button className="icon-text-button" type="button" onClick={downloadInitialCsvTemplate}>
                  <FileUp size={16} />
                  초기 CSV 양식
                </button>
                <button className="icon-text-button" type="button" disabled={loading} onClick={handleReclassifyAll}>
                  <RefreshCw size={16} />
                  전체 재분류
                </button>
                {aiStatus && (
                  <div className={`ai-status ${aiStatus.configured ? "ready" : "missing"}`}>
                    <strong>{aiStatus.configured ? "AI 키 설정됨" : "AI 키 없음"}</strong>
                    <span>
                      {aiStatus.model}
                      {aiStatus.latest_success !== null ? ` · 최근 ${aiStatus.latest_success ? "성공" : "실패"}` : " · 실행 기록 없음"}
                    </span>
                    {aiStatus.latest_error_message && <small>{aiStatus.latest_error_message}</small>}
                  </div>
                )}
              </div>
            )}
            {mode === "admin" && (
              <CollectionStatusPanel latestLog={latestCollectionLog} logs={collectionLogs} />
            )}

            {message && <div className="notice-message">{message}</div>}

            <NoticeTable
              notices={sortedNotices}
              loading={loading}
              selectedNoticeId={selectedNotice?.id ?? null}
              gridTemplateColumns={noticeGridColumns}
              sortConfig={sortConfig}
              onSort={handleSort}
              onResizeStart={handleColumnResizeStart}
              onSelect={setSelectedId}
            />
            <div className="pagination-bar">
              <span>
                {total > 0 ? `${pageStart}-${pageEnd}` : "0"} / {total}건
              </span>
              <div>
                <button
                  type="button"
                  disabled={loading || noticePage === 0}
                  onClick={() => setNoticePage((page) => Math.max(0, page - 1))}
                >
                  이전
                </button>
                <strong>{noticePage + 1} / {totalPages}</strong>
                <button
                  type="button"
                  disabled={loading || noticePage + 1 >= totalPages}
                  onClick={() => setNoticePage((page) => Math.min(totalPages - 1, page + 1))}
                >
                  다음
                </button>
              </div>
            </div>
          </section>

          <aside className="detail-pane">
            {selectedNotice ? (
              <NoticeDetail
                notice={selectedNotice}
                mode={mode}
                manualCategory={manualCategory}
                manualReason={manualReason}
                setManualCategory={setManualCategory}
                setManualReason={setManualReason}
                onManualUpdate={handleManualUpdate}
                onReclassify={handleReclassify}
                runAi={runAi}
                setRunAi={setRunAi}
              />
            ) : (
              <div className="empty-state">선택된 공고가 없습니다.</div>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}

function NoticeTable(props: {
  notices: Notice[];
  loading: boolean;
  selectedNoticeId: number | null;
  gridTemplateColumns: string;
  sortConfig: SortConfig;
  onSort: (key: NoticeColumnKey) => void;
  onResizeStart: (event: ReactMouseEvent<HTMLButtonElement>, key: NoticeColumnKey) => void;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="notice-table">
      <div className="table-head" style={{ gridTemplateColumns: props.gridTemplateColumns }}>
        {noticeColumns.map((column) => (
          <div className="table-head-cell" key={column.key}>
            <button className="column-sort-button" type="button" onClick={() => props.onSort(column.key)}>
              <span>{column.label}</span>
              <span className="sort-indicator">{sortIndicator(props.sortConfig, column.key)}</span>
            </button>
            <button
              className="column-resize-handle"
              type="button"
              aria-label={`${column.label} 컬럼 크기 조절`}
              onMouseDown={(event) => props.onResizeStart(event, column.key)}
            />
          </div>
        ))}
      </div>
      {props.loading && <div className="empty-state">처리 중입니다.</div>}
      {!props.loading && props.notices.length === 0 && <div className="empty-state">공고가 없습니다.</div>}
      {!props.loading && props.notices.map((notice) => {
        const displayCategory = scoreCategoryForNotice(notice);
        return (
          <button
            className={`table-row ${props.selectedNoticeId === notice.id ? "selected" : ""}`}
            style={{ gridTemplateColumns: props.gridTemplateColumns }}
            key={notice.id}
            onClick={() => props.onSelect(notice.id)}
          >
            <span className={categoryClass(displayCategory)}>
              {displayCategory}
            </span>
            <strong>{notice.title}</strong>
            <span>{notice.ordering_agency ?? "-"}</span>
            <span>{formatDate(notice.posted_at)}</span>
            <span>{formatDate(notice.deadline_at)}</span>
            <span className="score-cell">
              <strong>{scoreForNotice(notice)}</strong>
              <small>
                {notice.recommendation_score != null
                  ? `회사 ${notice.recommendation_company_score ?? 0} · 주소 ${notice.recommendation_address_score ?? 0}`
                  : `AI ${aiStatusText(notice.classification?.ai_status)}`}
                {" · "}1차 {notice.classification?.primary_score ?? 0}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("admin1234");
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [memberType, setMemberType] = useState("");
  const [preferredIndustries, setPreferredIndustries] = useState("주소정보, 공간정보");
  const [businessAreas, setBusinessAreas] = useState("");
  const [mainProducts, setMainProducts] = useState("");
  const [mainServices, setMainServices] = useState("");
  const [recommendationKeywords, setRecommendationKeywords] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await login({ email, password });
      localStorage.setItem("accessToken", response.access_token);
      onAuthenticated(response.user);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "로그인에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(event: FormEvent) {
    event.preventDefault();
    const missingFields: string[] = [];
    if (!email.trim() || !email.includes("@")) missingFields.push("올바른 이메일");
    if (password.length < 8) missingFields.push("8자 이상 비밀번호");
    if (!companyName.trim()) missingFields.push("회사명");
    if (!contactName.trim()) missingFields.push("담당자명");
    if (missingFields.length > 0) {
      setMessage(`${missingFields.join(", ")}을 입력하세요.`);
      return;
    }

    setLoading(true);
    try {
      await register({
        email: email.trim(),
        password,
        company_name: companyName.trim(),
        contact_name: contactName.trim(),
        phone: phone.trim(),
        member_type: memberType.trim(),
        preferred_industries: splitTags(preferredIndustries),
        business_areas: businessAreas.trim(),
        main_products: mainProducts.trim(),
        main_services: mainServices.trim(),
        recommendation_keywords: recommendationKeywords.trim()
      });
      setMessage("가입 신청이 접수되었습니다. 관리자가 회원사 여부를 확인한 뒤 승인합니다.");
      setTab("login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "가입 신청에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <p className="eyebrow">Member Approval Required</p>
        <h1>주소산업 공고 서비스</h1>
        <div className="mode-toggle auth-toggle">
          <button className={tab === "login" ? "active" : ""} onClick={() => setTab("login")}>로그인</button>
          <button className={tab === "register" ? "active" : ""} onClick={() => setTab("register")}>회원가입 신청</button>
        </div>

        {tab === "login" ? (
          <form className="auth-form" onSubmit={handleLogin}>
            <label>이메일<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>비밀번호<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button disabled={loading} type="submit">로그인</button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleRegister}>
            <label>이메일<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>비밀번호<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>회사명<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
            <label>담당자명<input value={contactName} onChange={(event) => setContactName(event.target.value)} /></label>
            <label>연락처<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
            <label>회원사 유형<input value={memberType} onChange={(event) => setMemberType(event.target.value)} placeholder="예: GIS 기업" /></label>
            <label>관심 분야<input value={preferredIndustries} onChange={(event) => setPreferredIndustries(event.target.value)} /></label>
            <label>전문 분야<input value={businessAreas} onChange={(event) => setBusinessAreas(event.target.value)} placeholder="예: 주소정제, GIS DB, 측량" /></label>
            <label>주요 제품<input value={mainProducts} onChange={(event) => setMainProducts(event.target.value)} placeholder="예: 주소안내시스템, 도로명주소표지판" /></label>
            <label>주요 사업<textarea value={mainServices} onChange={(event) => setMainServices(event.target.value)} placeholder="공고 추천에 쓸 회사의 주요 수행 사업을 입력하세요." /></label>
            <label>추천 키워드<input value={recommendationKeywords} onChange={(event) => setRecommendationKeywords(event.target.value)} placeholder="쉼표로 구분: 디지털트윈, 지하시설물, SI" /></label>
            <button disabled={loading} type="submit">신청</button>
          </form>
        )}

        {message && <div className="notice-message">{message}</div>}
        <p className="auth-help">초기 관리자 계정은 `admin@example.com / admin1234`입니다. 운영 전 `.env`에서 반드시 변경하세요.</p>
      </section>
    </main>
  );
}

function NoticeDetail(props: {
  notice: Notice;
  mode: "user" | "admin";
  manualCategory: FinalCategory;
  manualReason: string;
  setManualCategory: (value: FinalCategory) => void;
  setManualReason: (value: string) => void;
  onManualUpdate: () => void;
  onReclassify: () => void;
  runAi: boolean;
  setRunAi: (value: boolean) => void;
}) {
  const { notice, mode } = props;
  const classification = notice.classification;
  const displayCategory = scoreCategoryForNotice(notice);
  const keywords = flattenKeywords(notice);
  const businessTags = classification?.matched_industries ?? [];
  const summary = buildDisplaySummary(notice);
  const reason = buildDisplayReason(notice);
  const cautions = buildNoticeCautions(notice);
  const attachmentLinks = uniqueStrings([
    ...notice.attachment_urls,
    ...extractUrls(notice.detail_content).filter((url) => url !== notice.notice_url)
  ]);

  return (
    <div className="detail-stack">
      <section className="detail-section">
        <div className="detail-header">
          <span className={categoryClass(displayCategory)}>
            {displayCategory}
          </span>
          {notice.notice_url && (
            <a href={notice.notice_url} target="_blank" rel="noreferrer" className="icon-link" aria-label="공고 열기">
              <ExternalLink size={18} />
            </a>
          )}
        </div>
        <h2>{notice.title}</h2>
        <dl className="meta-grid">
          <div><dt>발주기관</dt><dd>{notice.ordering_agency ?? "-"}</dd></div>
          <div><dt>공고일</dt><dd>{formatDate(notice.posted_at)}</dd></div>
          <div><dt>마감일</dt><dd>{formatDate(notice.deadline_at)}</dd></div>
          <div><dt>예산</dt><dd>{formatBudget(notice.budget_amount)}</dd></div>
        </dl>
        {cautions.length > 0 && (
          <div className="notice-cautions" aria-label="입찰 유의사항">
            {cautions.map((item) => (
              <div className={`notice-caution ${item.level}`} key={`${item.label}-${item.value}`}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="detail-section">
        <h3>1차 키워드 분류</h3>
        <div className="score-line">
          <strong>{classification?.primary_score ?? 0}점</strong>
          <span>{classification?.primary_category ?? "미분류"}</span>
        </div>
        <div className="chip-row">
          {keywords.length ? keywords.map((keyword) => <span key={keyword}>{keyword}</span>) : <span>매칭 없음</span>}
        </div>
        {classification?.excluded_keyword_hits?.length ? (
          <div className="chip-row warning">
            {classification.excluded_keyword_hits.map((keyword) => <span key={keyword}>{keyword}</span>)}
          </div>
        ) : null}
      </section>

      <section className="detail-section">
        <h3>업무 구분</h3>
        <div className="chip-row business-tags">
          {businessTags.length ? businessTags.map((tag) => <span key={tag}>{tag}</span>) : <span>구분자 없음</span>}
        </div>
      </section>

      {notice.recommendation_score ? (
        <section className="detail-section recommendation-section">
          <h3>내 회사 관련 공고 근거</h3>
          <div className="score-line">
            <strong>{notice.recommendation_score}점</strong>
            <span>회사 키워드 {notice.recommendation_company_score ?? 0}점 · 주소 관련성 {notice.recommendation_address_score ?? 0}점</span>
          </div>
          <div className="chip-row recommendation-kind-tags">
            {(notice.recommendation_tags ?? []).map((tag) => <span key={tag} className={tag === "회사관련" ? "company" : "address"}>{tag}</span>)}
          </div>
          <div className="chip-row recommendation-tags">
            {(notice.recommendation_reasons ?? []).map((reason) => <span key={reason}>{reason}</span>)}
          </div>
        </section>
      ) : null}

      <section className="detail-section">
        <h3>상세 요약</h3>
        <p className="summary">{summary}</p>
        <div className="score-line">
          <Sparkles size={18} />
          <span>AI 점수 {classification?.ai_relevance_score ?? "-"} · {classification?.ai_status ?? "not_requested"}</span>
        </div>
      </section>

      <section className="detail-section">
        <h3>분류 사유</h3>
        <p className="summary">{reason}</p>
      </section>

      <section className="detail-section">
        <h3>상세내용</h3>
        <div className="link-list">
          <div className="link-list-header">원문 링크</div>
          {notice.notice_url ? (
            <a className="notice-url-link" href={notice.notice_url} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              <span>나라장터 공고 원문 보기</span>
              <small>{notice.notice_url}</small>
            </a>
          ) : (
            <div className="empty-state compact">등록된 원문 링크가 없습니다.</div>
          )}
        </div>
        <div className="link-list">
          <div className="link-list-header">첨부파일 링크</div>
          {attachmentLinks.length > 0 ? (
            <div className="attachment-list">
              {attachmentLinks.map((url, index) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  <span>첨부파일 {index + 1}</span>
                  <small>{url}</small>
                </a>
              ))}
            </div>
          ) : (
            <div className="empty-state compact">공고에 포함된 첨부파일 링크가 없습니다.</div>
          )}
        </div>
      </section>

      {mode === "admin" && (
        <section className="detail-section admin-edit">
          <h3>관리자 보정</h3>
          <select value={props.manualCategory} onChange={(event) => props.setManualCategory(event.target.value as FinalCategory)}>
            {categories.map((category) => <option key={category}>{category}</option>)}
          </select>
          <textarea value={props.manualReason} onChange={(event) => props.setManualReason(event.target.value)} placeholder="수정 사유" />
          <div className="button-row">
            <button onClick={props.onManualUpdate}>수정 저장</button>
            <label className="check-label">
              <input type="checkbox" checked={props.runAi} onChange={(event) => props.setRunAi(event.target.checked)} />
              AI 포함
            </label>
            <button onClick={props.onReclassify}>
              <RefreshCw size={16} />
              재분류
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

type MemberFilter = "all" | UserApprovalStatus | "inactive";

type UserDraft = {
  company_name: string;
  contact_name: string;
  phone: string;
  member_type: string;
  preferred_industries: string;
  role: User["role"];
  approval_status: UserApprovalStatus;
  approval_notes: string;
  is_active: boolean;
};

const userStatusLabels: Record<UserApprovalStatus, string> = {
  pending: "승인 대기",
  approved: "승인",
  rejected: "반려"
};

function createUserDraft(user: User): UserDraft {
  return {
    company_name: user.company_name ?? "",
    contact_name: user.contact_name ?? "",
    phone: user.phone ?? "",
    member_type: user.member_type ?? "",
    preferred_industries: user.preferred_industries.join(", "),
    role: user.role,
    approval_status: user.approval_status,
    approval_notes: user.approval_notes ?? "",
    is_active: user.is_active
  };
}

function userStatusLabel(user: User) {
  if (!user.is_active && user.approval_status === "approved") return "비활성";
  if (!user.is_active && user.approval_status === "rejected") return "반려/탈퇴";
  return userStatusLabels[user.approval_status];
}

function userStatusClass(user: User) {
  if (!user.is_active) return "inactive";
  return user.approval_status;
}

function UserManagementPanel({
  users,
  onApprove,
  onReject,
  onSave,
  onWithdraw
}: {
  users: User[];
  onApprove: (user: User) => void | Promise<void>;
  onReject: (user: User) => void | Promise<void>;
  onSave: (user: User, payload: UserAdminUpdatePayload) => void | Promise<void>;
  onWithdraw: (user: User) => void | Promise<void>;
}) {
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<UserDraft | null>(null);

  const counts = useMemo(() => ({
    all: users.length,
    pending: users.filter((user) => user.approval_status === "pending").length,
    approved: users.filter((user) => user.approval_status === "approved").length,
    rejected: users.filter((user) => user.approval_status === "rejected").length,
    inactive: users.filter((user) => !user.is_active).length
  }), [users]);

  const filteredUsers = useMemo(() => users.filter((user) => {
    if (filter === "all") return true;
    if (filter === "inactive") return !user.is_active;
    return user.approval_status === filter;
  }), [filter, users]);

  function beginEdit(user: User) {
    setEditingId(user.id);
    setDraft(createUserDraft(user));
  }

  function updateDraft<K extends keyof UserDraft>(key: K, value: UserDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function submitEdit(event: FormEvent, user: User) {
    event.preventDefault();
    if (!draft) return;
    await onSave(user, {
      company_name: draft.company_name,
      contact_name: draft.contact_name,
      phone: draft.phone,
      member_type: draft.member_type,
      preferred_industries: splitTags(draft.preferred_industries),
      role: draft.role,
      approval_status: draft.approval_status,
      approval_notes: draft.approval_notes,
      is_active: draft.is_active
    });
    setEditingId(null);
    setDraft(null);
  }

  return (
    <section className="dictionary-panel">
      <div className="member-panel-heading">
        <div>
          <h3>회원 관리</h3>
          <p>가입 신청, 승인 회원, 비활성 회원을 조회하고 회사 정보와 추천 키워드를 수정합니다.</p>
        </div>
        <strong>전체 {counts.all}명</strong>
      </div>
      <div className="member-toolbar" role="tablist" aria-label="회원 필터">
        {[
          ["all", `전체 ${counts.all}`],
          ["pending", `승인 대기 ${counts.pending}`],
          ["approved", `승인 ${counts.approved}`],
          ["rejected", `반려 ${counts.rejected}`],
          ["inactive", `비활성 ${counts.inactive}`]
        ].map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? "active" : ""}
            onClick={() => setFilter(key as MemberFilter)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {filteredUsers.length === 0 && <div className="empty-state compact">표시할 회원이 없습니다.</div>}
      <div className="approval-list">
        {filteredUsers.map((user) => {
          const isEditing = editingId === user.id && draft;
          return (
            <div className="approval-item member-item" key={user.id}>
              <div className="member-card-header">
                <div>
                  <strong>{user.company_name ?? user.email}</strong>
                  <span>{user.contact_name ?? "-"} · {user.member_type ?? "유형 미입력"}</span>
                </div>
                <span className={`member-status ${userStatusClass(user)}`}>{userStatusLabel(user)}</span>
              </div>

              {isEditing ? (
                <form className="member-form" onSubmit={(event) => submitEdit(event, user)}>
                  <label>
                    회사명
                    <input value={draft.company_name} onChange={(event) => updateDraft("company_name", event.target.value)} />
                  </label>
                  <label>
                    담당자
                    <input value={draft.contact_name} onChange={(event) => updateDraft("contact_name", event.target.value)} />
                  </label>
                  <label>
                    연락처
                    <input value={draft.phone} onChange={(event) => updateDraft("phone", event.target.value)} />
                  </label>
                  <label>
                    회원사 유형
                    <input value={draft.member_type} onChange={(event) => updateDraft("member_type", event.target.value)} />
                  </label>
                  <label>
                    권한
                    <select value={draft.role} onChange={(event) => updateDraft("role", event.target.value as User["role"])}>
                      <option value="viewer">회원</option>
                      <option value="admin">관리자</option>
                    </select>
                  </label>
                  <label>
                    승인 상태
                    <select value={draft.approval_status} onChange={(event) => updateDraft("approval_status", event.target.value as UserApprovalStatus)}>
                      <option value="pending">승인 대기</option>
                      <option value="approved">승인</option>
                      <option value="rejected">반려</option>
                    </select>
                  </label>
                  <label className="member-form-wide">
                    추천 키워드
                    <textarea value={draft.preferred_industries} onChange={(event) => updateDraft("preferred_industries", event.target.value)} placeholder="쉼표로 구분" />
                  </label>
                  <label className="member-form-wide">
                    관리자 메모
                    <textarea value={draft.approval_notes} onChange={(event) => updateDraft("approval_notes", event.target.value)} />
                  </label>
                  <label className="check-label member-active-check">
                    <input type="checkbox" checked={draft.is_active} onChange={(event) => updateDraft("is_active", event.target.checked)} />
                    로그인 활성화
                  </label>
                  <div className="button-row member-form-wide">
                    <button type="submit"><Check size={15} />저장</button>
                    <button type="button" onClick={() => { setEditingId(null); setDraft(null); }}><X size={15} />취소</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="member-summary">
                    <small>{user.email} · {user.phone ?? "연락처 없음"}</small>
                    <small>권한 {user.role === "admin" ? "관리자" : "회원"} · 가입일 {formatDate(user.created_at)}</small>
                    {user.approval_notes && <small>메모: {user.approval_notes}</small>}
                  </div>
                  {user.preferred_industries.length > 0 && (
                    <div className="chip-row member-tags">
                      {user.preferred_industries.map((keyword) => <span key={keyword}>{keyword}</span>)}
                    </div>
                  )}
                  <div className="button-row">
                    <button type="button" onClick={() => beginEdit(user)}><Pencil size={15} />수정</button>
                    {user.approval_status !== "approved" && (
                      <button type="button" onClick={() => onApprove(user)}><Check size={15} />승인</button>
                    )}
                    {user.approval_status !== "rejected" && (
                      <button type="button" onClick={() => onReject(user)}><X size={15} />반려</button>
                    )}
                    <button type="button" className="danger-button" onClick={() => onWithdraw(user)}><Trash2 size={15} />탈퇴 처리</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DictionaryPanel(props: {
  keywords: Keyword[];
  excludedKeywords: ExcludedKeyword[];
  newKeyword: string;
  newGrade: string;
  newExcludedKeyword: string;
  setNewKeyword: (value: string) => void;
  setNewGrade: (value: string) => void;
  setNewExcludedKeyword: (value: string) => void;
  onCreateKeyword: (event: FormEvent) => void;
  onCreateExcludedKeyword: (event: FormEvent) => void;
  onDeleteKeyword: (id: number) => void;
  onDeleteExcludedKeyword: (id: number) => void;
}) {
  return (
    <section className="dictionary-panel">
      <h3>키워드 사전</h3>
      <form className="inline-form" onSubmit={props.onCreateKeyword}>
        <input value={props.newKeyword} onChange={(event) => props.setNewKeyword(event.target.value)} placeholder="키워드" />
        <select value={props.newGrade} onChange={(event) => props.setNewGrade(event.target.value)}>
          {["S", "A", "B", "C", "D"].map((grade) => <option key={grade}>{grade}</option>)}
        </select>
        <button type="submit" aria-label="키워드 추가"><Plus size={16} /></button>
      </form>
      <p className="dictionary-count">등록 키워드 {props.keywords.length}개</p>
      <div className="keyword-list">
        {props.keywords.map((keyword) => (
          <span key={keyword.id}>
            {keyword.grade}:{keyword.keyword}
            <button onClick={() => props.onDeleteKeyword(keyword.id)} aria-label={`${keyword.keyword} 삭제`}>
              <Trash2 size={13} />
            </button>
          </span>
        ))}
      </div>

      <h3>제외 키워드</h3>
      <form className="inline-form" onSubmit={props.onCreateExcludedKeyword}>
        <input value={props.newExcludedKeyword} onChange={(event) => props.setNewExcludedKeyword(event.target.value)} placeholder="제외 키워드" />
        <button type="submit" aria-label="제외 키워드 추가"><Plus size={16} /></button>
      </form>
      <p className="dictionary-count">등록 제외 키워드 {props.excludedKeywords.length}개</p>
      <div className="keyword-list excluded-list">
        {props.excludedKeywords.map((keyword) => (
          <span key={keyword.id}>
            {keyword.keyword}
            <button onClick={() => props.onDeleteExcludedKeyword(keyword.id)} aria-label={`${keyword.keyword} 삭제`}>
              <Trash2 size={13} />
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}
