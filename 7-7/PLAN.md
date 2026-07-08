# tax-agent — 소상공인 매출/매입 불일치 탐지 + 세금계산서 발행 에이전트

## Context

`NAVER_AIchallenge_hub` 리포지토리(NAVER AI Challenge 부트캠프 개인 프로젝트 — 공식 대회 규정 없음, PR 매일 제출·3주차 데모데이 등 코호트 운영 규칙만 존재)에는 "tax-agent" 데모(`src/App.jsx`)가 이미 만들어져 있다. 세금계산서 발행 과정을 감열지 영수증 스타일로 재생하는 완전 스크립트/목업 UI다.

이 대화에서 방향이 두 번 바뀌었다:
1. 처음엔 "세금계산서 발행"을 홈택스 Playwright RPA로 자동화하되, 모바일 2차인증 때문에 완전자동화는 불가능하다고 판단해 "사람 승인 단계 포함 RPA"로 설계했었다.
2. 사용자가 "완전자동화가 정말 안 되는지" 다시 확인해달라고 요청 → 리서치 결과 **공동인증서 로그인(간편인증과 달리 인증서 파일+비밀번호만 필요, 모바일 탭 불필요)을 쓰면 진짜 완전자동화(사람 개입 0회)가 가능**하다는 걸 확인. 또한 사용자가 "ASP사(팝빌 등)에 건당 수수료 내는 건 사실상 외주 아니냐"고 문제를 제기해, ASP 없이 직접 Playwright+공동인증서로 홈택스와 상호작용하는 방향으로 확정.
3. 리서치 중 "세금계산서 발행"보다 소상공인이 실제로 더 아파하는 지점을 발견 — 2025년부터 국세청 AI가 매출/매입 불일치를 실시간으로 잡아내고, 실수로 누락된 매출도 최대 40% 가산세로 이어지는 사례가 흔하다. 이건 **읽기 전용**이라 법적 리스크도 낮다. 사용자가 이를 프로젝트의 **핵심(1순위) 시나리오**로 확정했고, 세금계산서 발행은 2순위로 격하됐다(단, 발행 직전 사람 확인 버튼은 안전을 위해 유지하기로 결정).
4. `src/App.jsx`의 현재 UI는 **가짜(throwaway) 데모**이며, 사용자는 백엔드/에이전트 기능을 먼저 완성한 뒤 프론트엔드를 처음부터 다시 만들 계획이다. 따라서 이 계획은 **백엔드·에이전트 기능 구현에 집중**하고, 기존 UI를 확장/재사용하는 작업은 범위에서 제외한다. 기능 검증은 API 레벨(스크립트/curl/테스트)로 하고, 프론트엔드 재구축은 이 계획 이후 별도로 진행한다.

## 확정된 사항 정리

- **핵심 시나리오(1순위)**: 매출/매입 자동수집 + 국세청 신고내역 대 내 장부 불일치 탐지 — 완전자동화(사람 개입 0회), 읽기 전용
- **보조 시나리오(2순위)**: 세금계산서 발행 — 기존 데모 시나리오 유지, Playwright+공동인증서로 기술적으로는 완전자동화 가능하지만 **발행 직전 사람 확인 버튼은 안전을 위해 의도적으로 유지**
- **홈택스 연동 방식**: ASP사(팝빌/코드에프) 사용 안 함. 공동인증서(간편인증 아님)로 직접 Playwright RPA — 인증서는 사업자가 미리 1회 발급받아 두는 것(에이전트 업무 아님)
- **LLM**: Claude/OpenAI 중 택 (provider-agnostic 추상화)
- **백엔드**: Node.js + Express + TypeScript
- **알려진 수용 리스크**: 홈택스 약관상 자동화 접근 제한 가능성(본인 계정으로 본인 업무 수행이라 무단 스크래핑 판례와는 성격이 다름), UI 변경 시 셀렉터 깨짐(ASP 미사용의 대가), 홈택스에 샌드박스가 없어 실제 발행은 되돌릴 수 없는 법적 문서

## 설계 원칙 → 구체적 장치

| 가치 | 장치 |
|---|---|
| 통제 가능 | 모든 쓰기 액션(홈택스 발행)은 사람의 명시적 확인 클릭 필요. `MOCK_HOMETAX`는 기본값 mock(실제 사이트 접근은 명시적 opt-out). 매칭/공제판단 로직은 LLM이 아닌 순수 TypeScript 결정론적 코드 |
| 이해 가능 | 모든 에이전트 동작이 기존 `DemoLine`의 "tool" 라인처럼 화면에 보임. `hometax_audit_log`에 모든 실제 자동화 액션 기록. ORM 없이 순수 SQL 스키마 |
| 하드코딩 아님 | LLM이 자연어 설명·모호한 케이스 판단(영수증 이미지 분류, 애매한 fuzzy match 주석)은 실제로 수행하되, **결정론적 로직이 만든 finding을 LLM이 임의로 무시/은폐할 수는 없음** — 매칭은 코드가 찾고, LLM은 설명만 |

## 1순위: 매출/매입 자동수집 + 불일치 탐지

### 데이터 모델 (SQLite, `better-sqlite3`, 순수 `schema.sql`)

- `businesses` — 사장님 사업자 정보(사업자번호/상호/과세유형)
- `hometax_sales` / `hometax_purchases` — 홈택스에서 수집한 신고내역 (source_type: tax_invoice/cash_receipt/card, doc_no로 재수집 시 upsert)
- `ledger_entries` — 사장님 본인 장부 (direction, receipt_type: 세금계산서/카드전표/현금영수증/간이영수증/무증빙, source: manual/csv/photo)
- `reconciliation_runs` / `reconciliation_findings` — 점검 실행 기록과 발견된 불일치(finding_type: unmatched_nts_side/unmatched_ledger_side/amount_mismatch/non_deductible, severity, llm_explanation)
- `hometax_audit_log` — 실제 홈택스 액션 기록 (비밀번호는 절대 기록 안 함)

### 수집 (읽기 경로)

`HometaxClient` 인터페이스(`login/fetchSalesTaxInvoices/fetchPurchaseTaxInvoices/fetchCashReceipts/fetchCardPurchases/close`)를 두 가지로 구현:
- **`PlaywrightHometaxClient`**: 공동인증서(파일 경로+비밀번호, env로만 전달, 로그 금지)로 로그인 → 조회 화면에서 **홈택스 자체 "엑셀다운로드" 버튼을 클릭해 파일로 받은 뒤**(`page.waitForEvent('download')`) `xlsx`/`exceljs`로 파싱 — DOM 스크래핑보다 UI 변경에 강함
- **`MockHometaxClient`**: 픽스처 JSON (기존 데모의 87만원 시나리오 1개 + 불일치 시나리오 2개 포함)
- `MOCK_HOMETAX !== 'false'`일 때 기본 mock — 실사이트 접근은 명시적 opt-out

정확한 홈택스 메뉴 경로/셀렉터는 실제 계정 없이는 확정 불가 → **3일차를 "스파이크" PR로 배정**해 실제 확인 후 `docs/playwright-hometax-notes.md`에 기록 (추측으로 설계하지 않음).

### 내 장부 쪽 데이터 (공식 API 없음 — 3단계 입력 방식)

난이도 순으로 4일차→10일차→11일차에 순차 구현, 항상 "지금 되는 것"이 있도록:
1. **수동 입력 폼** — 날짜/거래처/금액/증빙유형
2. **CSV 임포트** — 카드사/은행 명세서 (`csv-parse`)
3. **영수증 사진 → 멀티모달 LLM 파싱** — 이미지 업로드 → 비전 지원 LLM이 `{date, merchant, amount, receiptType}` 추출 → `zod` 스키마 검증 → 사용자가 확인/수정 후 저장. 기존 데모가 홍보만 하던 "비정형 문서 이해" 칩을 실제로 구현하는 지점

### 결정론적 매칭 엔진 (`server/src/services/reconciliation/matcher.ts`)

- **정확 매칭**: 날짜 동일, 금액 오차 허용(₩0~1,000), 거래처는 사업자번호 우선, 없으면 정규화된 이름
- **퍼지 매칭**: 날짜 ±N일(카드 정산 지연 흡수), 금액 % 허용오차, 거래처명 유사도(문자열 유사도 라이브러리)
- **미매칭**: 국세청 자료엔 있는데 내 장부에 없음 → `unmatched_nts_side`, **고위험**(누락매출 리스크, 최대 40% 가산세와 직결); 내 장부엔 있는데 국세청 자료에 없음 → `unmatched_ledger_side`, 저위험
- **불공제 판단 규칙표**(`nonDeductibleRules.ts`): 간이영수증 임계값 초과, 거래처가 간이과세자면 무조건 불공제(기존 데모의 판단 로직과 동일 규칙), 접대비/개인차량 등 플래그 카테고리 — **이 규칙표를 세금계산서 발행 기능의 `judge_vat_input_credit`과 공유** (재사용 포인트)

LLM은 이 결과를 자연어 요약("이번 달 매출 3건이 국세청 신고 내역과 불일치해요…")하고 애매한 퍼지매칭에 대한 보조 판단만 추가 — finding을 지우거나 숨길 수 없음.

### 스케줄링 + 스트리밍

`node-cron`(정기 실행)과 `POST /api/reconciliation/run`("지금 점검" 버튼, 데모 당일엔 이쪽을 씀) 둘 다 동일한 `runReconciliationCheck()`를 호출. 백그라운드 실행은 HTTP 요청과 무관하게 시작되므로, `RunEventBus`(run_id별 이벤트 버퍼 + EventEmitter)를 두어 `GET /api/reconciliation/runs/:id/stream`이 구독 시 버퍼된 이벤트부터 재생 후 라이브로 전환 — 크론으로 이미 시작된 실행에도 붙거나, 끝난 실행도 재생 가능. SSE로 충분(WebSocket 불필요).

### UI — 이번 계획 범위 밖 (프론트엔드는 나중에 재제작)

`src/App.jsx`는 가짜 데모이며 사용자가 기능 완성 후 새로 만들 예정이므로, 이 계획에서는 UI를 만들거나 기존 UI를 확장하지 않는다. 검증은 API 레벨로 한다: `GET/POST` 라우트를 curl/Postman/간단한 스크립트로 직접 호출해 `reconciliation_findings`, SSE 이벤트 스트림 등을 확인한다. 다만 **SSE 이벤트 스키마와 findings 데이터 구조는 나중에 프론트가 그대로 소비할 수 있도록 명확하고 안정적으로 설계**한다(이벤트 타입, finding 필드 등 문서화 — `docs/api-events.md`).

## 2순위: 세금계산서 발행 (기존 데모 재사용, 인프라 공유)

- `STEPS` 재생 → 실제 tool-calling 에이전트 루프(SSE)로 전환
- 도구: `lookup_business_partner`(data.go.kr 사업자등록정보 API — 1순위 기능과 공유), `lookup_recent_purchase_history`(이제 1순위 기능이 채운 실제 `ledger_entries`/`hometax_purchases` 테이블 조회 — 가짜 데이터 아님), `judge_vat_input_credit`(1순위와 동일 규칙표 공유), `draft_tax_invoice`(결정론적 금액 계산, 870,000→790,909/79,091 픽스처로 테스트)
- **확인 게이트**: 발행 직전 "확인" 액션(API 레벨의 별도 엔드포인트 호출)이 있어야만 실제 제출 실행. **로그인 승인 대기 단계는 없음**(공동인증서는 무인 로그인이므로 이전 설계의 "모바일 승인 대기"는 폐기)
- 기존 `STEPS` 스크립트(현재 `App.jsx`에 하드코딩된 데모 문구/수치)는 나중에 만들 프론트가 참고할 수 있도록 `server/src/services/invoice/demoScriptFixture.ts`에 데이터로 보존 — UI 코드는 만들지 않되, 시나리오 재현에 필요한 문구/수치 픽스처는 백엔드 테스트 자산으로 남긴다

## 공유 홈택스 자동화 모듈

`server/src/services/hometax/`: `HometaxClient.ts`(인터페이스), `PlaywrightHometaxClient.ts`, `MockHometaxClient.ts`(읽기+쓰기 모두 모킹, 가짜 발행은 지연 후 가짜 접수번호 반환), `index.ts`(mock 기본 팩토리). 인증서 경로/비밀번호는 `.env`(`HOMETAX_CERT_PATH`/`HOMETAX_CERT_PASSWORD`)로만, 로그에 절대 노출 금지. 모든 실제 액션은 `hometax_audit_log`에 기록. 실제 발행은 CI에서 절대 실행 안 함, 수동으로 드물게만.

## 아키텍처 요약

- **프론트**: 이번 계획 범위 밖. 기존 `src/App.jsx`는 손대지 않고 그대로 둔다(가짜 데모, 나중에 별도로 재작성 예정)
- **백엔드**: 신규 `server/` (Express+TS), API 전용으로 독립 실행 (프론트 연동은 나중 단계)
- **DB**: SQLite(`better-sqlite3`), 순수 `schema.sql`
- **LLM**: provider-agnostic (`llmClient` 인터페이스, Anthropic/OpenAI 구현체, `LLM_PROVIDER` env) — 점검 요약/모호 케이스 판단, 발행 에이전트 루프, 영수증 이미지 파싱 3곳에서 재사용
- **스케줄러**: Express 프로세스 내 `node-cron` (외부 큐 불필요, 개인 데모 규모에 적합)
- **스트리밍**: SSE 전 구간. 발행(요청 기반)과 점검(작업 기반, RunEventBus로 디커플링) 두 가지 패턴

## 파일 구조 (신규/수정 — 전부 백엔드, 기존 `src/`는 손대지 않음)

```
NAVER_AIchallenge_hub/
  src/                                (기존 가짜 데모, 이번 계획에서 미수정)
  server/
    package.json, tsconfig.json, .env.example
    src/index.ts, src/env.ts
    src/db/schema.sql, client.ts, migrate.ts
    src/llm/llmClient.ts, anthropicClient.ts, openAiClient.ts, index.ts
    src/services/hometax/HometaxClient.ts, PlaywrightHometaxClient.ts, MockHometaxClient.ts, index.ts, fixtures/*.json
    src/services/reconciliation/matcher.ts, nonDeductibleRules.ts, runReconciliationCheck.ts, RunEventBus.ts
    src/services/invoice/tools.ts, agentLoop.ts, demoScriptFixture.ts
    src/services/businessLookup/dataGoKrClient.ts
    src/services/ledger/ledgerService.ts, receiptVision.ts
    src/routes/reconciliationRoutes.ts, chatRoutes.ts, ledgerRoutes.ts
    src/scheduler/cronJobs.ts
    test/matcher.test.ts, nonDeductibleRules.test.ts, dataGoKrClient.test.ts, draftTaxInvoice.test.ts
    scripts/hometax-smoke.ts          (실제 홈택스 수동 검증용)
  docs/playwright-hometax-notes.md, docs/e2e-walkthrough.md, docs/api-events.md
```

`vite.config.js`/`src/App.jsx` 등 프론트엔드 관련 파일은 이번 계획에서 수정하지 않는다.

## 마일스톤 (PR-매일, 3주, 리스크 앞당기기)

(전부 백엔드/API 작업 — 프론트엔드는 이번 계획 범위 밖)

| Day | 범위 | 이유 |
|---|---|---|
| 1 | Express+TS 스캐폴드, SQLite 스키마, 헬스체크 | 기반 |
| 2 | `HometaxClient` 인터페이스 + Mock + 픽스처 + `.env.example` | 실사이트 건드리기 전 계약부터 확정 |
| 3 | **스파이크**: 실제 공동인증서 로그인 + 조회 화면 1개(다운로드 방식), headed 모드, 문서화 | 최고위험 항목을 일찍, 격리해서 |
| 4 | 수동 장부 입력 API end-to-end | 두 번째 위험(내 장부 데이터) 조기 해소 |
| 5 | `matcher.ts` + `nonDeductibleRules.ts` + 단위테스트 | 핵심 결정론적 로직 |
| 6 | `runReconciliationCheck` + `RunEventBus` + SSE 라우트 + 수동 트리거(curl/스크립트로 검증) | 2~5 연결 |
| 7 | LLM 추상화 + 자연어 요약 | "비하드코딩" 레이어 추가 |
| 8 | `docs/api-events.md`(SSE 이벤트/finding 스키마 문서화, 나중 프론트가 그대로 소비할 수 있게) + 에러 처리·재시도·재수집 멱등성 하드닝 | 프론트 없이도 API 계약을 안정화 |
| 9 | CSV 장부 임포트 + `node-cron` 스케줄 잡 | 두 번째 입력모드 + "무인" 서사 |
| 10 | 영수증 사진 멀티모달 파싱 | 가장 화려한 모드는 마지막 |
| 11 | 발행 에이전트 tool-calling 루프(실제 조회 도구들, 공유 규칙표, 초안 조립 + 테스트) | 2순위 기능, 1순위 인프라 재사용 |
| 12 | 홈택스 쓰기 경로(mock+실제 스파이크) + 확인게이트 API + 감사로그 | 가장 위험한 쓰기 액션, 격리 |
| 13 | `docs/e2e-walkthrough.md`를 실행 가능한 스크립트로 작성(픽스처 시딩→점검 실행→findings 검증→발행 시나리오→확인게이트) | API 레벨 전체 회귀 테스트 |
| 14~15 | 버퍼: 백엔드 폴리싱, 남는 시간은 프론트엔드 재구축 착수 전 API 계약 최종 점검 | 프론트 재작업은 이 계획 이후 별도 진행 |

3일차 스파이크가 잘 안 되더라도 2일차부터의 "mock 우선" 계약 덕분에 이후 모든 날짜가 `MOCK_HOMETAX=true`로 계속 진행 가능 — 실제 자동화 리스크는 3일차·12일차에만 격리됨.

## 검증 방법

- **단위테스트(Vitest)**: `matcher.test.ts`(정확매칭/퍼지매칭/과대오차 불일치/미매칭 고·저위험/중복 재수집 멱등성), `nonDeductibleRules.test.ts`(간이영수증 임계값, 간이과세자 거래처, 플래그 카테고리, 정상 공제 케이스), `draftTaxInvoice.test.ts`(870,000→790,909/79,091 고정)
- **통합**: `dataGoKrClient.test.ts` mocked HTTP(일반/간이/폐업/malformed)
- **Playwright/홈택스**: CI는 항상 `MOCK_HOMETAX=true` 강제(샌드박스 없으므로), 실제 검증은 `scripts/hometax-smoke.ts`로 수동·headed 모드만, 실제 발행은 극히 드물게 수동으로만
- **최종 API 레벨 워크스루**(`docs/e2e-walkthrough.md`, 실행 가능한 스크립트): 매칭/불일치/불공제 픽스처 시딩 → `POST /api/reconciliation/run` 호출 → SSE 스트림으로 findings/심각도/LLM요약 확인 → `GET /api/reconciliation/runs` 과거 목록 확인 → 발행 시나리오 API 호출 → 확인게이트가 실제로 제출을 막았다가 승인 후에만 통과하는지 확인 → 기존 데모와 동일한 발행 수치(790,909/79,091/870,000) 확인. 이 스크립트는 나중에 프론트엔드를 붙일 때 API 계약이 깨지지 않았는지 재검증하는 회귀 테스트로도 재사용한다.
