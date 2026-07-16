# 주소산업 공고 자동수집·자동분류 MVP

나라장터 등 공공입찰 공고를 수집하고, 주소산업 키워드 기반 1차 분류와 OpenAI 기반 2차 분류를 적용하는 React + FastAPI + PostgreSQL MVP입니다.

## 구성

- Frontend: React + TypeScript + Vite
- Backend: FastAPI + SQLAlchemy
- DB: PostgreSQL
- AI: OpenAI API 연동 구조
- 배포: Docker Compose
- 샘플 데이터: `backend/data/sample_notices.csv` 10건

## 실행

```bash
cp .env.example .env
docker compose up --build
```

- 웹: `http://localhost:3000`
- API 문서: `http://localhost:8000/docs`
- 헬스체크: `http://localhost:8000/health`

## 환경변수

`.env`에 값을 설정합니다. 인증키는 소스코드에 넣지 않습니다.

- `AUTH_SECRET_KEY`: 로그인 토큰 서명 키. 운영 전 반드시 긴 임의 문자열로 변경
- `ADMIN_EMAIL`: 초기 관리자 이메일
- `ADMIN_PASSWORD`: 초기 관리자 비밀번호. 운영 전 반드시 변경
- `OPENAI_API_KEY`: AI 2차 분류를 실행할 때 필요
- `OPENAI_MODEL`: 기본값 `gpt-4.1-mini`
- `G2B_API_ENDPOINT`: `https://apis.data.go.kr/1230000/ad/BidPublicInfoService`
- `G2B_API_KEY`: 나라장터 API Decoding 인증키 권장
- `G2B_API_OPERATIONS`: 나라장터 조회 operation 목록. 기본값은 용역, 물품, 공사, 기타, 외자 공고를 모두 조회
- `G2B_NUM_ROWS`: 페이지별 수집 건수. 테스트는 `10`, 운영은 `100` 권장
- `G2B_INQRY_DIVS`: 나라장터 조회 구분. `1`은 최근 등록, `2`는 마감/개찰 기준이며 기본값은 `1,2`
- `G2B_MAX_PAGES_PER_OPERATION`: operation과 조회 구분별 최대 페이지 수. `0`이면 나라장터 `totalCount` 기준으로 끝까지 조회
- `G2B_RECENT_WINDOW_DAYS`: `inqryDiv=1` 기본 조회 기간
- `G2B_DEADLINE_WINDOW_DAYS`: `inqryDiv=2` 기본 조회 기간
- `G2B_AUTO_COLLECT_ENABLED`: 서버 실행 중 자동 수집 사용 여부
- `G2B_AUTO_COLLECT_INTERVAL_MINUTES`: 자동 수집 주기
- `G2B_AUTO_COLLECT_ON_STARTUP`: 서버 시작 직후 자동 수집 여부
- `G2B_AUTO_COLLECT_RUN_AI`: 자동 수집 시 AI 2차 분류 실행 여부. 비용 방지를 위해 기본값은 `false`
- `SEED_SAMPLE_DATA`: 샘플 공고 자동 주입 여부. 실제 수집 테스트는 `false` 권장

나라장터 키는 `Decoding 인증키`를 넣는 편이 안전합니다. HTTP 클라이언트가 쿼리스트링을 다시 인코딩하므로 Encoding 키를 그대로 넣으면 `%`가 이중 인코딩될 수 있습니다.

실제 공고를 보려면 `.env`에서 `SEED_SAMPLE_DATA=false`로 두세요. `G2B_API_KEY`가 설정된 상태에서는 서버 시작 시 기존 샘플 공고도 자동 제거됩니다.

## 분류 흐름

1. 나라장터 API 전체 수집 또는 CSV 업로드
2. `notice_no` 우선, 없으면 `공고명 + 발주기관 + 공고일` 기준 중복 제거
3. 공고명, 발주기관, API 상세 필드, 원문 상세에서 추출한 업종/지역/참가자격 텍스트를 기준으로 키워드 사전 점수 산정
4. OpenAI API가 설정된 경우 JSON 응답 기반 2차 분류
5. AI 실패 시 1차 분류 결과를 최종값으로 사용
6. 관리자 수동 수정값이 있으면 AI 결과보다 우선 적용

수집 단계에서는 `GIS` 같은 검색어로 나라장터 API 결과를 좁히지 않습니다. 먼저 나라장터 진행 공고를 넓게 저장한 뒤, 저장된 공고 전체를 대상으로 키워드 검색, 주소산업 핵심/관련/참고/제외 분류, 내 회사 관련 공고 추천을 수행합니다.

## 공고 목록 기준

기본 화면은 `입찰 진행중 공고`입니다. 마감일이 지나지 않았거나 마감일이 비어 있는 공고는 목록에 계속 남습니다. 오늘 등록된 공고만 보려면 `오늘 등록 공고` 탭을 사용합니다.

목록은 60초마다 자동으로 다시 조회하고 마지막 갱신시각을 표시합니다. 백엔드는 `G2B_AUTO_COLLECT_ENABLED=true`이면 서버 실행 중 `G2B_AUTO_COLLECT_INTERVAL_MINUTES` 주기로 나라장터를 다시 수집합니다. 기본 수집 범위는 최근 등록 30일, 마감 기준 60일이며 용역/물품/공사/기타/외자 공고를 모두 조회합니다. 중복 공고라도 마감일, 원문 링크, 첨부, 예산, 원본 응답이 바뀌면 `갱신`으로 집계됩니다.

## 회원가입 승인 흐름

1. 사용자가 로그인 화면에서 회원가입 신청
2. 신청 계정은 `pending` 상태로 저장되며 공고 조회 불가
3. 관리자가 `admin@example.com / admin1234`로 로그인
4. 관리자 화면의 `회원가입 승인 대기`에서 회원사 여부 확인 후 승인 또는 반려
5. 승인된 사용자만 공고 목록과 상세를 조회

운영 전 `.env`의 `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `AUTH_SECRET_KEY`를 반드시 바꾸세요.

## 다른 사람이 접속하게 하는 방법

같은 사무실/같은 와이파이의 다른 PC에서 보려면 실행 PC의 내부 IP를 확인합니다.

Windows PowerShell:

```powershell
ipconfig
```

예를 들어 실행 PC의 IPv4 주소가 `192.168.0.25`이면 다른 사람은 아래 주소로 접속합니다.

```text
http://192.168.0.25:3000
```

Windows 방화벽에서 Docker Desktop 또는 3000번 포트 인바운드 허용이 필요할 수 있습니다. 외부 인터넷 사용자에게 공개하려면 공유기 포트포워딩, 고정 도메인, HTTPS, 서버 배포가 필요하므로 운영 환경에서는 클라우드 VM 또는 사내 서버에 Docker Compose로 올리는 방식을 권장합니다.

## 수집 요청이 오래 걸릴 때

나라장터 API가 느리거나 `G2B_API_OPERATIONS`에 여러 조회 operation이 들어 있으면 수집이 1분 이상 걸릴 수 있습니다. 테스트할 때는 `.env`에서 아래처럼 줄여 먼저 확인하세요.

```env
G2B_NUM_ROWS=10
G2B_MAX_PAGES_PER_OPERATION=1
G2B_API_OPERATIONS=getBidPblancListInfoServcPPSSrch
```

정상 수집이 확인되면 용역/물품/공사/기타/외자 operation과 페이지 수를 다시 늘리면 됩니다. 운영에서는 `G2B_MAX_PAGES_PER_OPERATION=0`, `G2B_INQRY_DIVS=1,2`를 유지하면 최근 등록 공고와 마감/개찰 기준 공고를 함께 끝까지 가져옵니다.

## 주요 문서

- DB 스키마: `docs/schema.sql`
- API 명세: `docs/api.md`
- 화면별 기능: `docs/screens.md`

## CSV 업로드 형식

샘플 파일: `backend/data/sample_notices.csv`

지원 컬럼:

- `notice_no`
- `title`
- `ordering_agency`
- `posted_at`
- `deadline_at`
- `budget_amount`
- `notice_url`
- `detail_content`
- `attachment_urls`

한국어 헤더(`공고번호`, `공고명`, `발주기관`, `공고일`, `마감일`, `예산`, `공고URL`, `상세내용`, `첨부파일URL`)도 지원합니다.

## 확장 포인트

- `users.preferred_industries`, `users.member_type`을 기반으로 회원사 맞춤 추천 점수 추가
- `recommended_member_types`와 회원사 전문분야 매칭 테이블 분리
- 첨부파일 다운로드·본문 추출·요약 파이프라인 추가
- Alembic 마이그레이션과 관리자 인증 추가
