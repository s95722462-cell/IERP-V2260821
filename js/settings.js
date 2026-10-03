// ══════════════════════════════════════════════════════════════
// settings.js — 계정 · 회사 정보 관리 · 테마 · 데이터 내보내기
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js,
//         sales.js, purchase.js, customers.js, products.js
// ══════════════════════════════════════════════════════════════

const SettingsModule = (() => {
  let editingCoIdx = null;

  function init() {
    const panel = LayoutShell.registerPanel('settings');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">내 계정</div>
        <form id="st-account-form">
          <div class="form-grid">
            <div class="fg"><label>아이디</label><input id="st-uid" readonly autocomplete="username" style="background:var(--surface2)"></div>
            <div class="fg"><label>새 비밀번호 (변경 시에만 입력)</label><input id="st-newpw" type="password" autocomplete="new-password"></div>
          </div>
          <button class="ls-btn-primary" id="st-pw-save" type="submit" style="width:auto;margin-top:10px">비밀번호 변경</button>
        </form>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">회사 관리 <span style="font-weight:400;font-size:12px;color:var(--text2)">(최대 5개)</span></div>
        <div id="st-company-list"></div>
        <div class="form-grid" style="margin-top:10px">
          <div class="fg"><label>새 회사명</label><input id="st-new-co-name" placeholder="(주)○○"></div>
        </div>
        <button id="st-add-co" style="margin-top:8px">＋ 회사 추가</button>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">회계연도</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px">대시보드의 매출·매입·매출총이익을 계산하는 기준 연도입니다. (일별현황·매출관리·매입관리는 이번 달 1일~오늘이 기본이고, 표 위의 연도 선택으로 바꿔 볼 수 있습니다.) 연도가 바뀌면 여기서 새해로 바꿔주세요.</div>
        <div class="form-grid">
          <div class="fg"><label>현재 회계연도</label><select id="st-fiscal-year"></select></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">화면 설정</div>
        <label class="ls-chk"><input type="checkbox" id="st-theme-toggle"> 다크 모드</label>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">데이터 백업 / 복원</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px">현재 회사의 거래처·품목·매출·매입 데이터를 JSON 파일로 저장합니다. (백업용으로 주기적으로 받아두는 것을 권장합니다.)</div>
        <div class="btn-row">
          <button id="st-export-btn">JSON으로 내보내기</button>
          <button id="st-restore-btn">JSON에서 복원</button>
          <input type="file" id="st-restore-file" accept=".json" style="display:none">
        </div>
        <div style="font-size:12px;color:var(--text2);margin-top:8px">⚠️ 복원하면 현재 회사의 거래처·품목·매출·매입 데이터가 백업 파일 내용으로 전부 교체됩니다(되돌릴 수 없음).</div>
        <label class="ls-chk" style="margin-top:12px"><input type="checkbox" id="st-auto-backup"> 매일 처음 접속할 때 자동으로 백업 파일 내려받기 (이 브라우저)</label>
        <div id="st-auto-backup-info" style="font-size:12px;color:var(--text2);margin-top:4px"></div>
      </div>
    `;

    document.getElementById('st-account-form').addEventListener('submit', (e) => { e.preventDefault(); changePassword(); });
    document.getElementById('st-add-co').addEventListener('click', addCompany);
    document.getElementById('st-theme-toggle').addEventListener('change', toggleTheme);
    document.getElementById('st-export-btn').addEventListener('click', exportJson);
    document.getElementById('st-restore-btn').addEventListener('click', () => document.getElementById('st-restore-file').click());
    document.getElementById('st-restore-file').addEventListener('change', handleRestoreFile);
    document.getElementById('st-fiscal-year').addEventListener('change', saveFiscalYear);

    document.getElementById('st-theme-toggle').checked = getSavedTheme() === 'dark';
    document.getElementById('st-auto-backup').checked = isAutoBackupOn();
    document.getElementById('st-auto-backup').addEventListener('change', (e) => {
      storageSet(AUTO_BACKUP_OFF_KEY, e.target.checked ? null : '1');
    });

    renderFiscalYearSelect();
    renderCompanyList();
  }

  /** 최근 15년 ~ 내년까지를 선택지로 두고, 회사에 저장된 값(없으면 올해)을 선택 상태로 맞춘다. */
  function renderFiscalYearSelect() {
    const sel = document.getElementById('st-fiscal-year');
    if (!sel) return;
    const nowYear = new Date().getFullYear();
    const years = [];
    for (let y = nowYear + 1; y >= nowYear - 15; y--) years.push(y);
    sel.innerHTML = years.map((y) => `<option value="${y}">${y}년</option>`).join('');
    sel.value = getFiscalYear();
  }

  async function saveFiscalYear() {
    const year = document.getElementById('st-fiscal-year').value;
    companies[activeCoIdx].fiscalYear = year;
    await saveUserMeta();
    alert(`✅ 회계연도가 ${year}년으로 설정되었습니다. 화면을 새로고침하면 반영됩니다.`);
  }

  /** 지금 회사에 설정된 회계연도를 반환합니다 (없으면 올해). 다른 화면(dashboard.js, table-engine.js)이
   * 기준 연도(대시보드 집계, defaultRange: 'fiscalYear'인 표의 기본 기간)를 정할 때 사용합니다. */
  function getFiscalYear() {
    const y = companies[activeCoIdx]?.fiscalYear;
    return y ? Number(y) : new Date().getFullYear();
  }

  function renderCompanyList() {
    renderFiscalYearSelect(); // 회사가 바뀌면(전환/추가/삭제) 그 회사의 회계연도도 같이 최신화
    // 아이디 칸은 init() 시점엔 아직 로그인 확인 전이라 비어 있으므로, 로그인
    // 직후(main.js의 afterLoginSuccess)에 불리는 이 함수에서 채운다.
    const { currentUser } = getAuthState();
    document.getElementById('st-uid').value = currentUser ? currentUser.id : '';
    const listEl = document.getElementById('st-company-list');
    listEl.innerHTML = companies.map((c, i) => `
      <div class="st-co-row">
        <span>${escapeHtml(c.company || '회사' + (i + 1))}${i === activeCoIdx ? ' <span class="badge badge-blue">사용 중</span>' : ''}</span>
        <span class="st-co-actions">
          <button data-act="edit" data-idx="${i}">${editingCoIdx === i ? '닫기' : '수정'}</button>
          ${i !== activeCoIdx ? `<button data-act="switch" data-idx="${i}">전환</button>` : ''}
          ${companies.length > 1 ? `<button data-act="delete" data-idx="${i}">삭제</button>` : ''}
        </span>
      </div>
      ${editingCoIdx === i ? buildCompanyEditForm(c) : ''}`).join('');

    listEl.querySelectorAll('button[data-act]').forEach((btn) => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (btn.getAttribute('data-act') === 'switch') btn.addEventListener('click', () => switchCompany(idx));
      if (btn.getAttribute('data-act') === 'delete') btn.addEventListener('click', () => deleteCompany(idx));
      if (btn.getAttribute('data-act') === 'edit') btn.addEventListener('click', () => {
        editingCoIdx = editingCoIdx === idx ? null : idx;
        renderCompanyList();
      });
    });

    const saveBtn = listEl.querySelector('[data-act="save-co"]');
    if (saveBtn) saveBtn.addEventListener('click', () => saveCompanyEdit(parseInt(saveBtn.getAttribute('data-idx'), 10)));
  }

  /** 회사 상세 정보(거래명세서 공급자란에 그대로 쓰이는 값들) 수정 폼. */
  function buildCompanyEditForm(c) {
    const idx = companies.indexOf(c);
    const f = (key, label, id, wide) =>
      `<div class="fg"${wide ? ' style="grid-column:1/-1"' : ''}><label>${label}</label><input id="${id}" value="${escapeHtml(c[key] || '')}"></div>`;
    return `
      <div class="st-co-edit-form form-grid" style="margin:8px 0 16px">
        ${f('company', '회사명', 'stc-company')}
        ${f('bizno', '사업자번호', 'stc-bizno')}
        ${f('ceo', '대표자', 'stc-ceo')}
        ${f('biztype', '업태', 'stc-biztype')}
        ${f('bizitem', '종목', 'stc-bizitem')}
        ${f('addr', '주소', 'stc-addr', true)}
        ${f('tel', '연락처', 'stc-tel')}
        ${f('fax', '팩스', 'stc-fax')}
        ${f('email', '이메일', 'stc-email')}
        ${f('bank', '은행', 'stc-bank')}
        ${f('account', '계좌번호', 'stc-account')}
        ${f('accountname', '예금주', 'stc-accountname')}
        ${f('terms', '결제조건', 'stc-terms')}
        <div class="fg" style="grid-column:1/-1"><label>거래명세서 하단 문구</label><input id="stc-footer" value="${escapeHtml(c.footer || '')}"></div>
      </div>
      <button class="ls-btn-primary" data-act="save-co" data-idx="${idx}" style="width:auto;margin-bottom:16px">회사 정보 저장</button>`;
  }

  async function saveCompanyEdit(idx) {
    const get = (id) => document.getElementById(id).value.trim();
    Object.assign(companies[idx], {
      company: get('stc-company') || companies[idx].company,
      bizno: get('stc-bizno'), ceo: get('stc-ceo'), biztype: get('stc-biztype'), bizitem: get('stc-bizitem'),
      addr: get('stc-addr'), tel: get('stc-tel'), fax: get('stc-fax'), email: get('stc-email'),
      bank: get('stc-bank'), account: get('stc-account'), accountname: get('stc-accountname'),
      terms: get('stc-terms'), footer: get('stc-footer')
    });
    await saveUserMeta();
    editingCoIdx = null;
    renderCompanyList();
    LayoutShell.renderCompanyTabs(companies, activeCoIdx);
    alert('회사 정보가 저장되었습니다');
  }

  async function changePassword() {
    const pw = document.getElementById('st-newpw').value;
    if (!pw) { alert('변경할 비밀번호를 입력하세요'); return; }
    if (pw.length < 6) { alert('비밀번호는 6자 이상이어야 합니다'); return; }
    try {
      await firebase.auth().currentUser.updatePassword(pw);
      document.getElementById('st-newpw').value = '';
      alert('비밀번호가 변경되었습니다');
    } catch (e) {
      if (e.code === 'auth/requires-recent-login') {
        alert('보안을 위해 다시 로그인한 뒤 시도해 주세요');
      } else {
        alert('오류: ' + e.message);
      }
    }
  }

  async function addCompany() {
    const name = document.getElementById('st-new-co-name').value.trim();
    if (!name) { alert('회사명을 입력하세요'); return; }
    if (companies.length >= 5) { alert('회사는 최대 5개까지 등록할 수 있습니다'); return; }
    companies.push({
      id: genId(), company: name,
      bizno: '', ceo: '', biztype: '', bizitem: '', addr: '', tel: '', fax: '',
      email: '', bank: '', account: '', accountname: '', terms: '', footer: ''
    });
    await saveUserMeta();
    document.getElementById('st-new-co-name').value = '';
    renderCompanyList();
    LayoutShell.renderCompanyTabs(companies, activeCoIdx);
  }

  async function switchCompany(idx) {
    activeCoIdx = idx;
    await saveUserMeta();
    renderCompanyList();
    LayoutShell.renderCompanyTabs(companies, activeCoIdx);
    if (window.onCompanySwitched) window.onCompanySwitched(); // main.js가 각 화면의 startListening()을 다시 걸도록 연결
  }

  async function deleteCompany(idx) {
    if (!confirm(`"${companies[idx].company}"를 삭제하시겠습니까? 등록된 거래처·품목·매출·매입 데이터도 함께 삭제됩니다.`)) return;
    const removedId = companies[idx].id;
    companies.splice(idx, 1);
    if (activeCoIdx >= companies.length) activeCoIdx = companies.length - 1;
    await saveUserMeta();

    // batchWrite()(db.js)를 써서 400개씩 자동 분할 삭제한다 — 여기서
    // db.batch()를 직접 썼다면 컬렉션 하나가 500개를 넘는 순간(예:
    // 품목 엑셀 대량 업로드 이후) 삭제가 조용히 실패했을 것이다.
    const { currentUser } = getAuthState();
    // counters(전표번호 채번 기록)도 함께 지운다 — 예전엔 빠져 있어서 회사를 지워도 남아 있었다.
    for (const col of ['customers', 'products', 'sales', 'purchases', 'counters']) {
      const colPath = `users/${currentUser.safeId}/companies/${removedId}/${col}`;
      const snap = await db.collection(colPath).get();
      const ops = snap.docs.map((d) => ({ type: 'delete', path: colPath, id: d.id }));
      if (ops.length) await batchWrite(ops);
    }

    renderCompanyList();
    LayoutShell.renderCompanyTabs(companies, activeCoIdx);
    if (window.onCompanySwitched) window.onCompanySwitched();
  }

  /** 상단바에도 같은 다크모드 토글이 생겨서(layout-shell.js), 그쪽과 항상
   * 같은 상태를 유지하도록 공용 함수(applyTheme, security.js)로 통일했다. */
  function toggleTheme() {
    const isDark = document.getElementById('st-theme-toggle').checked;
    applyTheme(isDark ? 'dark' : 'light');
    LayoutShell.renderThemeToggleIcon();
  }

  /** @param {string} [filename] - 생략하면 `iERP_backup_날짜.json` */
  function exportJson(filename) {
    const data = {
      exportedAt: new Date().toISOString(),
      company: companies[activeCoIdx],
      customers: CustomersModule.getCache(),
      products: ProductsModule.getCache(),
      sales: SalesModule.getCache(),
      purchases: PurchaseModule.getCache()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (typeof filename === 'string' && filename) || `iERP_backup_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── 자동 백업 ──────────────────────────────────────────────
  // 서버 쪽 정기 백업(Cloud Functions)은 유료 요금제가 필요해서, 대신 하루 중
  // 처음 접속했을 때 브라우저가 JSON 백업 파일을 PC로 자동으로 내려받는다.
  // Firebase 쪽에 사고가 나도 PC에 사본이 남는다. "오늘 받았는지"는 계정·회사별로
  // 이 브라우저의 localStorage에 기억한다 (다른 PC에서는 그 PC대로 따로 받는다).
  const AUTO_BACKUP_OFF_KEY = 'iERP_autoBackupOff';
  const autoBackupKey = () => `iERP_autoBackup_${getAuthState().currentUser.safeId}_${curCompanyId()}`;
  let autoBackupTimer = null;

  // localStorage는 사생활 보호 모드 등에서 예외가 날 수 있어 항상 감싼다
  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* 무시 */ }
  }
  function isAutoBackupOn() { return storageGet(AUTO_BACKUP_OFF_KEY) !== '1'; }

  function renderAutoBackupInfo() {
    const chk = document.getElementById('st-auto-backup');
    if (chk) chk.checked = isAutoBackupOn();
    const el = document.getElementById('st-auto-backup-info');
    if (!el) return;
    const { currentUser } = getAuthState();
    const last = currentUser && curCompanyId() ? storageGet(autoBackupKey()) : null;
    el.textContent = last ? `이 회사의 마지막 자동 백업: ${last} (다운로드 폴더의 iERP_auto_...json)` : '';
  }

  /**
   * 로그인·회사 전환 직후 호출한다. 모든 데이터가 서버에서 도착할 때까지
   * 기다렸다가(최대 1분), 오늘 이 회사를 아직 백업하지 않았으면 내려받는다.
   */
  function scheduleAutoBackup() {
    clearInterval(autoBackupTimer);
    renderAutoBackupInfo();
    if (!isAutoBackupOn()) return;
    let waited = 0;
    autoBackupTimer = setInterval(() => {
      waited += 2000;
      if (waited > 60000) { clearInterval(autoBackupTimer); return; }
      const { currentUser } = getAuthState();
      if (!currentUser || !curCompanyId() || !DbEngine.isFullyLoaded()) return;
      clearInterval(autoBackupTimer);
      runAutoBackupIfDue();
    }, 2000);
  }

  /** 데이터가 하나도 없으면(새 회사) 받지 않고 날짜도 기록하지 않는다. */
  function runAutoBackupIfDue() {
    const today = todayStr();
    if (storageGet(autoBackupKey()) === today) return;
    const total = CustomersModule.getCache().length + ProductsModule.getCache().length
      + SalesModule.getCache().length + PurchaseModule.getCache().length;
    if (!total) return;
    const coName = String(companies[activeCoIdx]?.company || 'company').replace(/[\\/:*?"<>|\s]+/g, '_');
    exportJson(`iERP_auto_${coName}_${today}.json`);
    storageSet(autoBackupKey(), today);
    renderAutoBackupInfo();
  }

  const RESTORE_COLLECTIONS = ['customers', 'products', 'sales', 'purchases'];
  const RESTORE_LABELS = { customers: '거래처', products: '품목', sales: '매출', purchases: '매입' };

  /** exportJson()이 저장한 createdAt(순수 JSON 객체 또는 문자열)을 다시 Firestore
   * Timestamp로 되살린다. customers/products 목록은 orderBy('createdAt')로 조회하는데
   * (customers.js/products.js), Firestore는 그 필드가 없거나 Timestamp 타입이 아니면
   * 조회 결과에서 문서를 통째로 빠뜨린다 — 예전에 이 문제로 목록에서 문서가 사라지는
   * 사고가 있었어서(products.js의 createdAt 복구 함수 참고) 복원 시에도 반드시 지켜야 한다. */
  function toFirestoreTimestamp(v) {
    if (v && typeof v === 'object' && typeof v.seconds === 'number') {
      return new firebase.firestore.Timestamp(v.seconds, v.nanoseconds || 0);
    }
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  async function handleRestoreFile(e) {
    const file = e.target.files[0];
    e.target.value = ''; // 같은 파일을 다시 선택해도 change 이벤트가 나도록 초기화
    if (!file) return;

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      alert('올바른 JSON 백업 파일이 아닙니다: ' + err.message);
      return;
    }
    if (!RESTORE_COLLECTIONS.every((k) => Array.isArray(data[k]))) {
      alert('백업 파일 형식이 올바르지 않습니다 (거래처·품목·매출·매입 목록을 찾을 수 없습니다).');
      return;
    }

    const co = companies[activeCoIdx];
    const counts = RESTORE_COLLECTIONS.map((k) => `${RESTORE_LABELS[k]} ${data[k].length}건`).join(' / ');
    const exportedAt = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : '날짜 미상';
    const ok = confirm(
      `"${co.company}" 회사의 현재 거래처·품목·매출·매입 데이터를 모두 지우고,\n` +
      `이 백업 파일(${exportedAt}에 내보낸 파일)의 내용으로 되돌립니다.\n\n${counts}\n\n` +
      `복원을 시작하기 전에 현재 데이터를 백업 파일(iERP_before_restore_...json)로\n` +
      `자동으로 먼저 내려받습니다. 계속하시겠습니까?`
    );
    if (!ok) return;

    // 복원은 "기존 데이터 전부 삭제 → 백업 내용 쓰기" 순서라, 중간에 네트워크가
    // 끊기면 데이터가 비어버릴 수 있다. 그때 되살릴 수 있도록 지우기 직전의
    // 현재 상태를 반드시 먼저 파일로 받아둔다.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportJson(`iERP_before_restore_${stamp}.json`);

    const btn = document.getElementById('st-restore-btn');
    btn.disabled = true;
    btn.textContent = '복원 중...';
    try {
      const { currentUser } = getAuthState();
      const companyId = curCompanyId();

      // 1) 현재 회사의 기존 데이터를 전부 삭제한다 (백업 시점 상태로 완전히 되돌리기 위함)
      for (const kind of RESTORE_COLLECTIONS) {
        const colPath = `users/${currentUser.safeId}/companies/${companyId}/${kind}`;
        const snap = await db.collection(colPath).get();
        const delOps = snap.docs.map((d) => ({ type: 'delete', path: colPath, id: d.id }));
        if (delOps.length) await batchWrite(delOps);
      }

      // 2) 백업 내용을 원래 문서 ID 그대로 다시 쓴다 (매출/매입의 productId·buyerId·
      // vendorId가 거래처/품목 문서 ID를 참조하므로, ID를 유지해야 연결이 깨지지 않는다)
      const ops = [];
      ['customers', 'products'].forEach((kind) => {
        const colPath = `users/${currentUser.safeId}/companies/${companyId}/${kind}`;
        data[kind].forEach((row) => {
          const { id, createdAt, ...rest } = row;
          ops.push({ type: 'set', path: colPath, id: id || genId(), data: { ...rest, createdAt: toFirestoreTimestamp(createdAt) } });
        });
      });
      ['sales', 'purchases'].forEach((kind) => {
        const colPath = `users/${currentUser.safeId}/companies/${companyId}/${kind}`;
        data[kind].forEach((row) => {
          const { id, ...rest } = row;
          ops.push({ type: 'set', path: colPath, id: id || genId(), data: rest });
        });
      });
      if (ops.length) await batchWrite(ops);

      // 3) 회사 정보(사업자번호 등)도 백업 시점 값으로 되돌린다 (현재 회사의 id는 유지)
      if (data.company && typeof data.company === 'object') {
        const { id, ...companyRest } = data.company;
        Object.assign(companies[activeCoIdx], companyRest);
        await saveUserMeta();
        renderCompanyList();
        LayoutShell.renderCompanyTabs(companies, activeCoIdx);
      }

      alert('복원이 완료되었습니다. 화면이 잠시 후 자동으로 갱신됩니다.');
    } catch (err) {
      alert('복원 중 오류가 발생했습니다: ' + err.message);
      console.error('[백업 복원 실패]', err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'JSON에서 복원';
    }
  }

  return { init, renderCompanyList, getFiscalYear, scheduleAutoBackup };
})();

window.SettingsModule = SettingsModule;
