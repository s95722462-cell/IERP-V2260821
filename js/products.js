// ══════════════════════════════════════════════════════════════
// products.js — 품목 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js
// 데이터 경로: users/{safeId}/companies/{companyId}/products/{id}
// ══════════════════════════════════════════════════════════════

const ProductsModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingId = null;
  let unsubscribe = null;
  let updateListeners = [];

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/products`;
  }

  function init() {
    const panel = LayoutShell.registerPanel('products');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">🔧 품목 등록 / 수정</div>
        <div class="form-grid">
          <div class="fg"><label>품목코드</label><input id="pr-code"></div>
          <div class="fg"><label>품목명 *</label><input id="pr-name" placeholder="부품명/모델명"></div>
          <div class="fg"><label>규격/사양</label><input id="pr-spec"></div>
          <div class="fg"><label>제조사</label><input id="pr-maker"></div>
          <div class="fg"><label>기준단가</label><input id="pr-price" type="number" value="0"></div>
          <div class="fg"><label>단위</label><input id="pr-unit" placeholder="EA/SET/BOX"></div>
          <div class="fg"><label>초기재고</label><input id="pr-initstock" type="number" value="0"></div>
          <div class="fg"><label>안전재고(경고기준)</label><input id="pr-safestock" type="number" value="0"></div>
          <div class="fg" style="grid-column:1/-1"><label>메모</label><input id="pr-memo"></div>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="ls-btn-primary" id="pr-save-btn" style="width:auto">저장</button>
          <button id="pr-cancel-btn" style="display:none">취소</button>
        </div>
      </div>
      <div class="card" id="pr-list-card" style="margin-top:16px">
        <div class="card-title">품목 목록</div>
      </div>
    `;

    document.getElementById('pr-save-btn').addEventListener('click', save);
    document.getElementById('pr-cancel-btn').addEventListener('click', () => fillForm(null));

    tableInstance = TableEngine.create('products', {
      container: document.getElementById('pr-list-card'),
      columns: [
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'code', label: '코드' },
        { key: 'name', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'maker', label: '제조사' },
        { key: 'price', label: '기준단가', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() },
        { key: 'unit', label: '단위' },
        { key: 'safeStock', label: '안전재고', align: 'right' },
        { key: 'memo', label: '메모' }
      ],
      searchFields: ['name', 'code', 'spec'],
      rowActions: (row) => `
        <button data-act="edit" data-id="${row.id}">수정</button>
        <button data-act="del" data-id="${row.id}">삭제</button>`
    });

    document.getElementById('pr-list-card').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') startEdit(id);
      if (btn.getAttribute('data-act') === 'del') remove(id);
    });
  }

  function startListening() {
    if (unsubscribe) unsubscribe();
    unsubscribe = DbEngine.listen(path(), {
      orderBy: { field: 'createdAt', direction: 'desc' },
      onData: (docs) => { cache = docs; tableInstance.render(cache); updateListeners.forEach((cb) => cb(cache)); }
    });
  }

  function fillForm(row) {
    document.getElementById('pr-code').value = row?.code || '';
    document.getElementById('pr-name').value = row?.name || '';
    document.getElementById('pr-spec').value = row?.spec || '';
    document.getElementById('pr-maker').value = row?.maker || '';
    document.getElementById('pr-price').value = row?.price ?? 0;
    document.getElementById('pr-unit').value = row?.unit || '';
    document.getElementById('pr-initstock').value = row?.initStock ?? 0;
    document.getElementById('pr-safestock').value = row?.safeStock ?? 0;
    document.getElementById('pr-memo').value = row?.memo || '';
    editingId = row ? row.id : null;
    document.getElementById('pr-cancel-btn').style.display = row ? '' : 'none';
    document.getElementById('pr-save-btn').textContent = row ? '수정 저장' : '저장';
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (row) fillForm(row);
  }

  async function save() {
    const name = document.getElementById('pr-name').value.trim();
    if (!name) { alert('품목명을 입력하세요'); return; }
    const data = {
      code: document.getElementById('pr-code').value,
      name,
      spec: document.getElementById('pr-spec').value,
      maker: document.getElementById('pr-maker').value,
      price: rawNum(document.getElementById('pr-price').value),
      unit: document.getElementById('pr-unit').value,
      initStock: rawNum(document.getElementById('pr-initstock').value),
      safeStock: rawNum(document.getElementById('pr-safestock').value),
      memo: document.getElementById('pr-memo').value
    };
    if (editingId) {
      await updateDoc(path(), editingId, data);
    } else {
      await addDoc(path(), data);
    }
    fillForm(null);
  }

  async function remove(id) {
    if (!confirm('이 품목을 삭제하시겠습니까?')) return;
    await deleteDoc(path(), id);
  }

  /** 다른 화면(매출/매입/재고)에서 품목 목록을 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 품목 데이터가 바뀔 때마다 호출될 콜백을 등록합니다 (재고 화면이 사용). */
  function onUpdate(cb) { updateListeners.push(cb); }

  /** 이름+규격으로 등록된 품목을 정확히 찾습니다 (자동완성 매칭용). */
  function findByNameSpec(name, spec) {
    return cache.find((p) => p.name === name && (p.spec || '') === (spec || ''));
  }

  return { init, startListening, getCache, onUpdate, findByNameSpec };
})();

window.ProductsModule = ProductsModule;
