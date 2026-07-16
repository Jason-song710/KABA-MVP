# API 명세

Base URL: `http://localhost:8000/api`

## 인증 API

### `POST /auth/register`

회원사가 서비스 이용을 신청한다. 신청 직후 상태는 `pending`이며, 공고 조회는 불가능하다.

```json
{
  "email": "member@example.com",
  "password": "member1234",
  "company_name": "주소정제 주식회사",
  "contact_name": "홍길동",
  "phone": "02-0000-0000",
  "member_type": "주소정제 기업",
  "preferred_industries": ["주소정보", "AI·데이터"]
}
```

### `POST /auth/login`

승인된 사용자만 로그인할 수 있다.

```json
{
  "email": "admin@example.com",
  "password": "admin1234"
}
```

응답의 `access_token`을 `Authorization: Bearer <token>` 헤더에 넣어 API를 호출한다.

### `GET /auth/me`

현재 로그인 사용자를 조회한다.

## 사용자 API

### `GET /notices`

승인된 사용자가 수집된 공고 목록을 조회한다.

Query:

- `q`: 공고명, 발주기관, 상세내용 검색어
- `category`: `주소산업 핵심공고`, `주소산업 관련공고`, `참고공고`, `제외공고`
- `today`: `true`이면 오늘 공고만 조회
- `active_only`: `true`이면 마감일이 지나지 않았거나 마감일이 비어 있는 공고만 조회
- `limit`: 1-200
- `offset`: 페이지 오프셋

### `GET /notices/{notice_id}`

공고 상세와 1차/2차 분류 결과를 조회한다.

### `POST /notices/upload-csv`

CSV 파일을 업로드해 공고를 저장하고 1차 분류를 수행한다.

지원 헤더:

- `notice_no` 또는 `공고번호`
- `title` 또는 `공고명`
- `ordering_agency` 또는 `발주기관`
- `posted_at` 또는 `공고일`
- `deadline_at` 또는 `마감일`
- `budget_amount` 또는 `예산`
- `notice_url` 또는 `공고URL`
- `detail_content` 또는 `상세내용`
- `attachment_urls` 또는 `첨부파일URL`

## 관리자 API

관리자 권한이 필요하다.

### `POST /admin/collect`

나라장터 입찰공고 API에서 공고를 수집한다.

기본 설정은 최근 등록(`inqryDiv=1`)과 마감/개찰 기준(`inqryDiv=2`)을 함께 조회한다. 기본 operation은 용역, 물품, 공사, 기타, 외자 공고이며 `G2B_MAX_PAGES_PER_OPERATION=0`이면 나라장터 `totalCount` 기준으로 끝까지 페이지네이션한다. 중복 공고라도 마감일, 원문 링크, 첨부, 예산, 원본 응답이 바뀌면 `updated_count`로 집계한다.

수집 API는 나라장터 결과를 검색어로 좁히기보다 전체 공고를 저장하는 용도다. 저장 후 `/notices`의 `q`, `category`, `active_only` 조건과 키워드 분류 결과로 검색, 핵심/관련/참고/제외, 내 회사 관련 공고를 구분한다.

Body:

```json
{
  "start_date": "2026-07-01T00:00:00",
  "end_date": "2026-07-02T23:59:59",
  "run_ai": false
}
```

Response:

```json
{
  "fetched_count": 600,
  "created_count": 120,
  "updated_count": 35,
  "duplicate_count": 445,
  "classified_count": 600,
  "errors": []
}
```

### `POST /admin/notices/{notice_id}/reclassify`

공고를 수동 재분류한다.

Body:

```json
{ "run_ai": true }
```

`run_ai=false`이면 1차 키워드 분류만 다시 수행한다.

### `PATCH /admin/notices/{notice_id}/classification`

관리자가 최종 분류를 수정한다. 관리자 수정값은 AI 결과보다 우선한다.

```json
{
  "final_category": "주소산업 핵심공고",
  "manual_reason": "주소DB 정제와 주소검색 API가 핵심 과업임"
}
```

### `GET /admin/keywords`

키워드 사전을 조회한다.

### `POST /admin/keywords`

키워드를 추가한다.

```json
{
  "keyword": "위치기반 서비스",
  "grade": "A"
}
```

### `DELETE /admin/keywords/{keyword_id}`

키워드를 삭제한다.

### `GET /admin/excluded-keywords`

제외 키워드를 조회한다.

### `POST /admin/excluded-keywords`

제외 키워드를 추가한다.

```json
{
  "keyword": "기념품",
  "is_strong": true
}
```

### `DELETE /admin/excluded-keywords/{keyword_id}`

제외 키워드를 삭제한다.

### `GET /admin/collection-logs`

나라장터 수집 성공/실패 로그를 조회한다.

### `GET /admin/users`

회원가입 신청자를 조회한다.

Query:

- `approval_status`: `pending`, `approved`, `rejected`

### `PATCH /admin/users/{user_id}/approval`

회원사 여부 확인 후 승인 또는 반려한다.

```json
{
  "approval_status": "approved",
  "role": "viewer",
  "member_type": "GIS 기업",
  "approval_notes": "협회 회원사 확인 완료"
}
```
