import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
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

const viewTabs: Array<{ key: string; label: string; category?: FinalCategory; today?: boolean; activeOnly?: boolean }> = [
  { key: "active", label: "입찰 진행중 공고", activeOnly: true },
  { key: "today", label: "오늘 등록 공고", today: true },
  { key: "core", label: "핵심공고", category: "주소산업 핵심공고" },
  { key: "related", label: "관련공고", category: "주소산업 관련공고" },
  { key: "reference", label: "참고공고", category: "참고공고" },
  { key: "all", label: "전체" }
];

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

function keywordGroups(notice: Notice | null) {
  const matched = notice?.classification?.matched_keywords;
  if (!matched) return [];
  return Object.entries(matched)
    .filter(([, values]) => values.length > 0)
    .map(([grade, values]) => `${grade}등급 ${values.join(", ")}`);
}

function compactDetail(value: string | null, limit = 340) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "상세내용이 제공되지 않았습니다.";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildDisplaySummary(notice: Notice) {
  const classification = notice.classification;
  const stored = classification?.ai_summary?.trim();
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
  const manualReason = classification?.manual_reason?.trim();
  if (manualReason) return manualReason;
  const aiReason = classification?.ai_reason?.trim();
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

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mode, setMode] = useState<"user" | "admin">("user");
  const [activeView, setActiveView] = useState("active");
  const [query, setQuery] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

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
      const response = await fetchNotices({
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

  function handleLogout() {
    localStorage.removeItem("accessToken");
    setCurrentUser(null);
    setNotices([]);
    setMode("user");
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

          <div className="notice-table">
            <div className="table-head">
              <span>분류</span>
              <span>공고명</span>
              <span>발주기관</span>
              <span>점수</span>
              <span>마감</span>
            </div>
            {loading && <div className="empty-state">처리 중입니다.</div>}
            {!loading && notices.length === 0 && <div className="empty-state">공고가 없습니다.</div>}
            {!loading && notices.map((notice) => (
              <button
                className={`table-row ${selectedNotice?.id === notice.id ? "selected" : ""}`}
                key={notice.id}
                onClick={() => setSelectedId(notice.id)}
              >
                <span className={categoryClass(notice.classification?.effective_category)}>
                  {notice.classification?.effective_category ?? "미분류"}
                </span>
                <strong>{notice.title}</strong>
                <span>{notice.ordering_agency ?? "-"}</span>
                <span className="score-cell">
                  <strong>{notice.classification?.ai_relevance_score ?? "-"}</strong>
                  <small>AI {aiStatusText(notice.classification?.ai_status)} · 1차 {notice.classification?.primary_score ?? 0}</small>
                </span>
                <span>{formatDate(notice.deadline_at)}</span>
              </button>
            ))}
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

          {mode === "admin" && (
            <>
              <UserApprovalPanel users={pendingUsers} onApprove={handleApproveUser} onReject={handleRejectUser} />
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
            </>
          )}
        </aside>
      </main>
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
    setLoading(true);
    try {
      await register({
        email,
        password,
        company_name: companyName,
        contact_name: contactName,
        phone,
        member_type: memberType,
        preferred_industries: splitTags(preferredIndustries)
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
        {notice.notice_url && (
          <a className="notice-url-link" href={notice.notice_url} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            <span>공고 원문 보기</span>
            <small>{notice.notice_url}</small>
          </a>
        )}
        <pre className="detail-content">{notice.detail_content || "-"}</pre>
        {notice.attachment_urls.length > 0 && (
          <div className="attachment-list">
            {notice.attachment_urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>
            ))}
          </div>
        )}
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
