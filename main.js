// ══════════════════════════════════════════════════════════════
// main.js — 전체 초기화 (제일 마지막에 로드)
// iERP 2.0
//
// 로딩 순서 규칙 (index.html에 그대로 반영되어야 함):
//   security.js → db.js → auth.js → layout-shell.js → table-engine.js
//   → customers.js → products.js → sales.js → purchase.js → stock.js
//   → daily.js → dashboard.js → settings.js → invoice.js → main.js
//
// 설계 원칙 (1.0에서 배운 가장 중요한 교훈):
//   리스너 연결(각 화면의 startListening())은, 그 뒤에 오는 다른 초기화
//   코드가 예외를 던지더라도 이미 끝나 있어야 한다. 그래서 아래
//   startAllListeners()를 제일 먼저 실행하고, 그 다음에 화면을 그린다.
//   (1.0에서 정의되지 않은 함수 호출 때문에 로그인 후처리 코드가 중간에
//   멈추면서, 리스너 연결 자체가 실행되지 않았던 사고가 있었다 — 이
//   순서를 지키면 그런 사고가 나도 최소한 데이터 연결은 살아있다.)
// ══════════════════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAQgNQ4kCEFtGiP1JZVs_S5hrrvmGxWbkc',
  authDomain: 'ierpv2.firebaseapp.com',
  projectId: 'ierpv2',
  storageBucket: 'ierpv2.firebasestorage.app',
  messagingSenderId: '945479692801',
  appId: '1:945479692801:web:ebeeb989d5975b1f9c4600'
  // measurementId(Analytics)는 iERP에서 안 쓰므로 제외 — Firestore/Auth에는 필요 없음
};

const MENU_ITEMS = [
  { id: 'dashboard', label: '대시보드', icon: '📊' },
  { id: 'daily', label: '일별현황', icon: '📅' },
  { id: 'sales', label: '매출장부', icon: '📈' },
  { id: 'purchase', label: '매입장부', icon: '📥' },
  { id: 'stock', label: '재고현황', icon: '📦' },
  { id: 'customers', label: '거래처', icon: '🏢' },
  { id: 'products', label: '품목', icon: '🔧' },
  { id: 'settings', label: '설정', icon: '⚙️' }
];

const ALL_MODULES = [
  CustomersModule, ProductsModule, SalesModule, PurchaseModule,
  StockModule, DailyModule, DashboardModule, SettingsModule
];

function initApp() {
  initFirebaseDb(FIREBASE_CONFIG);
  initAuth();

  LayoutShell.init({
    appName: 'iERP',
    menuItems: MENU_ITEMS,
    onNavigate: () => { /* 필요 시 화면별 후처리 */ },
    onCompanySwitch: async (idx) => {
      activeCoIdx = idx;
      await saveUserMeta();
      LayoutShell.renderCompanyTabs(companies, activeCoIdx);
      restartAllListeners();
    },
    onLogout: async () => {
      await doLogout();
      LayoutShell.showLoginScreen();
    },
    onLoginSubmit: async ({ username, password, keepLoggedIn }) => {
      LayoutShell.setLoginError('');
      try {
        await doLogin({ username, password, keepLoggedIn });
        afterLoginSuccess();
      } catch (e) {
        LayoutShell.setLoginError(e.message);
      }
    },
    onRegisterSubmit: async ({ username, password, company }) => {
      LayoutShell.setRegisterError('');
      try {
        await doRegister({ username, password, company });
        afterLoginSuccess();
      } catch (e) {
        LayoutShell.setRegisterError(e.message);
      }
    }
  });

  // 각 화면의 DOM/이벤트를 먼저 전부 그려 넣는다 (아직 데이터 연결 전)
  ALL_MODULES.forEach((m) => m.init());

  // 로그인 상태 확인이 끝난 뒤, 이미 로그인되어 있었다면(새로고침 복원) 바로 이어서 시작
  onAuthReady(() => {
    const { currentUser } = getAuthState();
    if (currentUser) afterLoginSuccess();
  });
}

/**
 * 로그인 성공 직후(수동 로그인이든, 새로고침 자동 복원이든) 공통으로 실행.
 * 리스너 연결을 제일 먼저 한다 — 그 아래 코드에서 예외가 나도 데이터
 * 연결은 이미 되어 있게 하기 위함.
 */
function afterLoginSuccess() {
  restartAllListeners();
  LayoutShell.showMainApp();
  LayoutShell.renderCompanyTabs(companies, activeCoIdx);
  SettingsModule.renderCompanyList();

  DbEngine.startReconnectWatchdog(() => {
    restartAllListeners();
  });
}

/** 로그인 직후, 회사 전환 시 호출 — 모든 화면의 실시간 구독을 다시 건다. */
function restartAllListeners() {
  ALL_MODULES.forEach((m) => {
    if (typeof m.startListening === 'function') m.startListening();
  });
}

// 회사 전환/삭제 후 settings.js가 이 함수를 호출해 다시 연결하도록 되어 있음
window.onCompanySwitched = restartAllListeners;

document.addEventListener('DOMContentLoaded', initApp);
