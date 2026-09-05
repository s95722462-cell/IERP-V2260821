// ══════════════════════════════════════════════════════════════
// customers.js — 거래처 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈 (1부 5개 모듈 위에 얹는 첫 실제 화면)
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js
//
// 데이터 경로: users/{safeId}/companies/{companyId}/customers/{id}
// (companyId는 항상 auth.js의 curCompanyId()로 얻은 고유 ID — 배열
// 인덱스를 절대 쓰지 않는다는 2장 원칙을 그대로 따른다)
// ══════════════════════════════════════════════════════════════

const CustomersModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingId = null;
  let unsubscribe = null;
  let updateListeners = [];

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/customers`;
  }

  /** 화면을 그리고 이벤트를 연결합니다. LayoutShell.init() 이후 한 번 호출합니다. */
  function init() {
    const panel = LayoutShell.registerPanel('customers');
    panel.innerHTML = `
      <div class="card" id="cu-list-card">
        <div class="card-title card-title-action" style="display:flex;align-items:center">
          거래처 목록
          <button class="ls-btn-primary" id="cu-add-btn" style="margin-left:auto;width:auto">+ 새 거래처 추가</button>
        </div>
      </div>

      <div class="side-panel-bg" id="cu-panel-bg" style="display:none">
        <div class="side-panel">
          <div class="card-title" style="display:flex;align-items:center">
            <span id="cu-panel-title">새 거래처 등록</span>
            <button id="cu-panel-close" style="margin-left:auto">✕</button>
          </div>
          <div class="form-grid" style="grid-template-columns:1fr">
            <div class="fg"><label>회사명 *</label><input id="cu-name" placeholder="(주)○○무역"></div>
            <div class="fg"><label>사업자번호</label><input id="cu-bizno"></div>
            <div class="fg"><label>대표자</label><input id="cu-ceo"></div>
            <div class="fg"><label>업태</label><input id="cu-biztype" placeholder="제조업, 도소매 등"></div>
            <div class="fg"><label>종목</label><input id="cu-bizitem" placeholder="자동화 부품 등"></div>
            <div class="fg"><label>전화번호</label><input id="cu-tel"></div>
            <div class="fg"><label>팩스번호</label><input id="cu-fax"></div>
            <div class="fg"><label>이메일</label><input id="cu-email"></div>
            <div class="fg"><label>주소</label><input id="cu-addr"></div>
            <div class="fg"><label>메모</label><input id="cu-memo"></div>
          </div>
          <div class="btn-row" style="margin-top:10px">
            <button class="ls-btn-primary" id="cu-save-btn" style="width:auto">저장</button>
            <button id="cu-cancel-btn">취소</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('cu-add-btn').addEventListener('click', () => { fillForm(null); openPanel(); });
    document.getElementById('cu-panel-close').addEventListener('click', closePanel);
    document.getElementById('cu-panel-bg').addEventListener('click', (e) => {
      if (e.target.id === 'cu-panel-bg') closePanel();
    });
    document.getElementById('cu-save-btn').addEventListener('click', async () => { const ok = await save(); if (ok) closePanel(); });
    document.getElementById('cu-cancel-btn').addEventListener('click', closePanel);

    tableInstance = TableEngine.create('customers', {
      container: document.getElementById('cu-list-card'),
      columns: [
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'name', label: '회사명' },
        { key: 'bizno', label: '사업자번호' },
        { key: 'ceo', label: '대표자' },
        { key: 'biztype', label: '업태' },
        { key: 'bizitem', label: '종목' },
        { key: 'tel', label: '전화번호' },
        { key: 'fax', label: '팩스번호' },
        { key: 'email', label: '이메일' },
        { key: 'addr', label: '주소' },
        { key: 'memo', label: '메모' }
      ],
      searchFields: ['name', 'ceo', 'bizno'],
      rowActions: (row) => `
        <button data-act="edit" data-id="${row.id}">수정</button>
        <button data-act="del" data-id="${row.id}">삭제</button>`
    });

    document.getElementById('cu-list-card').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') startEdit(id);
      if (btn.getAttribute('data-act') === 'del') remove(id);
    });
  }

  /** 오른쪽 슬라이드 패널을 연다 (새 거래처 추가 / 수정 공용). */
  function openPanel() {
    document.getElementById('cu-panel-bg').style.display = 'flex';
  }

  /** 패널을 닫고 폼을 비운다. */
  function closePanel() {
    document.getElementById('cu-panel-bg').style.display = 'none';
    fillForm(null);
  }

  /** 실시간 구독을 시작합니다. 로그인 직후, 그리고 회사를 전환할 때마다 다시 호출합니다. */
  function startListening() {
    if (unsubscribe) unsubscribe();
    unsubscribe = DbEngine.listen(path(), {
      orderBy: { field: 'createdAt', direction: 'desc' },
      onData: (docs) => { cache = docs; tableInstance.render(cache); updateListeners.forEach((cb) => cb(cache)); }
    });
  }

  function fillForm(row) {
    document.getElementById('cu-name').value = row?.name || '';
    document.getElementById('cu-bizno').value = row?.bizno || '';
    document.getElementById('cu-ceo').value = row?.ceo || '';
    document.getElementById('cu-biztype').value = row?.biztype || '';
    document.getElementById('cu-bizitem').value = row?.bizitem || '';
    document.getElementById('cu-tel').value = row?.tel || '';
    document.getElementById('cu-fax').value = row?.fax || '';
    document.getElementById('cu-email').value = row?.email || '';
    document.getElementById('cu-addr').value = row?.addr || '';
    document.getElementById('cu-memo').value = row?.memo || '';
    editingId = row ? row.id : null;
    document.getElementById('cu-panel-title').textContent = row ? '거래처 수정' : '새 거래처 등록';
    document.getElementById('cu-save-btn').textContent = row ? '수정 저장' : '저장';
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (row) { fillForm(row); openPanel(); }
  }

  async function save() {
    const name = document.getElementById('cu-name').value.trim();
    if (!name) { alert('회사명을 입력하세요'); return false; }
    const data = {
      name,
      bizno: document.getElementById('cu-bizno').value,
      ceo: document.getElementById('cu-ceo').value,
      biztype: document.getElementById('cu-biztype').value,
      bizitem: document.getElementById('cu-bizitem').value,
      tel: document.getElementById('cu-tel').value,
      fax: document.getElementById('cu-fax').value,
      email: document.getElementById('cu-email').value,
      addr: document.getElementById('cu-addr').value,
      memo: document.getElementById('cu-memo').value
    };
    if (editingId) {
      await updateDoc(path(), editingId, data);
    } else {
      await addDoc(path(), data);
    }
    return true;
  }

  async function remove(id) {
    if (!confirm('이 거래처를 삭제하시겠습니까?')) return;
    await deleteDoc(path(), id);
  }

  /** 다른 화면(매출/매입 등)에서 거래처 목록을 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 거래처 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  // ── 검색되는 거래처 선택 (공통 부품) ──────────────────────────
  // 여러 화면(매출 등록, 매출 원장, 매입 등록 등)에서 "거래처를 이름으로
  // 검색해서 고르는" 입력칸이 똑같이 필요해서, 여기 한 번만 만들어두고
  // 재사용합니다. <input list="datalistId"> + <datalist> 조합으로,
  // 실제 선택된 거래처 id는 별도 hidden input에 저장합니다.

  /**
   * @param {string} nameInputId - 사용자가 이름을 입력/검색하는 input의 id
   * @param {string} hiddenIdInputId - 실제 선택된 거래처 id를 담을 hidden input의 id
   * @param {string} datalistId - datalist 요소의 id (nameInput의 list 속성과 일치해야 함)
   */
  function bindSearchableSelect(nameInputId, hiddenIdInputId, datalistId) {
    const nameInput = document.getElementById(nameInputId);
    const hiddenInput = document.getElementById(hiddenIdInputId);
    if (!nameInput || !hiddenInput) return;
    nameInput.addEventListener('input', () => {
      const match = cache.find((c) => c.name === nameInput.value.trim());
      hiddenInput.value = match ? match.id : '';
    });
  }

  /** bindSearchableSelect로 만든 입력칸에, 거래처 id를 지정해 값을 채웁니다
   * (등록 폼 초기화, 수정 모드 진입 시 사용). */
  function setSearchableSelectValue(nameInputId, hiddenIdInputId, buyerId) {
    const nameInput = document.getElementById(nameInputId);
    const hiddenInput = document.getElementById(hiddenIdInputId);
    if (!nameInput || !hiddenInput) return;
    hiddenInput.value = buyerId || '';
    const c = cache.find((x) => x.id === buyerId);
    nameInput.value = c ? c.name : '';
  }

  /** 거래처 목록이 바뀔 때마다 datalist 옵션도 다시 채웁니다. */
  function refreshSearchableSelectOptions(datalistId) {
    const dl = document.getElementById(datalistId);
    if (!dl) return;
    dl.innerHTML = cache.map((c) => `<option value="${escapeHtml(c.name)}">`).join('');
  }

  return {
    init, startListening, getCache, onUpdate,
    bindSearchableSelect, setSearchableSelectValue, refreshSearchableSelectOptions
  };
})();

window.CustomersModule = CustomersModule;
