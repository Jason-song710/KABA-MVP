import { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useState } from "react";
import {
  Check,
  ExternalLink,
  FileUp,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  collectNotices,
  createExcludedKeyword,
  createKeyword,
  deleteExcludedKeyword,
  deleteKeyword,
  fetchAIStatus,
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
  updateUserApproval,
  uploadCsv
} from "./api";
import type { AIStatus, ExcludedKeyword, FinalCategory, Keyword, Notice, User } from "./types";

const categories: FinalCategory[] = ["주소산업 핵심공고", "주소산업 관련공고", "참고공고", "제외공고"];

const viewTabs: Array<{ key: string; label: string; category?: FinalCategory; today?: boolean; activeOnly?: boolean; recommended?: boolean }> = [
  { key: "recommended", label: "내 회사 관련 공고", activeOnly: true, recommended: true },
  { key: "active", label: "입찰 진행중 공고", activeOnly: true },
  { key: "today", label: "오늘 등록 공고", today: true },
  { key: "core", label: "핵심공고", category: "주소산업 핵심공고" },
  { key: "related", label: "관련공고", category: "주소산업 관련공고" },
  { key: "reference", label: "참고공고", category: "참고공고" },
  { key: "all", label: "전체" }
];

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
  "prtcptPsblRgnNm",
  "prtcptPsblRgnCd",
  "indstrytyLmtCd",
  "indstrytyLmtCdNm",
  "indstrytyNm",
  "bidprcPsblIndstrytyNm"
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

function buildNoticeCautions(notice: Notice): NoticeCaution[] {
  const text = `${notice.title}\n${notice.detail_content ?? ""}`;
  const contractMethod = detailField(notice, ["cntrctCnclsMthdNm"]);
  const bidMethod = detailField(notice, ["bidMethdNm"]);
  const bidLimit = detailField(notice, ["bidPrtcptLmtYn"]);
  const regionLimit = detailField(notice, ["prtcptPsblRgnNm", "rgnLmtBidLocplcJdgmBssCdNm", "rgnLmtBidLocplcJdgmBssCd", "prtcptPsblRgnCd"]);
  const industryLimit = detailField(notice, ["bidprcPsblIndstrytyNm", "indstrytyNm", "indstrytyLmtCdNm", "indstrytyLmtYn", "indstrytyLmtCd"]);
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
  if (industryLimit && !isEmptyLimitValue(industryLimit)) {
    items.push({ label: "업종제한", value: displayLimitValue(industryLimit), level: "warning" });
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
    `키워드 근거는 ${keywordText}이며, 1차 점수 ${classification?.primary_score ?? 0}점으로 '${classification?.effective_category ?? "미분류"}'로 표시됩니다.` +
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

function scoreForNotice(notice: Notice) {
  return notice.recommendation_score ?? notice.classification?.ai_relevance_score ?? notice.classification?.primary_score ?? 0;
}

function sortValue(notice: Notice, key: NoticeColumnKey) {
  if (key === "category") return notice.classification?.effective_category ?? "";
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

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mode, setMode] = useState<"user" | "admin">("user");
  const [adminPage, setAdminPage] = useState<AdminPage>("notices");
  const [activeView, setActiveView] = useState("recommended");
  const [query, setQuery] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "deadline", direction: "asc" });
  const [columnWidths, setColumnWidths] = useState<Record<NoticeColumnKey, number>>(loadColumnWidths);

  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [excludedKeywords, setExcludedKeywords] = useState<ExcludedKeyword[]>([]);
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
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
      const category = notice.classification?.effective_category;
      if (category) initial[category] += 1;
    });
    return initial;
  }, [notices]);

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

  async function loadNotices(silent = false) {
    if (!currentUser) return;
    if (!silent) setLoading(true);
    try {
      const response = activeTab.recommended
        ? await fetchRecommendedNotices({
            q: query,
            active_only: Boolean(activeTab.activeOnly),
            limit: 100
          })
        : await fetchNotices({
            q: query,
            category: activeTab.category ?? "",
            today: Boolean(activeTab.today),
            active_only: Boolean(activeTab.activeOnly),
            limit: 100
          });
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
      const [keywordList, excludedList, users, status] = await Promise.all([
        fetchKeywords(),
        fetchExcludedKeywords(),
        fetchUsers("pending"),
        fetchAIStatus()
      ]);
      setKeywords(keywordList);
      setExcludedKeywords(excludedList);
      setPendingUsers(users);
      setAiStatus(status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "관리자 데이터를 불러오지 못했습니다.");
    }
  }

  useEffect(() => {
    restoreSession();
  }, []);

  useEffect(() => {
    if (currentUser) loadNotices();
  }, [currentUser, activeView]);

  useEffect(() => {
    if (!currentUser) return undefined;
    const timer = window.setInterval(() => {
      void loadNotices(true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [currentUser, activeView, query]);

  useEffect(() => {
    if (mode === "admin") loadAdminData();
  }, [mode, currentUser]);

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
    await loadNotices();
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
        run_ai: runAi
      });
      setMessage(
        `수집 ${result.fetched_count}건, 신규 ${result.created_count}건, 갱신 ${result.updated_count}건, 중복 ${result.duplicate_count}건`
      );
      await loadNotices();
      if (runAi) await loadAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "수집에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const result = await uploadCsv(file);
      setMessage(
        `업로드 신규 ${result.created_count}건, 갱신 ${result.updated_count}건, 중복 ${result.duplicate_count}건, 분류 ${result.classified_count}건`
      );
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
            <button className={mode === "user" ? "active" : ""} onClick={() => setMode("user")}>사용자</button>
            {isAdmin && <button className={mode === "admin" ? "active" : ""} onClick={() => setMode("admin")}>관리자</button>}
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
          <button className={adminPage === "users" ? "active" : ""} onClick={() => setAdminPage("users")}>회원 승인 {pendingUsers.length ? `(${pendingUsers.length})` : ""}</button>
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
          <UserApprovalPanel users={pendingUsers} onApprove={handleApproveUser} onReject={handleRejectUser} />
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
                    onClick={() => setActiveView(tab.key)}
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
                </form>
                <label className="file-button">
                  <FileUp size={16} />
                  CSV 업로드
                  <input type="file" accept=".csv" onChange={handleUpload} />
                </label>
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
      {!props.loading && props.notices.map((notice) => (
        <button
          className={`table-row ${props.selectedNoticeId === notice.id ? "selected" : ""}`}
          style={{ gridTemplateColumns: props.gridTemplateColumns }}
          key={notice.id}
          onClick={() => props.onSelect(notice.id)}
        >
          <span className={categoryClass(notice.classification?.effective_category)}>
            {notice.classification?.effective_category ?? "미분류"}
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
      ))}
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
          <span className={categoryClass(classification?.effective_category)}>
            {classification?.effective_category ?? "미분류"}
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

function UserApprovalPanel({
  users,
  onApprove,
  onReject
}: {
  users: User[];
  onApprove: (user: User) => void;
  onReject: (user: User) => void;
}) {
  return (
    <section className="dictionary-panel">
      <h3>회원가입 승인 대기</h3>
      {users.length === 0 && <div className="empty-state compact">승인 대기 회원이 없습니다.</div>}
      <div className="approval-list">
        {users.map((user) => (
          <div className="approval-item" key={user.id}>
            <div>
              <strong>{user.company_name ?? user.email}</strong>
              <span>{user.contact_name ?? "-"} · {user.member_type ?? "유형 미입력"}</span>
              <small>{user.email} · {user.phone ?? "연락처 없음"}</small>
              {user.preferred_industries.length > 0 && (
                <small>추천 키워드: {user.preferred_industries.join(", ")}</small>
              )}
            </div>
            <div className="button-row">
              <button onClick={() => onApprove(user)}><Check size={15} />승인</button>
              <button onClick={() => onReject(user)}><X size={15} />반려</button>
            </div>
          </div>
        ))}
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
