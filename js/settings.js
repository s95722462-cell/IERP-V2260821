// ══════════════════════════════════════════════════════════════
// settings.js — 계정 · 회사 정보 관리 · 테마 · 데이터 내보내기
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js,
//         sales.js, purchase.js, customers.js, products.js
// ══════════════════════════════════════════════════════════════

const SettingsModule = (() => {
  function init() {
    const panel = LayoutShell.registerPanel('settings');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">👤 내 계정</div>
        <div class="form-grid">
          <div class="fg"><label>아이디</label><input id="st-uid" readonly style="background:var(--surface2)"></div>
          <div class="fg"><label>새 비밀번호 (변경 시에만 입력)</label><input id="st-newpw" type="password"></div>
        </div>
        <button class="ls-btn-primary" id="st-pw-save" style="width:auto;margin-top:10px">비밀번호 변경</button>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">🏢 회사 관리 <span style="font-weight:400;font-size:12px;color:var(--text2)">(최대 5개)</span></div>
        <div id="st-company-list"></div>
        <div class="form-grid" style="margin-top:10px">
          <div class="fg"><label>새 회사명</label><input id="st-new-co-name" placeholder="(주)○○"></div>
        </div>
        <button id="st-add-co" style="margin-top:8px">＋ 회사 추가</button>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">🎨 화면 설정</div>
        <label class="ls-chk"><input type="checkbox" id="st-theme-toggle"> 다크 모드</label>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">💾 데이터 내보내기</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px">현재 회사의 거래처·품목·매출·매입 데이터를 JSON 파일로 저장합니다. (백업용으로 주기적으로 받아두는 것을 권장합니다.)</div>
        <button id="st-export-btn">JSON으로 내보내기</button>
      </div>
    `;

    const { currentUser } = getAuthState();
    document.getElementById('st-uid').value = currentUser.id;

    document.getElementById('st-pw-save').addEventListener('click', changePassword);
    document.getElementById('st-add-co').addEventListener('click', addCompany);
    document.getElementById('st-theme-toggle').addEventListener('change', toggleTheme);
    document.getElementById('st-export-btn').addEventListener('click', exportJson);

    document.getElementById('st-theme-toggle').checked = document.body.getAttribute('data-theme') === 'dark';

    renderCompanyList();
  }

  function renderCompanyList() {
    const listEl = document.getElementById('st-company-list');
    listEl.innerHTML = companies.map((c, i) => `
      <div class="st-co-row">
        <span>${escapeHtml(c.company || '회사' + (i + 1))}${i === activeCoIdx ? ' <span class="badge badge-blue">사용 중</span>' : ''}</span>
        <span class="st-co-actions">
          ${i !== activeCoIdx ? `<button data-act="switch" data-idx="${i}">전환</button>` : ''}
          ${companies.length > 1 ? `<button data-act="delete" data-idx="${i}">삭제</button>` : ''}
        </span>
      </div>`).join('');

    listEl.querySelectorAll('button[data-act]').forEach((btn) => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (btn.getAttribute('data-act') === 'switch') btn.addEventListener('click', () => switchCompany(idx));
      if (btn.getAttribute('data-act') === 'delete') btn.addEventListener('click', () => deleteCompany(idx));
    });
  }

  async function changePassword() {
    const pw = document.getElementById('st-newpw').value;
    if (!pw) { alert('변경할 비밀번호를 입력하세요'); return; }
    if (pw.length < 6) { alert('비밀번호는 6자 이상이어야 합니다'); return; }
    try {
      await firebase.auth().currentUser.updatePassword(pw);
      document.getElementById('st-newpw').value = '';
      alert('✅ 비밀번호가 변경되었습니다');
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

    const { currentUser } = getAuthState();
    for (const col of ['customers', 'products', 'sales', 'purchases']) {
      const colPath = `users/${currentUser.safeId}/companies/${removedId}/${col}`;
      const snap = await db.collection(colPath).get();
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    renderCompanyList();
    LayoutShell.renderCompanyTabs(companies, activeCoIdx);
    if (window.onCompanySwitched) window.onCompanySwitched();
  }

  function toggleTheme() {
    const isDark = document.getElementById('st-theme-toggle').checked;
    document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('ierp_theme', isDark ? 'dark' : 'light');
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
    a.download = `iERP_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return { init, renderCompanyList };
})();

window.SettingsModule = SettingsModule;
