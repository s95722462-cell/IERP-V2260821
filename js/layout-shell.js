// ══════════════════════════════════════════════════════════════
// layout-shell.js — 좌측 사이드바 골격 · 회사 전환 탭 · 동기화 상태 표시
// iERP 2.0 / 4단계 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.css(동봉)
//
// 설계 원칙:
//   - "레고 블록"처럼, 메뉴 목록만 넘겨주면 사이드바/상단바/화면
//     전환까지 이 모듈이 알아서 DOM에 그려 넣는다. index.html에
//     사이드바 마크업을 직접 손으로 쓸 필요가 없다.
//   - 로그인 화면 ↔ 메인 화면 전환은 auth.js의 onAuthReady()에 걸어서
//     처리한다. 확인이 끝나기 전에는 로딩 스플래시만 보여주고,
//     로그인 화면이 잠깐 번쩍이는 일이 없게 한다. (1.0에서 사용자가
//     불편하다고 지적했던 부분 — 처음부터 반영)
//   - 회사 전환 탭은 헤더 배경색(다크/라이트)이 무엇이든 항상 대비되게
//     칠한다 (color-mix로 전경색 기준 혼합). (1.0에서 라이트 테마일 때
//     탭 글씨가 안 보이던 버그를 겪은 뒤 반영한 방식)
// ══════════════════════════════════════════════════════════════

const LayoutShell = (() => {
  let menuItems = [];      // [{ id, label, icon }]
  let onNavigateCb = null;
  let onCompanySwitchCb = null;
  let onLogoutCb = null;
  let currentPanelId = null;

  /**
   * 사이드바/상단바/로그인 화면/메인 화면 골격을 만들고 문서에 삽입합니다.
   * main.js에서 db.js, auth.js 초기화 이후 한 번 호출합니다.
   *
   * @param {object} opts
   * @param {string} opts.appName
   * @param {{id:string, label:string, icon:string}[]} opts.menuItems
   * @param {(panelId:string) => void} opts.onNavigate - 메뉴를 눌렀을 때
   * @param {(companyIdx:number) => void} opts.onCompanySwitch - 회사 탭을 눌렀을 때
   * @param {() => void} opts.onLogout
   * @param {() => void} [opts.onLoginSubmit] - 로그인 폼 제출 시 (id/pw 값은 이 모듈이 읽어서 넘겨줌)
   */
  function init(opts) {
    // 저장된 다크모드 설정을 제일 먼저 적용한다 (예전엔 저장만 되고
    // 새로고침 시 불러오는 코드가 없어서 매번 라이트모드로 돌아가던
    // 문제가 있었음 — layout-shell.js가 화면 골격을 그리기 전에
    // 여기서 바로잡는다).
    applyTheme(getSavedTheme());

    menuItems = opts.menuItems;
    onNavigateCb = opts.onNavigate;
    onCompanySwitchCb = opts.onCompanySwitch;
    onLogoutCb = opts.onLogout;

    renderShellDom();
    bindStaticEvents(opts);

    DbEngine.onStatusChange(updateSyncStatus);

    onAuthReady(() => {
      document.getElementById('ls-boot').style.display = 'none';
      const { currentUser } = getAuthState();
      if (currentUser) showMainApp();
      else showLoginScreen();
    });
  }

  function renderShellDom() {
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="ls-boot" class="ls-boot">
        <div class="ls-spinner"></div>
        <div class="ls-boot-label">불러오는 중...</div>
      </div>

      <div id="ls-login" class="ls-login" style="display:none">
        <div class="ls-login-box">
          <h1 id="ls-login-title">iERP</h1>
          <input id="ls-login-id" placeholder="아이디" autocomplete="username">
          <input id="ls-login-pw" type="password" placeholder="비밀번호" autocomplete="current-password">
          <label class="ls-chk"><input type="checkbox" id="ls-login-keep"> 로그인 상태 유지</label>
          <button id="ls-login-btn" class="ls-btn-primary">로그인</button>
          <div id="ls-login-err" class="ls-err"></div>
        </div>
      </div>

      <div id="ls-app" class="ls-app" style="display:none">
        <aside class="ls-sidebar">
          <div class="ls-logo" id="ls-logo">iERP</div>
          <nav class="ls-menu" id="ls-menu"></nav>
          <button class="ls-logout" id="ls-logout-btn">로그아웃</button>
        </aside>
        <div class="ls-main">
          <div class="ls-topbar">
            <div class="ls-company-tabs" id="ls-company-tabs"></div>
            <div class="ls-topbar-right">
              <button class="ls-theme-toggle" id="ls-theme-toggle" title="다크모드 전환"></button>
              <span class="ls-sync"><span class="ls-sync-dot" id="ls-sync-dot"></span><span id="ls-sync-label">연결 중...</span></span>
            </div>
          </div>
          <div class="ls-content" id="ls-content"></div>
        </div>
      </div>
    `);

    const menuEl = document.getElementById('ls-menu');
    menuEl.innerHTML = menuItems.map((m) => `
      <button class="ls-menu-item" data-panel="${m.id}">
        <span class="ls-menu-icon">${m.icon || ''}</span><span class="ls-menu-label">${escapeHtml(m.label)}</span>
      </button>
    `).join('');
    menuEl.querySelectorAll('.ls-menu-item').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.getAttribute('data-panel')));
    });
  }

  function bindStaticEvents(opts) {
    renderThemeToggleIcon();
    document.getElementById('ls-theme-toggle').addEventListener('click', () => {
      const next = getSavedTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      renderThemeToggleIcon();
    });

    document.getElementById('ls-logout-btn').addEventListener('click', () => {
      if (onLogoutCb) onLogoutCb();
    });
    document.getElementById('ls-login-btn').addEventListener('click', () => {
      if (opts.onLoginSubmit) {
        opts.onLoginSubmit({
          username: document.getElementById('ls-login-id').value,
          password: document.getElementById('ls-login-pw').value,
          keepLoggedIn: document.getElementById('ls-login-keep').checked
        });
      }
    });
  }

  /** 화면 전환: 사이드바 메뉴 클릭 시 해당 패널만 보이게 하고, 콜백을 호출합니다. */
  function navigate(panelId) {
    currentPanelId = panelId;
    document.querySelectorAll('.ls-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.ls-menu-item').forEach((m) => m.classList.remove('active'));
    const panel = document.getElementById('panel-' + panelId);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector(`.ls-menu-item[data-panel="${panelId}"]`);
    if (btn) btn.classList.add('active');
    if (onNavigateCb) onNavigateCb(panelId);
  }

  /** 각 화면 모듈이 자신의 콘텐츠 패널을 등록할 때 사용하는 마운트 지점을 돌려줍니다. */
  function registerPanel(panelId) {
    const wrap = document.createElement('div');
    wrap.className = 'ls-panel';
    wrap.id = 'panel-' + panelId;
    document.getElementById('ls-content').appendChild(wrap);
    return wrap;
  }

  function showMainApp() {
    document.getElementById('ls-login').style.display = 'none';
    document.getElementById('ls-app').style.display = 'flex';
    if (!currentPanelId && menuItems[0]) navigate(menuItems[0].id);
  }

  function showLoginScreen() {
    document.getElementById('ls-app').style.display = 'none';
    document.getElementById('ls-login').style.display = 'flex';
  }

  function setLoginError(message) {
    document.getElementById('ls-login-err').textContent = message || '';
  }

  /**
   * 회사 전환 탭을 그립니다. 헤더 배경이 어떤 테마든 항상 대비되도록
   * layout-shell.css의 color-mix 기반 스타일을 사용합니다.
   * @param {{id:string, company:string}[]} companies
   * @param {number} activeIdx
   */
  function renderCompanyTabs(companies, activeIdx) {
    const wrap = document.getElementById('ls-company-tabs');
    wrap.innerHTML = companies.map((c, i) => `
      <button type="button" class="ls-co-tab${i === activeIdx ? ' active' : ''}" data-idx="${i}" title="${escapeHtml(c.company || '회사' + (i + 1))}">
        ${escapeHtml(c.company || '회사' + (i + 1))}
      </button>
    `).join('');
    wrap.querySelectorAll('.ls-co-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (onCompanySwitchCb) onCompanySwitchCb(parseInt(btn.getAttribute('data-idx'), 10));
      });
    });
  }

  /** 상단바 다크모드 토글 버튼의 아이콘을 현재 테마에 맞게 그린다. */
  function renderThemeToggleIcon() {
    const btn = document.getElementById('ls-theme-toggle');
    if (!btn) return;
    btn.textContent = getSavedTheme() === 'dark' ? '☀️' : '🌙';
  }

  function updateSyncStatus(status) {
    const dot = document.getElementById('ls-sync-dot');
    const label = document.getElementById('ls-sync-label');
    if (!dot || !label) return;
    if (status === 'synced') {
      dot.classList.remove('off');
      label.textContent = '실시간 동기화 중';
    } else if (status === 'offline') {
      dot.classList.add('off');
      label.textContent = '오프라인';
    } else {
      dot.classList.remove('off');
      label.textContent = '연결 중...';
    }
  }

  return {
    init, navigate, registerPanel, showMainApp, showLoginScreen,
    setLoginError, renderCompanyTabs, updateSyncStatus, renderThemeToggleIcon
  };
})();

window.LayoutShell = LayoutShell;
