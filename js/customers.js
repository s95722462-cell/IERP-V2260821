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
      <div class="card">
        <div class="card-title">🏢 거래처 등록 / 수정</div>
        <div class="form-grid">
          <div class="fg"><label>회사명 *</label><input id="cu-name" placeholder="(주)○○무역"></div>
          <div class="fg"><label>사업자번호</label><input id="cu-bizno"></div>
          <div class="fg"><label>대표자</label><input id="cu-ceo"></div>
          <div class="fg"><label>업태</label><input id="cu-biztype" placeholder="제조업, 도소매 등"></div>
          <div class="fg"><label>종목</label><input id="cu-bizitem" placeholder="자동화 부품 등"></div>
          <div class="fg"><label>연락처</label><input id="cu-tel"></div>
          <div class="fg"><label>이메일</label><input id="cu-email"></div>
          <div class="fg" style="grid-column:1/-1"><label>주소</label><input id="cu-addr"></div>
          <div class="fg" style="grid-column:1/-1"><label>메모</label><input id="cu-memo"></div>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="ls-btn-primary" id="cu-save-btn" style="width:auto">저장</button>
          <button id="cu-cancel-btn" style="display:none">취소</button>
        </div>
      </div>
      <div class="card" id="cu-list-card" style="margin-top:16px">
        <div class="card-title">거래처 목록</div>
      </div>
    `;

    document.getElementById('cu-save-btn').addEventListener('click', save);
    document.getElementById('cu-cancel-btn').addEventListener('click', () => fillForm(null));

    tableInstance = TableEngine.create('customers', {
      container: document.getElementById('cu-list-card'),
      columns: [
        { key: 'name', label: '회사명' },
        { key: 'bizno', label: '사업자번호' },
        { key: 'ceo', label: '대표자' },
        { key: 'biztype', label: '업태' },
        { key: 'bizitem', label: '종목' },
        { key: 'tel', label: '연락처' },
        { key: 'email', label: '이메일' },
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
    document.getElementById('cu-email').value = row?.email || '';
    document.getElementById('cu-addr').value = row?.addr || '';
    document.getElementById('cu-memo').value = row?.memo || '';
    editingId = row ? row.id : null;
    document.getElementById('cu-cancel-btn').style.display = row ? '' : 'none';
    document.getElementById('cu-save-btn').textContent = row ? '수정 저장' : '저장';
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (row) fillForm(row);
  }

  async function save() {
    const name = document.getElementById('cu-name').value.trim();
    if (!name) { alert('회사명을 입력하세요'); return; }
    const btn = document.getElementById('cu-save-btn');
    if (btn.disabled) return; // 이미 저장 진행 중이면 중복 클릭 무시
    btn.disabled = true;
    try {
      const data = {
        name,
        bizno: document.getElementById('cu-bizno').value,
        ceo: document.getElementById('cu-ceo').value,
        biztype: document.getElementById('cu-biztype').value,
        bizitem: document.getElementById('cu-bizitem').value,
        tel: document.getElementById('cu-tel').value,
        email: document.getElementById('cu-email').value,
        addr: document.getElementById('cu-addr').value,
        memo: document.getElementById('cu-memo').value
      };
      if (editingId) {
        await updateDoc(path(), editingId, data);
      } else {
        await addDoc(path(), data);
      }
      fillForm(null); // 성공 시 버튼 문구는 fillForm이 알맞게 되돌려 놓는다
    } catch (e) {
      alert('저장 중 오류가 발생했습니다: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function remove(id) {
    if (!confirm('이 거래처를 삭제하시겠습니까?')) return;
    await deleteDoc(path(), id);
  }

  /** 다른 화면(매출/매입 등)에서 거래처 목록을 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 거래처 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  return { init, startListening, getCache, onUpdate };
})();

window.CustomersModule = CustomersModule;
