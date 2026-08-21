// ══════════════════════════════════════════════════════════════
// purchase.js — 매입 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js,
//         customers.js, products.js
// 데이터 경로: users/{safeId}/companies/{companyId}/purchases/{id}
//             users/{safeId}/companies/{companyId}/counters/{P+날짜}  (전표번호 채번용)
//
// sales.js와 구조가 대칭입니다 (거래처→공급업체, buyer→vendor, 접두사 S→P).
// "전표(docNo) = 품목 여러 줄" 구조는 sales.js와 동일한 원칙을 따릅니다 —
// 자세한 설계 배경은 sales.js 주석 참고.
// ══════════════════════════════════════════════════════════════

const PurchaseModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingDocNo = null;
  let editingIds = [];
  let unsubscribe = null;
  let updateListeners = [];
  let rowSeq = 0;

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/purchases`;
  }
  function counterPath() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/counters`;
  }

  function init() {
    const panel = LayoutShell.registerPanel('purchase');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">📥 매입 등록 / 수정 <span id="pu-docno-badge" class="badge badge-blue" style="display:none"></span></div>
        <div class="form-grid">
          <div class="fg"><label>날짜 *</label><input id="pu-date" type="date"></div>
          <div class="fg"><label>공급업체 *</label>
            <select id="pu-vendor"><option value="">— 선택 —</option></select>
          </div>
          <div class="fg"><label>인보이스No.</label><input id="pu-invno"></div>
          <div class="fg" style="grid-column:1/-1"><label>비고</label><input id="pu-memo"></div>
        </div>

        <div class="sl-items-head">
          <div>No.</div><div>품목명</div><div>규격</div><div>수량</div><div>단가</div><div>공급가액</div><div></div>
        </div>
        <div id="pu-items-container"></div>
        <datalist id="pu-item-list"></datalist>
        <button type="button" id="pu-add-row-btn" class="sl-add-row-btn">+ 품목 추가</button>

        <div class="sl-doc-totals" id="pu-doc-totals">공급가액 0 + 부가세(10%) 0 = 합계 0</div>
        <div class="btn-row" style="margin-top:10px">
          <button class="ls-btn-primary" id="pu-save-btn" style="width:auto">저장</button>
          <button id="pu-cancel-btn" style="display:none">취소</button>
        </div>
      </div>
      <div class="card" id="pu-list-card" style="margin-top:16px">
        <div class="card-title">매입 내역</div>
      </div>
    `;

    document.getElementById('pu-date').value = todayStr();
    addRow();

    document.getElementById('pu-save-btn').addEventListener('click', save);
    document.getElementById('pu-cancel-btn').addEventListener('click', resetForm);
    document.getElementById('pu-add-row-btn').addEventListener('click', () => addRow());

    const itemsContainer = document.getElementById('pu-items-container');
    itemsContainer.addEventListener('input', (e) => {
      if (e.target.classList.contains('ri-qty') || e.target.classList.contains('ri-price')) {
        recalcRow(e.target.closest('.sl-item-row'));
      }
    });
    itemsContainer.addEventListener('change', (e) => {
      if (e.target.classList.contains('ri-item')) onItemPick(e.target.closest('.sl-item-row'));
    });
    itemsContainer.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.ri-del');
      if (delBtn) removeRow(delBtn.closest('.sl-item-row'));
    });

    tableInstance = TableEngine.create('purchase', {
      container: document.getElementById('pu-list-card'),
      columns: [
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'docNo', label: '전표No.', render: (v) => v ? `<button class="sl-docno-link" data-docno="${escapeHtml(v)}">${escapeHtml(v)}</button>` : '' },
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
      searchFields: ['vendor', 'item', 'docNo'],
      rowActions: (row) => `
        <button data-act="edit" data-id="${row.id}">수정</button>
        <button data-act="del" data-id="${row.id}">삭제</button>`
    });

    document.getElementById('pu-list-card').addEventListener('click', (e) => {
      const docBtn = e.target.closest('.sl-docno-link');
      if (docBtn) { openDetailModal(docBtn.getAttribute('data-docno')); return; }
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
      onData: (docs) => { cache = sortByDateThenDoc(docs); tableInstance.render(cache); updateListeners.forEach((cb) => cb(cache)); }
    });
    refreshVendorOptions();
    refreshItemDatalist();
  }

  /** 날짜로 정렬한 뒤, 같은 전표(docNo)의 품목 줄들이 표에서 서로 떨어지지
   * 않고 붙어서 보이도록 전표No.를 2차 정렬 기준으로 쓴다. */
  function sortByDateThenDoc(docs) {
    return docs.slice().sort((a, b) => {
      const d = (b.date || '').localeCompare(a.date || '');
      if (d !== 0) return d;
      return (a.docNo || a.id).localeCompare(b.docNo || b.id);
    });
  }

  /** 거래처 목록이 바뀔 때(CustomersModule 갱신 시) 다시 호출해 드롭다운을 최신화합니다. */
  function refreshVendorOptions() {
    const sel = document.getElementById('pu-vendor');
    const cur = sel.value;
    const customers = CustomersModule.getCache();
    sel.innerHTML = '<option value="">— 선택 —</option>' +
      customers.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
    sel.value = cur;
  }

  /** 품목 목록이 바뀔 때(ProductsModule 갱신 시) 다시 호출해 자동완성을 최신화합니다. */
  function refreshItemDatalist() {
    const dl = document.getElementById('pu-item-list');
    const products = ProductsModule.getCache();
    dl.innerHTML = products.map((p) =>
      `<option value="${escapeHtml(p.name)}${p.spec ? ' (' + escapeHtml(p.spec) + ')' : ''}">`
    ).join('');
  }

  // ── 품목 줄(행) 관리 ──────────────────────────────────────

  function addRow(data) {
    const key = 'r' + (++rowSeq);
    const container = document.getElementById('pu-items-container');
    const div = document.createElement('div');
    div.className = 'sl-item-row';
    div.setAttribute('data-rowkey', key);
    div.innerHTML = `
      <span class="ri-no"></span>
      <input class="ri-item" list="pu-item-list" placeholder="품목명" value="${escapeHtml(data?.item || '')}">
      <input class="ri-spec" placeholder="규격" value="${escapeHtml(data?.spec || '')}">
      <input class="ri-qty" type="number" value="${data?.qty ?? 1}">
      <input class="ri-price" type="number" value="${data?.unitPrice ?? 0}">
      <span class="ri-subtotal">0</span>
      <button type="button" class="ri-del" title="이 줄 삭제">✕</button>
    `;
    container.appendChild(div);
    recalcRow(div);
    renumberRows();
  }

  function renumberRows() {
    document.querySelectorAll('#pu-items-container .sl-item-row').forEach((row, idx) => {
      const noEl = row.querySelector('.ri-no');
      if (noEl) noEl.textContent = idx + 1;
    });
  }

  function removeRow(rowEl) {
    const container = document.getElementById('pu-items-container');
    if (container.children.length <= 1) { alert('최소 한 줄은 있어야 합니다'); return; }
    rowEl.remove();
    recalcTotal();
    renumberRows();
  }

  /** 자동완성에서 "품목명 (규격)"을 고르면 이름/규격/단가를 그 줄에 정확히 채운다. */
  function onItemPick(rowEl) {
    const raw = rowEl.querySelector('.ri-item').value;
    const { name, hint } = splitNameAndHint(raw);
    let product = ProductsModule.findByNameSpec(name, hint) || ProductsModule.getCache().find((p) => p.name === name);
    if (product) {
      rowEl.querySelector('.ri-item').value = product.name;
      rowEl.querySelector('.ri-spec').value = product.spec || '';
      rowEl.querySelector('.ri-price').value = product.price || 0;
    }
    recalcRow(rowEl);
  }

  function rowValues(rowEl) {
    const qty = rawNum(rowEl.querySelector('.ri-qty').value);
    const price = rawNum(rowEl.querySelector('.ri-price').value);
    const subtotal = qty * price;
    const vat = Math.round(subtotal * 0.1);
    const total = subtotal + vat;
    return { qty, price, subtotal, vat, total };
  }

  function recalcRow(rowEl) {
    const { subtotal } = rowValues(rowEl);
    rowEl.querySelector('.ri-subtotal').textContent = subtotal.toLocaleString();
    recalcTotal();
  }

  function recalcTotal() {
    const rows = document.querySelectorAll('#pu-items-container .sl-item-row');
    let subtotal = 0, vat = 0, total = 0;
    rows.forEach((r) => {
      const v = rowValues(r);
      subtotal += v.subtotal; vat += v.vat; total += v.total;
    });
    document.getElementById('pu-doc-totals').textContent =
      `공급가액 ${subtotal.toLocaleString()} + 부가세(10%) ${vat.toLocaleString()} = 합계 ${total.toLocaleString()}`;
  }

  // ── 등록/수정 폼 전체 ──────────────────────────────────────

  function resetForm() {
    document.getElementById('pu-date').value = todayStr();
    document.getElementById('pu-vendor').value = '';
    document.getElementById('pu-invno').value = '';
    document.getElementById('pu-memo').value = '';
    document.getElementById('pu-items-container').innerHTML = '';
    addRow();
    editingDocNo = null;
    editingIds = [];
    document.getElementById('pu-docno-badge').style.display = 'none';
    document.getElementById('pu-cancel-btn').style.display = 'none';
    document.getElementById('pu-save-btn').textContent = '저장';
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    const group = row.docNo ? cache.filter((r) => r.docNo === row.docNo) : [row];

    document.getElementById('pu-date').value = row.date || '';
    document.getElementById('pu-vendor').value = row.vendorId || '';
    document.getElementById('pu-invno').value = row.invNo || '';
    document.getElementById('pu-memo').value = row.memo || '';

    document.getElementById('pu-items-container').innerHTML = '';
    group.forEach((r) => addRow(r));

    editingDocNo = row.docNo || null;
    editingIds = group.map((r) => r.id);

    const badge = document.getElementById('pu-docno-badge');
    if (row.docNo) { badge.textContent = row.docNo; badge.style.display = ''; }
    else badge.style.display = 'none';

    document.getElementById('pu-cancel-btn').style.display = '';
    document.getElementById('pu-save-btn').textContent = '수정 저장';
    recalcTotal();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save() {
    const date = document.getElementById('pu-date').value;
    const vendorId = document.getElementById('pu-vendor').value;
    if (!date || !vendorId) { alert('날짜, 공급업체는 필수입니다'); return; }

    const rowEls = Array.from(document.querySelectorAll('#pu-items-container .sl-item-row'));
    const itemRows = rowEls
      .map((el) => ({
        item: el.querySelector('.ri-item').value.trim(),
        spec: el.querySelector('.ri-spec').value.trim(),
        ...rowValues(el)
      }))
      .filter((r) => r.item);

    if (!itemRows.length) { alert('품목을 최소 1개 이상 입력하세요'); return; }

    const vendor = CustomersModule.getCache().find((c) => c.id === vendorId);
    const invNo = document.getElementById('pu-invno').value;
    const memo = document.getElementById('pu-memo').value;

    const docNo = editingDocNo || await genDocNo(counterPath(), 'P');

    const ops = [];
    editingIds.forEach((id) => ops.push({ type: 'delete', path: path(), id }));
    itemRows.forEach((r) => {
      const product = ProductsModule.findByNameSpec(r.item, r.spec);
      ops.push({
        type: 'set', path: path(), id: genId(),
        data: {
          docNo, date, vendorId,
          vendor: vendor ? vendor.name : '',
          item: r.item, spec: r.spec,
          productId: product ? product.id : '',
          qty: r.qty, unitPrice: r.price,
          subtotal: r.subtotal, vat: r.vat, total: r.total,
          invNo, memo
        }
      });
    });

    await batchWrite(ops);
    resetForm();
  }

  async function remove(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    const group = row.docNo ? cache.filter((r) => r.docNo === row.docNo) : [row];
    const label = row.docNo ? `전표 ${row.docNo}(품목 ${group.length}개)` : '이 매입 내역';
    if (!confirm(`${label}을(를) 삭제하시겠습니까?`)) return;
    await batchWrite(group.map((r) => ({ type: 'delete', path: path(), id: r.id })));
  }

  /** 전표번호를 클릭했을 때 뜨는 상세보기 모달. */
  function openDetailModal(docNo) {
    const group = cache.filter((r) => r.docNo === docNo);
    if (!group.length) return;
    const totals = group.reduce((acc, r) => ({
      subtotal: acc.subtotal + (r.subtotal || 0), vat: acc.vat + (r.vat || 0), total: acc.total + (r.total || 0)
    }), { subtotal: 0, vat: 0, total: 0 });

    let modal = document.getElementById('pu-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'pu-detail-modal';
      modal.className = 'te-modal-bg';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="te-modal" style="width:520px;max-width:92vw">
        <div class="te-modal-title">전표 ${escapeHtml(docNo)} 상세 <button class="te-modal-close" data-role="close">✕</button></div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px">
          ${escapeHtml(group[0].date)} · ${escapeHtml(group[0].vendor)}
        </div>
        <table class="inv-table" style="width:100%;font-size:12px">
          <thead><tr><th>품목명</th><th>규격</th><th>수량</th><th>단가</th><th>공급가액</th></tr></thead>
          <tbody>
            ${group.map((r) => `
              <tr>
                <td>${escapeHtml(r.item)}</td><td>${escapeHtml(r.spec || '')}</td>
                <td style="text-align:right">${(r.qty || 0).toLocaleString()}</td>
                <td style="text-align:right">${(r.unitPrice || 0).toLocaleString()}</td>
                <td style="text-align:right">${(r.subtotal || 0).toLocaleString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="sl-doc-totals" style="margin-top:8px">
          공급가액 ${totals.subtotal.toLocaleString()} + 부가세(10%) ${totals.vat.toLocaleString()} = 합계 ${totals.total.toLocaleString()}
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    modal.querySelector('[data-role="close"]').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });
  }

  /** 재고(stock.js)·일별현황(daily.js)·대시보드에서 매입 데이터를 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 매입 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  return { init, startListening, getCache, onUpdate, refreshVendorOptions, refreshItemDatalist, openDetailModal };
})();

window.PurchaseModule = PurchaseModule;
