# iERP 2.0

브라우저에서 동작하는 소규모 무역·유통업용 ERP입니다. 빌드 과정 없이 정적 파일(HTML/CSS/JS)만으로 동작하고, 데이터는 Firebase(Firestore + Auth)에 저장합니다.

- 거래처 · 품목 · 매출 · 매입 · 재고현황 · 일별현황 · 대시보드
- 매출원가는 **FIFO**(선입선출)로 계산
- 거래명세서 인쇄(PDF 저장), 엑셀 업로드/다운로드, JSON 백업/복원
- 한 계정에서 회사 최대 5개 관리

## 폴더 구조

```
index.html            진입점 — 스크립트 로딩 순서가 중요함 (main.js 상단 주석 참고)
*.css                 화면 스타일 (JS 모듈과 짝을 이룸)
firestore.rules       Firestore 보안 규칙 — auth.js와 함께 게시해야 함
js/
  security.js         escapeHtml · rawNum · fmtNum 등 공통 함수 (제일 먼저 로드)
  db.js               Firestore 연결, CRUD, batchWrite, 실시간 리스너(DbEngine)
  auth.js             로그인 · 자동 로그인 복원
  fifo.js             FIFO 매출원가 엔진 (소진 / 반품 복귀 / 되돌리기 / 재계산)
  layout-shell.js     사이드바 · 상단바 · 화면 전환
  table-engine.js     목록 표 (검색 · 기간 · 정렬 · 칼럼 설정 · 선택 삭제)
  customers.js / products.js / sales.js / purchase.js   데이터 화면
  stock.js / daily.js / dashboard.js                    조회 화면 (자체 데이터 없음)
  settings.js / invoice.js / data-import.js / excel-io.js
  main.js             전체 초기화 (제일 마지막에 로드)
e2e/                  Playwright E2E 테스트 (실제 Firebase를 쓰지 않음)
```

데이터 경로: `users/{safeId}/companies/{companyId}/{customers|products|sales|purchases|counters}/{id}`

## 배포할 때 체크리스트

1. **캐시 버전 올리기** — `index.html`의 모든 `?v=YYYYMMDDNNNN`을 새 값으로 바꿉니다. 안 바꾸면 사용자 브라우저가 예전 JS를 계속 씁니다.
2. **보안 규칙** — `firestore.rules`를 바꿨다면 Firebase 콘솔(또는 `firebase deploy --only firestore:rules`)로 함께 게시합니다.
3. **CDN 라이브러리 버전을 올릴 때** — `index.html`의 `integrity` 해시도 새로 계산해야 합니다. 안 맞으면 브라우저가 스크립트를 차단해 앱이 멈춥니다.
   ```sh
   curl -s <스크립트 URL> | openssl dgst -sha384 -binary | openssl base64 -A
   ```
   E2E의 "SRI 해시가 실제 CDN 파일과 일치" 테스트가 이걸 자동으로 확인합니다.
4. `main`에 올리기 전에 E2E가 통과하는지 확인합니다 (PR을 만들면 GitHub Actions가 자동 실행).

## E2E 테스트

```sh
cd e2e
npm install
npx playwright install chromium   # 처음 한 번
npx playwright test
```

- 앱 파일을 디스크에서 바로 서빙하고, Firebase SDK는 `e2e/mock-firebase.js`(메모리 DB)로 바꿔치기합니다.
- 실제 Firebase/Google 주소로 나가는 요청은 전부 차단·집계되며, **1건이라도 있으면 테스트가 실패**합니다 — 운영 데이터는 절대 건드리지 않습니다.

## FIFO 매출원가 정책

- 매출을 저장하는 순간, 남아 있는 매입 뱃치(+초기재고)를 오래된 순으로 소진해 원가를 계산하고 저장합니다.
- **매출 수정·삭제**: 그 매출이 소진했던 뱃치를 먼저 되돌린 뒤 다시 계산합니다.
- **반품(매출취소)**: 가장 최근에 출고된 뱃치로, 나갈 때의 원가 그대로 재고에 되돌립니다(매출원가는 마이너스).
- **매입 저장·수정·삭제**: 해당 품목의 FIFO를 자동으로 다시 계산합니다(값이 달라진 문서만 저장).
- 재고현황의 **"FIFO 재계산"** 버튼으로 품목별로 처음부터 다시 계산할 수 있습니다.

## 운영 권장 사항 (코드 밖에서 해야 하는 일)

- **서버 자동 백업**: Firestore 예약 내보내기(Cloud Storage) 또는 PITR(특정 시점 복구)을 켜 두세요. 둘 다 Blaze(종량제) 요금제가 필요합니다. 앱의 JSON 백업은 수동이라 보조 수단입니다.
- **API 키 제한**: Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보에서 이 웹 API 키의 "애플리케이션 제한사항"을 **HTTP 리퍼러(배포 도메인)**로 제한하세요. 가능하면 Firebase App Check도 켜세요.
