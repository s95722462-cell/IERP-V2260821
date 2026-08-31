// ══════════════════════════════════════════════════════════════
// purchase.js — 매입 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js,
//         customers.js, products.js
// 데이터 경로: users/{safeId}/companies/{companyId}/purchases/{id}
//
// sales.js와 구조가 대칭입니다 (거래처→공급업체, buyer→vendor).
// ══════════════════════════════════════════════════════════════

const PurchaseModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingId = null;
  let unsubscribe = null;
  let updateListeners = [];

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/purchases`;
  }

  function init() {
    const panel = LayoutShell.registerPanel('purchase');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">📥 매입 등록 / 수정</div>
        <div class="form-grid">
          <div class="fg"><label>날짜 *</label><input id="pu-date" type="date"></div>
          <div class="fg"><label>공급업체 *</label>
            <select id="pu-vendor"><option value="">— 선택 —</option></select>
          </div>
          <div class="fg"><label>품목명 *</label><input id="pu-item" list="pu-item-list"></div>
          <datalist id="pu-item-list"></datalist>
          <div class="fg"><label>규격</label><input id="pu-spec"></div>
          <div class="fg"><label>수량 *</label><input id="pu-qty" type="number" value="1"></div>
          <div class="fg"><label>단가 *</label><input id="pu-price" type="number" value="0"></div>
          <div class="fg"><label>인보이스No.</label><input id="pu-invno"></div>
          <div class="fg" style="grid-column:1/-1"><label>비고</label><input id="pu-memo"></div>
        </div>
        <div class="sl-calc" id="pu-calc">공급가액 0 + 부가세(10%) 0 = 합계 0</div>
        <div class="btn-row" style="margin-top:10px">
          <button class="ls-btn-primary" id="pu-save-btn" style="width:auto">저장</button>
          <button id="pu-cancel-btn" style="display:none">취소</button>
        </div>
      </div>
      <div class="card" id="pu-list-card" style="margin-top:16px">
        <div class="card-title">매입 내역</div>
      </div>
    `;

    document.getElementById('pu-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('pu-save-btn').addEventListener('click', save);
    document.getElementById('pu-cancel-btn').addEventListener('click', () => fillForm(null));
    document.getElementById('pu-item').addEventListener('change', onItemPick);
    ['pu-qty', 'pu-price'].forEach((id) => document.getElementById(id).addEventListener('input', updateCalc));

    tableInstance = TableEngine.create('purchase', {
      container: document.getElementById('pu-list-card'),
      columns: [
        { key: 'date', label: '날짜' },
        { key: 'vendor', label: '공급업체' },
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
      searchFields: ['vendor', 'item'],
      rowActions: (row) => `
        <button data-act="edit" data-id="${row.id}">수정</button>
        <button data-act="del" data-id="${row.id}">삭제</button>`
    });

    document.getElementById('pu-list-card').addEventListener('click', (e) => {
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
    refreshVendorOptions();
    refreshItemDatalist();
  }

  function refreshVendorOptions() {
    const sel = document.getElementById('pu-vendor');
    const cur = sel.value;
    const customers = CustomersModule.getCache();
    sel.innerHTML = '<option value="">— 선택 —</option>' +
      customers.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
    sel.value = cur;
  }

  function refreshItemDatalist() {
    const dl = document.getElementById('pu-item-list');
    const products = ProductsModule.getCache();
    dl.innerHTML = products.map((p) =>
      `<option value="${escapeHtml(p.name)}${p.spec ? ' (' + escapeHtml(p.spec) + ')' : ''}">`
    ).join('');
  }

  function onItemPick() {
    const raw = document.getElementById('pu-item').value;
    const { name, hint } = splitNameAndHint(raw);
    let product = ProductsModule.findByNameSpec(name, hint) || ProductsModule.getCache().find((p) => p.name === name);
    if (product) {
      document.getElementById('pu-item').value = product.name;
      document.getElementById('pu-spec').value = product.spec || '';
      document.getElementById('pu-price').value = product.price || 0;
    }
    updateCalc();
  }

  function updateCalc() {
    const qty = rawNum(document.getElementById('pu-qty').value);
    const price = rawNum(document.getElementById('pu-price').value);
    const subtotal = qty * price;
    const vat = Math.round(subtotal * 0.1);
    const total = subtotal + vat;
    document.getElementById('pu-calc').textContent =
      `공급가액 ${subtotal.toLocaleString()} + 부가세(10%) ${vat.toLocaleString()} = 합계 ${total.toLocaleString()}`;
    return { subtotal, vat, total };
  }

  function fillForm(row) {
    document.getElementById('pu-date').value = row?.date || new Date().toISOString().slice(0, 10);
    document.getElementById('pu-vendor').value = row?.vendorId || '';
    document.getElementById('pu-item').value = row?.item || '';
    document.getElementById('pu-spec').value = row?.spec || '';
    document.getElementById('pu-qty').value = row?.qty ?? 1;
    document.getElementById('pu-price').value = row?.unitPrice ?? 0;
    document.getElementById('pu-invno').value = row?.invNo || '';
    document.getElementById('pu-memo').value = row?.memo || '';
    editingId = row ? row.id : null;
    document.getElementById('pu-cancel-btn').style.display = row ? '' : 'none';
    document.getElementById('pu-save-btn').textContent = row ? '수정 저장' : '저장';
    updateCalc();
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (row) fillForm(row);
  }

  async function save() {
    const date = document.getElementById('pu-date').value;
    const vendorId = document.getElementById('pu-vendor').value;
    const item = document.getElementById('pu-item').value.trim();
    if (!date || !vendorId || !item) { alert('날짜, 공급업체, 품목명은 필수입니다'); return; }

    const btn = document.getElementById('pu-save-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const vendor = CustomersModule.getCache().find((c) => c.id === vendorId);
      const product = ProductsModule.findByNameSpec(item, document.getElementById('pu-spec').value);
      const { subtotal, vat, total } = updateCalc();

      const data = {
        date,
        vendorId,
        vendor: vendor ? vendor.name : '',
        item,
        spec: document.getElementById('pu-spec').value,
        productId: product ? product.id : '',
        qty: rawNum(document.getElementById('pu-qty').value),
        unitPrice: rawNum(document.getElementById('pu-price').value),
        subtotal, vat, total,
        invNo: document.getElementById('pu-invno').value,
        memo: document.getElementById('pu-memo').value
      };

      if (editingId) {
        await updateDoc(path(), editingId, data);
      } else {
        await addDoc(path(), data);
      }
      fillForm(null);
    } catch (e) {
      alert('저장 중 오류가 발생했습니다: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function remove(id) {
    if (!confirm('이 매입 내역을 삭제하시겠습니까?')) return;
    await deleteDoc(path(), id);
  }

  /** 재고(stock.js)·일별현황(daily.js)·대시보드에서 매입 데이터를 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 매입 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  return { init, startListening, getCache, onUpdate, refreshVendorOptions, refreshItemDatalist };
})();

window.PurchaseModule = PurchaseModule;
