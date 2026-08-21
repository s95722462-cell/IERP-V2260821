// ══════════════════════════════════════════════════════════════
// sales.js — 매출 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js,
//         customers.js, products.js
// 데이터 경로: users/{safeId}/companies/{companyId}/sales/{id}
//
// 설계 원칙 (1.0에서 배운 것):
//   - 부가세는 모든 매출에 항상 10% 자동 계산 (통화 구분 없음 — 요구사항
//     정의서 확정 사항). 수정 화면에서도 항상 같은 방식으로 재계산되므로
//     "수정할 때만 세액이 0으로 초기화되는" 유형의 버그가 구조적으로 없다.
//   - 품목 자동완성으로 선택하면 반드시 productId를 저장해 재고 계산이
//     정확히 매칭되게 한다 (이름 문자열만 비교하지 않음).
// ══════════════════════════════════════════════════════════════

const SalesModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingId = null;
  let unsubscribe = null;
  let updateListeners = [];

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/sales`;
  }

  function init() {
    const panel = LayoutShell.registerPanel('sales');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">📈 매출 등록 / 수정</div>
        <div class="form-grid">
          <div class="fg"><label>날짜 *</label><input id="sl-date" type="date"></div>
          <div class="fg"><label>거래처 *</label>
            <select id="sl-buyer"><option value="">— 선택 —</option></select>
          </div>
          <div class="fg"><label>품목명 *</label><input id="sl-item" list="sl-item-list"></div>
          <datalist id="sl-item-list"></datalist>
          <div class="fg"><label>규격</label><input id="sl-spec"></div>
          <div class="fg"><label>수량 *</label><input id="sl-qty" type="number" value="1"></div>
          <div class="fg"><label>단가 *</label><input id="sl-price" type="number" value="0"></div>
          <div class="fg"><label>인보이스No.</label><input id="sl-invno"></div>
          <div class="fg" style="grid-column:1/-1"><label>비고</label><input id="sl-memo"></div>
        </div>
        <div class="sl-calc" id="sl-calc">공급가액 0 + 부가세(10%) 0 = 합계 0</div>
        <div class="btn-row" style="margin-top:10px">
          <button class="ls-btn-primary" id="sl-save-btn" style="width:auto">저장</button>
          <button id="sl-cancel-btn" style="display:none">취소</button>
        </div>
      </div>
      <div class="card" id="sl-list-card" style="margin-top:16px">
        <div class="card-title">매출 내역</div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">📄 거래명세서 발행</div>
        <div class="form-grid">
          <div class="fg"><label>거래처</label><select id="sl-inv-buyer"><option value="">— 선택 —</option></select></div>
          <div class="fg"><label>시작일</label><input id="sl-inv-from" type="date"></div>
          <div class="fg"><label>종료일</label><input id="sl-inv-to" type="date"></div>
        </div>
        <button class="ls-btn-primary" id="sl-inv-btn" style="width:auto;margin-top:8px">PDF 생성</button>
      </div>
    `;

    document.getElementById('sl-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('sl-save-btn').addEventListener('click', save);
    document.getElementById('sl-cancel-btn').addEventListener('click', () => fillForm(null));
    document.getElementById('sl-item').addEventListener('change', onItemPick);
    ['sl-qty', 'sl-price'].forEach((id) => document.getElementById(id).addEventListener('input', updateCalc));
    document.getElementById('sl-inv-btn').addEventListener('click', () => {
      InvoiceModule.generate({
        buyerId: document.getElementById('sl-inv-buyer').value,
        dateFrom: document.getElementById('sl-inv-from').value,
        dateTo: document.getElementById('sl-inv-to').value
      });
    });

    tableInstance = TableEngine.create('sales', {
      container: document.getElementById('sl-list-card'),
      columns: [
        { key: 'date', label: '날짜' },
        { key: 'buyer', label: '거래처' },
        { key: 'item', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'unitPrice', label: '단가', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'subtotal', label: '공급가액', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'vat', label: '부가세', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() },
        { key: 'invNo', label: '인보이스No.' },
        { key: 'memo', label: '비고' }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['buyer', 'item'],
      rowActions: (row) => `
        <button data-act="edit" data-id="${row.id}">수정</button>
        <button data-act="del" data-id="${row.id}">삭제</button>`
    });

    document.getElementById('sl-list-card').addEventListener('click', (e) => {
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
      orderBy: { field: 'date', direction: 'desc' },
      onData: (docs) => { cache = docs; tableInstance.render(cache); updateListeners.forEach((cb) => cb(cache)); }
    });
    refreshBuyerOptions();
    refreshItemDatalist();
  }

  /** 거래처 목록이 바뀔 때(CustomersModule 갱신 시) 다시 호출해 드롭다운을 최신화합니다. */
  function refreshBuyerOptions() {
    const options = '<option value="">— 선택 —</option>' +
      CustomersModule.getCache().map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
    ['sl-buyer', 'sl-inv-buyer'].forEach((id) => {
      const sel = document.getElementById(id);
      const cur = sel.value;
      sel.innerHTML = options;
      sel.value = cur;
    });
  }

  /** 품목 목록이 바뀔 때(ProductsModule 갱신 시) 다시 호출해 자동완성을 최신화합니다. */
  function refreshItemDatalist() {
    const dl = document.getElementById('sl-item-list');
    const products = ProductsModule.getCache();
    dl.innerHTML = products.map((p) =>
      `<option value="${escapeHtml(p.name)}${p.spec ? ' (' + escapeHtml(p.spec) + ')' : ''}">`
    ).join('');
  }

  /** 자동완성에서 "품목명 (규격)"을 선택하면 이름/규격/단가를 각 칸에 정확히 분리해 채운다. */
  function onItemPick() {
    const raw = document.getElementById('sl-item').value;
    const { name, hint } = splitNameAndHint(raw);
    let product = ProductsModule.findByNameSpec(name, hint) || ProductsModule.getCache().find((p) => p.name === name);
    if (product) {
      document.getElementById('sl-item').value = product.name;
      document.getElementById('sl-spec').value = product.spec || '';
      document.getElementById('sl-price').value = product.price || 0;
    }
    updateCalc();
  }

  function updateCalc() {
    const qty = rawNum(document.getElementById('sl-qty').value);
    const price = rawNum(document.getElementById('sl-price').value);
    const subtotal = qty * price;
    const vat = Math.round(subtotal * 0.1); // 항상 10% (통화 구분 없음 — 요구사항 확정 사항)
    const total = subtotal + vat;
    document.getElementById('sl-calc').textContent =
      `공급가액 ${subtotal.toLocaleString()} + 부가세(10%) ${vat.toLocaleString()} = 합계 ${total.toLocaleString()}`;
    return { subtotal, vat, total };
  }

  function fillForm(row) {
    document.getElementById('sl-date').value = row?.date || new Date().toISOString().slice(0, 10);
    document.getElementById('sl-buyer').value = row?.buyerId || '';
    document.getElementById('sl-item').value = row?.item || '';
    document.getElementById('sl-spec').value = row?.spec || '';
    document.getElementById('sl-qty').value = row?.qty ?? 1;
    document.getElementById('sl-price').value = row?.unitPrice ?? 0;
    document.getElementById('sl-invno').value = row?.invNo || '';
    document.getElementById('sl-memo').value = row?.memo || '';
    editingId = row ? row.id : null;
    document.getElementById('sl-cancel-btn').style.display = row ? '' : 'none';
    document.getElementById('sl-save-btn').textContent = row ? '수정 저장' : '저장';
    updateCalc();
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (row) fillForm(row);
  }

  async function save() {
    const date = document.getElementById('sl-date').value;
    const buyerId = document.getElementById('sl-buyer').value;
    const item = document.getElementById('sl-item').value.trim();
    if (!date || !buyerId || !item) { alert('날짜, 거래처, 품목명은 필수입니다'); return; }

    const buyer = CustomersModule.getCache().find((c) => c.id === buyerId);
    const product = ProductsModule.findByNameSpec(item, document.getElementById('sl-spec').value);
    const { subtotal, vat, total } = updateCalc();

    const data = {
      date,
      buyerId,
      buyer: buyer ? buyer.name : '',
      item,
      spec: document.getElementById('sl-spec').value,
      productId: product ? product.id : '',
      qty: rawNum(document.getElementById('sl-qty').value),
      unitPrice: rawNum(document.getElementById('sl-price').value),
      subtotal, vat, total,
      invNo: document.getElementById('sl-invno').value,
      memo: document.getElementById('sl-memo').value
    };

    if (editingId) {
      await updateDoc(path(), editingId, data);
    } else {
      await addDoc(path(), data);
    }
    fillForm(null);
  }

  async function remove(id) {
    if (!confirm('이 매출 내역을 삭제하시겠습니까?')) return;
    await deleteDoc(path(), id);
  }

  /** 재고(stock.js)·일별현황(daily.js)·대시보드에서 매출 데이터를 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 매출 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  return { init, startListening, getCache, onUpdate, refreshBuyerOptions, refreshItemDatalist };
})();

window.SalesModule = SalesModule;
