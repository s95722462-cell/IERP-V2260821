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
  let lastCompanies = [];  // 회사 목록 마지막 값 (사이드바 "회사" 뷰가 나중에 열려도 다시 그릴 수 있도록 기억)
  let lastActiveIdx = 0;

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
    initSidePanelEnhancer();
    initToolbarSettingsMerge();

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
          <form id="ls-login-form">
            <input id="ls-login-id" placeholder="아이디" autocomplete="username">
            <input id="ls-login-pw" type="password" placeholder="비밀번호" autocomplete="current-password">
            <label class="ls-chk"><input type="checkbox" id="ls-login-keep"> 로그인 상태 유지</label>
            <button id="ls-login-btn" class="ls-btn-primary" type="submit">로그인</button>
          </form>
          <div id="ls-login-err" class="ls-err"></div>
        </div>
      </div>

      <div id="ls-app" class="ls-app" style="display:none">
        <aside class="ls-sidebar" id="ls-sidebar">
          <div class="ls-sidebar-top">
            <div class="ls-logo" id="ls-logo">iERP</div>
            <button class="ls-sidebar-toggle" id="ls-sidebar-toggle" title="사이드바 접기">«</button>
          </div>
          <div class="ls-nav-switch" id="ls-nav-switch">
            <button type="button" class="ls-nav-switch-btn active" data-view="home">홈</button>
            <button type="button" class="ls-nav-switch-btn" data-view="company">회사</button>
          </div>
          <nav class="ls-menu" id="ls-menu"></nav>
          <div class="ls-company-list" id="ls-company-list" style="display:none"></div>
          <button class="ls-logout" id="ls-logout-btn">
            <span class="ls-logout-icon">⎋</span><span class="ls-logout-label">로그아웃</span>
          </button>
          <div class="ls-sidebar-resize-handle" id="ls-sidebar-resize-handle"></div>
        </aside>
        <div class="ls-main">
          <div class="ls-topbar">
            <div class="ls-active-company" id="ls-company-tabs"></div>
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
      <button class="ls-menu-item" data-panel="${m.id}" title="${escapeHtml(m.label)}">
        <span class="ls-menu-label">${escapeHtml(m.label)}</span>
      </button>
    `).join('');
    menuEl.querySelectorAll('.ls-menu-item').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.getAttribute('data-panel')));
    });
  }

  function bindStaticEvents(opts) {
    renderThemeToggleIcon();

    // 사이드바 접기 상태 복원 (VS Code 스타일 — 아이콘만 남기고 접힘)
    applySidebarCollapsed(getSavedSidebarCollapsed());
    document.getElementById('ls-sidebar-toggle').addEventListener('click', () => {
      const sidebar = document.getElementById('ls-sidebar');
      applySidebarCollapsed(!sidebar.classList.contains('collapsed'));
    });
    initSidebarResize();

    // 사이드바 "홈"/"회사" 전환 토글: 홈은 기존 메뉴 목록, 회사는 회사
    // 목록(클릭해서 전환)을 보여준다. 상단바 회사 표시(단일 이름)와는
    // 별개로, 여기서는 목록 전체를 보고 고를 수 있게 한다.
    document.getElementById('ls-nav-switch').addEventListener('click', (e) => {
      const btn = e.target.closest('.ls-nav-switch-btn');
      if (!btn) return;
      setSidebarView(btn.getAttribute('data-view'));
    });
    document.getElementById('ls-company-list').addEventListener('click', (e) => {
      const item = e.target.closest('.ls-co-item');
      if (!item) return;
      if (onCompanySwitchCb) onCompanySwitchCb(parseInt(item.getAttribute('data-idx'), 10));
    });

    document.getElementById('ls-theme-toggle').addEventListener('click', () => {
      const next = getSavedTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      renderThemeToggleIcon();
    });

    document.getElementById('ls-logout-btn').addEventListener('click', () => {
      if (onLogoutCb) onLogoutCb();
    });
    document.getElementById('ls-login-form').addEventListener('submit', (e) => {
      e.preventDefault();
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
   * 상단바에 현재 사용 중인 회사명 1개만 표시합니다. 회사 전환은 왼쪽
   * 사이드바의 "회사" 뷰(setSidebarView('company'))에서 하고, 여기
   * 상단바는 더 이상 클릭 가능한 탭이 아니라 단순 표시 라벨입니다.
   * 사이드바 "회사" 뷰가 나중에 열려도 최신 목록을 보여줄 수 있도록
   * 회사 목록/활성 인덱스를 기억해뒀다가 그 목록도 함께 갱신합니다.
   * @param {{id:string, company:string}[]} companies
   * @param {number} activeIdx
   */
  function renderCompanyTabs(companies, activeIdx) {
    lastCompanies = companies;
    lastActiveIdx = activeIdx;

    const label = document.getElementById('ls-company-tabs');
    if (label) {
      const active = companies[activeIdx];
      label.textContent = active ? (active.company || '회사' + (activeIdx + 1)) : '';
    }

    // 사이드바 "회사" 뷰가 지금 보이는 중이면 목록도 최신 상태로 다시 그린다.
    const companyListEl = document.getElementById('ls-company-list');
    if (companyListEl && companyListEl.style.display !== 'none') renderSidebarCompanyList();
  }

  /** 상단바 다크모드 토글 버튼의 아이콘을 현재 테마에 맞게 그린다. */
  function renderThemeToggleIcon() {
    const btn = document.getElementById('ls-theme-toggle');
    if (!btn) return;
    btn.textContent = getSavedTheme() === 'dark' ? '라이트 모드' : '다크 모드';
  }

  /** 사이드바 왼쪽 목록 영역을 "홈"(모듈 메뉴) 또는 "회사"(회사 목록)로 전환한다. */
  function setSidebarView(view) {
    const menuEl = document.getElementById('ls-menu');
    const companyListEl = document.getElementById('ls-company-list');
    const switchWrap = document.getElementById('ls-nav-switch');
    if (!menuEl || !companyListEl || !switchWrap) return;
    const isCompany = view === 'company';
    menuEl.style.display = isCompany ? 'none' : '';
    companyListEl.style.display = isCompany ? '' : 'none';
    switchWrap.querySelectorAll('.ls-nav-switch-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });
    if (isCompany) renderSidebarCompanyList();
  }

  /** 사이드바 "회사" 뷰의 목록을 마지막으로 받은 회사 데이터로 다시 그린다. */
  function renderSidebarCompanyList() {
    const listEl = document.getElementById('ls-company-list');
    if (!listEl) return;
    listEl.innerHTML = lastCompanies.map((c, i) => `
      <button type="button" class="ls-co-item${i === lastActiveIdx ? ' active' : ''}" data-idx="${i}">
        ${escapeHtml(c.company || '회사' + (i + 1))}
      </button>
    `).join('');
  }

  /** 사이드바 접기 상태를 localStorage에서 읽는다. */
  function getSavedSidebarCollapsed() {
    return localStorage.getItem('ls-sidebar-collapsed') === '1';
  }

  /** 사이드바를 접거나 펼치고, 상태를 localStorage에 저장한다. */
  function applySidebarCollapsed(collapsed) {
    const sidebar = document.getElementById('ls-sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', collapsed);
    localStorage.setItem('ls-sidebar-collapsed', collapsed ? '1' : '0');
    const toggleBtn = document.getElementById('ls-sidebar-toggle');
    if (toggleBtn) toggleBtn.title = collapsed ? '사이드바 펼치기' : '사이드바 접기';
    // 접으면 드래그로 잡았던 인라인 너비(style.width)를 지워야 CSS의
    // .collapsed { width:56px } 규칙이 먹는다 (인라인 스타일이 클래스보다
    // 우선순위가 높아서, 지우지 않으면 예전에 드래그한 너비가 그대로 남는 버그가 있었음).
    // 펼치면 저장된 너비를 다시 적용한다 (모바일 하단 네비 레이아웃에는 적용하지 않음).
    if (collapsed) {
      sidebar.style.width = '';
      setSidebarView('home'); // 접힌 상태에서는 회사 목록을 보여줄 공간이 없으므로 홈으로 되돌린다
    } else if (window.innerWidth > 768) {
      const savedWidth = localStorage.getItem('ls-sidebar-width');
      if (savedWidth) sidebar.style.width = savedWidth + 'px';
    }
  }

  /** 사이드바 오른쪽 가장자리를 드래그해서 너비를 조절하는 기능. 접힌 상태에서는 동작하지 않는다. */
  function initSidebarResize() {
    const sidebar = document.getElementById('ls-sidebar');
    const handle = document.getElementById('ls-sidebar-resize-handle');
    if (!sidebar || !handle) return;

    // 저장된 너비 복원 (접힌 상태가 아니고, 데스크톱 폭일 때만)
    const savedWidth = localStorage.getItem('ls-sidebar-width');
    if (savedWidth && !sidebar.classList.contains('collapsed') && window.innerWidth > 768) {
      sidebar.style.width = savedWidth + 'px';
    }

    let dragging = false, startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', (e) => {
      if (sidebar.classList.contains('collapsed')) return; // 접힌 상태에선 리사이즈 금지
      dragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let newWidth = startWidth + (e.clientX - startX);
      newWidth = Math.max(140, Math.min(newWidth, 400));
      sidebar.style.width = newWidth + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      localStorage.setItem('ls-sidebar-width', Math.round(sidebar.getBoundingClientRect().width));
    });
  }

  // ────────────────────────────────────────────────────────────
  // 오른쪽 슬라이드 패널(.side-panel) 자동 강화
  //   products.js/customers.js/sales.js/purchase.js는 전혀 손대지
  //   않고, 이 모듈이 MutationObserver로 .side-panel-bg가 DOM에
  //   나타나는 순간을 감지해서 리사이즈 핸들 + 접기/확장 버튼을
  //   자동으로 주입한다. 각 화면 모듈은 지금처럼 그대로 두면 된다.
  // ────────────────────────────────────────────────────────────

  function initSidePanelEnhancer() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('side-panel-bg')) {
            enhanceSidePanel(node);
          } else if (node.querySelector) {
            const bg = node.querySelector('.side-panel-bg');
            if (bg) enhanceSidePanel(bg);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function enhanceSidePanel(bgEl) {
    const panel = bgEl.querySelector('.side-panel');
    if (!panel || panel.dataset.lsEnhanced) return;
    panel.dataset.lsEnhanced = '1';

    // 리사이즈 핸들 (패널 왼쪽 가장자리)
    const handle = document.createElement('div');
    handle.className = 'sp-resize-handle';
    panel.prepend(handle);

    // 접기/확장 컨트롤 버튼 — 패널을 열 때마다 각 화면(sales.js 등)이 그리는
    // 공통 헤더(.card-title: 제목 → (배지) → ✕닫기) 안에, ✕ 버튼 바로 앞에
    // 끼워 넣는다. 이렇게 해야 "제목 ... [⤢][−][✕]"가 한 줄로 붙어서
    // 지금처럼 컨트롤이 헤더 위에 따로 떠서 두 줄로 보이는 언밸런스한
    // 모양이 안 생긴다. 4개 화면 모두 같은 헤더 구조를 쓰는 걸 확인했음.
    const controls = document.createElement('span');
    controls.className = 'sp-controls';
    controls.innerHTML = `
      <button type="button" class="sp-ctrl-btn" id="sp-expand-btn" title="전체화면">⤢</button>
      <button type="button" class="sp-ctrl-btn" id="sp-collapse-btn" title="접기">−</button>
    `;
    const header = panel.querySelector(':scope > .card-title');
    let closeBtn = null;
    if (header) {
      closeBtn = header.querySelector('button');
      if (closeBtn) {
        closeBtn.classList.add('sp-close-btn'); // 접힘 상태에서도 계속 보이게 표시
        header.insertBefore(controls, closeBtn);
      } else {
        header.appendChild(controls);
      }
    } else {
      panel.prepend(controls); // 혹시 다른 구조의 패널이면 예전처럼 맨 위에 얹는다
    }

    // 저장된 너비 복원 (side-panel-wide처럼 폭이 이미 지정된 패널은 건드리지 않음)
    const savedWidth = localStorage.getItem('ls-panel-width');
    if (savedWidth) panel.style.width = savedWidth + 'px';

    // 드래그로 너비 조절
    let dragging = false, startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = panel.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // 패널이 화면 오른쪽에서 열리므로, 왼쪽으로 끌수록(clientX 감소) 넓어진다
      const delta = startX - e.clientX;
      let newWidth = startWidth + delta;
      newWidth = Math.max(280, Math.min(newWidth, window.innerWidth * 0.95));
      panel.classList.remove('side-panel-fullscreen');
      panel.style.width = newWidth + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      localStorage.setItem('ls-panel-width', Math.round(panel.getBoundingClientRect().width));
    });

    // 접기: 얇은 탭으로 축소 (다시 누르면 원래 너비로 복원)
    const collapseBtn = controls.querySelector('#sp-collapse-btn');
    collapseBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('side-panel-collapsed');
      collapseBtn.textContent = collapsed ? '+' : '−';
      collapseBtn.title = collapsed ? '펼치기' : '접기';
    });

    // 확장: 전체화면 토글
    const expandBtn = controls.querySelector('#sp-expand-btn');
    expandBtn.addEventListener('click', () => {
      panel.classList.remove('side-panel-collapsed');
      panel.classList.toggle('side-panel-fullscreen');
      collapseBtn.textContent = '−';
      collapseBtn.title = '접기';
    });
  }

  // ────────────────────────────────────────────────────────────
  // "항목 설정" 버튼을 표 위 카드의 제목줄로 이동
  //   table-engine.js는 항상 검색창과 같은 줄(.te-toolbar)에
  //   "⚙️ 항목 설정" 버튼을 그리는데, "+새 OO 등록" 버튼과 다른
  //   줄에 있어서 위치가 어긋나 보인다는 요청이 있었다.
  //   table-engine.js·각 화면 파일은 그대로 두고, 표(.te-wrap)가
  //   생길 때마다 그 바로 위 카드의 제목줄(.card-title)로 버튼만
  //   옮겨서 "+새 OO 등록"과 같은 줄에 나란히 붙게 한다.
  // ────────────────────────────────────────────────────────────

  function initToolbarSettingsMerge() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('te-wrap')) {
            mergeSettingsIntoTitle(node);
          } else if (node.querySelector) {
            const wrap = node.querySelector('.te-wrap');
            if (wrap) mergeSettingsIntoTitle(wrap);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function mergeSettingsIntoTitle(wrap) {
    if (wrap.dataset.lsSettingsMerged) return;
    const settingsBtn = wrap.querySelector(':scope > .te-toolbar > .te-settings-btn');
    if (!settingsBtn) return;

    // 표(.te-wrap)는 같은 카드 안에서 제목줄(.card-title) 바로 다음
    // 형제로 붙는 구조다 (products.js/customers.js/sales.js/purchase.js/
    // stock.js/daily.js 전부 동일하게 확인함). 구조가 다르면 안전하게
    // 원래 위치 그대로 둔다.
    const titleRow = wrap.previousElementSibling;
    if (!titleRow || !titleRow.classList.contains('card-title')) return;

    wrap.dataset.lsSettingsMerged = '1';
    if (titleRow.querySelector('.ls-btn-primary')) {
      settingsBtn.style.marginLeft = '8px'; // "+새 OO 등록" 버튼 바로 옆에 살짝 띄워서
    } else {
      settingsBtn.style.marginLeft = 'auto'; // 등록 버튼이 없는 화면(재고현황 등)은 제목 오른쪽 끝으로
    }
    titleRow.appendChild(settingsBtn);
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
