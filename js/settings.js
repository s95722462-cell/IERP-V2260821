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
        <div class="card-title">화면 설정</div>
        <label class="ls-chk"><input type="checkbox" id="st-theme-toggle"> 다크 모드</label>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">데이터 내보내기</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px">현재 회사의 거래처·품목·매출·매입 데이터를 JSON 파일로 저장합니다. (백업용으로 주기적으로 받아두는 것을 권장합니다.)</div>
        <button id="st-export-btn">JSON으로 내보내기</button>
      </div>
    `;

    const { currentUser } = getAuthState();
    if (currentUser) document.getElementById('st-uid').value = currentUser.id;

    document.getElementById('st-account-form').addEventListener('submit', (e) => { e.preventDefault(); changePassword(); });
    document.getElementById('st-add-co').addEventListener('click', addCompany);
    document.getElementById('st-theme-toggle').addEventListener('change', toggleTheme);
    document.getElementById('st-export-btn').addEventListener('click', exportJson);

    document.getElementById('st-theme-toggle').checked = getSavedTheme() === 'dark';

    renderCompanyList();
  }

  function renderCompanyList() {
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
    for (const col of ['customers', 'products', 'sales', 'purchases']) {
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

  function exportJson() {
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
    a.download = `iERP_backup_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return { init, renderCompanyList };
})();

window.SettingsModule = SettingsModule;
