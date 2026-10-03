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
  let openDetailDocNo = null; // 지금 펼쳐져 있는 전표 상세의 docNo (실시간 갱신 시 다시 그리기 위함)
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
      <div class="card" id="pu-list-card">
        <div class="card-title card-title-action" style="display:flex;align-items:center">
          매입 내역
          <button class="ls-btn-primary" id="pu-add-btn" style="margin-left:auto;width:auto">+ 새 매입 등록</button>
        </div>
      </div>
      <div class="card" id="pu-detail-panel" style="margin-top:16px;display:none"></div>

      <div class="side-panel-bg" id="pu-panel-bg" style="display:none">
        <div class="side-panel side-panel-wide">
          <div class="card-title" style="display:flex;align-items:center">
            <span id="pu-panel-title">새 매입 등록</span>
            <span id="pu-docno-badge" class="badge badge-blue" style="display:none;margin-left:8px"></span>
            <button id="pu-panel-close" style="margin-left:auto">✕</button>
          </div>
          <div class="form-grid">
            <div class="fg"><label>날짜 *</label><input id="pu-date" type="date"></div>
            <div class="fg"><label>공급업체 * (이름 입력해서 검색)</label>
              <input id="pu-vendor-name" list="pu-vendor-list" placeholder="공급업체명 입력">
              <datalist id="pu-vendor-list"></datalist>
              <input type="hidden" id="pu-vendor">
            </div>
            <div class="fg"><label>인보이스No.</label><input id="pu-invno"></div>
            <div class="fg" style="grid-column:1/-1"><label>비고</label><input id="pu-memo"></div>
          </div>

          <table class="sl-items-table">
            <thead>
              <tr>
                <th style="text-align:center">No.</th><th>품목명</th><th>규격</th>
                <th style="text-align:right">수량</th><th style="text-align:right">단가</th>
                <th style="text-align:right">공급가액</th><th></th>
              </tr>
            </thead>
            <tbody id="pu-items-container"></tbody>
          </table>
          <datalist id="pu-item-list"></datalist>
          <button type="button" id="pu-add-row-btn" class="sl-add-row-btn">+ 품목 추가</button>

          <div class="sl-doc-totals" id="pu-doc-totals">공급가액 0 + 부가세(10%) 0 = 합계 0</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="ls-btn-primary" id="pu-save-btn" style="width:auto">저장</button>
            <button id="pu-cancel-btn">취소</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('pu-date').value = todayStr();
    addRow();

    document.getElementById('pu-add-btn').addEventListener('click', () => { resetForm(); openPanel(); });
    CustomersModule.bindSearchableSelect('pu-vendor-name', 'pu-vendor', 'pu-vendor-list');
    document.getElementById('pu-panel-close').addEventListener('click', closePanel);
    document.getElementById('pu-panel-bg').addEventListener('click', (e) => {
      if (e.target.id === 'pu-panel-bg') closePanel();
    });
    bindSaveButton(document.getElementById('pu-save-btn'), save, closePanel);
    document.getElementById('pu-cancel-btn').addEventListener('click', closePanel);
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
        { key: 'docNo', label: '전표No.', render: (v) => v ? `<span class="sl-docno-link">${escapeHtml(v)}</span>` : '' },
        { key: 'date', label: '날짜' },
        { key: 'vendor', label: '공급업체' },
        { key: 'item', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'unitPrice', label: '단가', align: 'right', render: (v) => fmtNum(v, '') },
        { key: 'subtotal', label: '공급가액', align: 'right', render: (v) => fmtNum(v) },
        { key: 'vat', label: '부가세', align: 'right', render: (v) => fmtNum(v) },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + fmtNum(v) },
        { key: 'invNo', label: '인보이스No.' },
        { key: 'memo', label: '비고' }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['vendor', 'item', 'docNo'],
      rowId: (row) => row.docNo || row.id, // 전표 있으면 전표No., 없으면(옛 데이터) 그 줄 자체의 id
      onRowClick: (key) => showDetailPanel(key),
      selectable: true,
      onBulkDelete: bulkDelete,
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
      onData: (docs) => {
        cache = sortByDateThenDoc(docs);
        tableInstance.render(groupRows(cache));
        if (openDetailDocNo) showDetailPanel(openDetailDocNo); // 열려있는 전표 상세도 최신 내용으로 갱신
        updateListeners.forEach((cb) => cb(cache));
      }
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
      return (a.docNo || a.id).localeCompare(b.docNo || b.id, undefined, { numeric: true }); // numeric: 'S…-100'이 'S…-99' 뒤로 가도록
    });
  }

  /** 거래처 목록이 바뀔 때(CustomersModule 갱신 시) 다시 호출해 검색 옵션을 최신화합니다. */
  function refreshVendorOptions() {
    CustomersModule.refreshSearchableSelectOptions('pu-vendor-list');
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
    const tr = document.createElement('tr');
    tr.className = 'sl-item-row';
    tr.setAttribute('data-rowkey', key);
    tr.innerHTML = `
      <td><span class="ri-no"></span></td>
      <td><input class="ri-item" list="pu-item-list" placeholder="품목명" value="${escapeHtml(data?.item || '')}"></td>
      <td><input class="ri-spec" placeholder="규격" value="${escapeHtml(data?.spec || '')}"></td>
      <td><input class="ri-qty" type="number" value="${rawNum(data?.qty ?? 1)}"></td>
      <td><input class="ri-price" type="text" inputmode="numeric" value="${fmtNum(data?.unitPrice ?? 0)}"></td>
      <td><span class="ri-subtotal">0</span></td>
      <td><button type="button" class="ri-del" title="이 줄 삭제">✕</button></td>
    `;
    container.appendChild(tr);
    bindCommaInput(tr.querySelector('.ri-price'));
    recalcRow(tr);
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
      rowEl.querySelector('.ri-price').value = (product.price || 0).toLocaleString();
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

  /** 오른쪽 슬라이드 패널을 연다 (새 매입 등록 / 수정 공용). */
  function openPanel() {
    document.getElementById('pu-panel-bg').style.display = 'flex';
  }

  /** 패널을 닫고 폼을 비운다. */
  function closePanel() {
    document.getElementById('pu-panel-bg').style.display = 'none';
    resetForm();
  }

  function resetForm() {
    document.getElementById('pu-date').value = todayStr();
    CustomersModule.setSearchableSelectValue('pu-vendor-name', 'pu-vendor', '');
    document.getElementById('pu-invno').value = '';
    document.getElementById('pu-memo').value = '';
    document.getElementById('pu-items-container').innerHTML = '';
    addRow();
    editingDocNo = null;
    editingIds = [];
    document.getElementById('pu-panel-title').textContent = '새 매입 등록';
    document.getElementById('pu-docno-badge').style.display = 'none';
    document.getElementById('pu-save-btn').textContent = '저장';
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    const group = row.docNo ? cache.filter((r) => r.docNo === row.docNo) : [row];

    document.getElementById('pu-date').value = row.date || '';
    CustomersModule.setSearchableSelectValue('pu-vendor-name', 'pu-vendor', row.vendorId || '');
    document.getElementById('pu-invno').value = row.invNo || '';
    document.getElementById('pu-memo').value = row.memo || '';

    document.getElementById('pu-items-container').innerHTML = '';
    group.forEach((r) => addRow(r));

    editingDocNo = row.docNo || null;
    editingIds = group.map((r) => r.id);

    document.getElementById('pu-panel-title').textContent = '매입 수정';
    const badge = document.getElementById('pu-docno-badge');
    if (row.docNo) { badge.textContent = row.docNo; badge.style.display = ''; }
    else badge.style.display = 'none';

    document.getElementById('pu-save-btn').textContent = '수정 저장';
    recalcTotal();
    openPanel();
  }

  async function save() {
    const date = document.getElementById('pu-date').value;
    const vendorId = document.getElementById('pu-vendor').value;
    if (!date || !vendorId) { alert('날짜, 공급업체는 필수입니다'); return false; }

    const rowEls = Array.from(document.querySelectorAll('#pu-items-container .sl-item-row'));
    const itemRows = rowEls
      .map((el) => ({
        item: el.querySelector('.ri-item').value.trim(),
        spec: el.querySelector('.ri-spec').value.trim(),
        ...rowValues(el)
      }))
      .filter((r) => r.item);

    if (!itemRows.length) { alert('품목을 최소 1개 이상 입력하세요'); return false; }

    const vendor = CustomersModule.getCache().find((c) => c.id === vendorId);
    const invNo = document.getElementById('pu-invno').value;
    const memo = document.getElementById('pu-memo').value;

    let docNo;
    try {
      docNo = editingDocNo || await genDocNo(counterPath(), 'P');
    } catch (err) {
      if (err.code === 'resource-exhausted') {
        alert('지금 저장 요청이 몰려서 전표번호를 받지 못했습니다. 자동으로 몇 차례 다시 시도했지만 실패했어요 — 잠시(1분 정도) 기다렸다가 다시 저장해주세요.');
      } else {
        alert('전표번호 채번 중 오류가 발생했습니다: ' + err.message);
      }
      console.error('[채번 실패]', err);
      return false;
    }

    const removedIds = editingIds.slice();
    const removedProductIds = cache.filter((r) => removedIds.includes(r.id)).map((r) => r.productId);
    const ops = [];
    const addedRows = [];
    removedIds.forEach((id) => ops.push({ type: 'delete', path: path(), id }));
    itemRows.forEach((r) => {
      const product = ProductsModule.findByNameSpec(r.item, r.spec);
      const id = genId();
      const data = {
        docNo, date, vendorId,
        vendor: vendor ? vendor.name : '',
        item: r.item, spec: r.spec,
        productId: product ? product.id : '',
        qty: r.qty, unitPrice: r.price,
        remainingQty: r.qty,
        subtotal: r.subtotal, vat: r.vat, total: r.total,
        invNo, memo
      };
      ops.push({ type: 'set', path: path(), id, data });
      addedRows.push({ id, ...data });
    });

    try {
      await batchWrite(ops);
    } catch (err) {
      alert('저장 중 오류가 발생했습니다: ' + err.message);
      console.error('[저장 실패]', err);
      return false;
    }
    await applyAndRecalc(removedIds, addedRows, removedProductIds.concat(addedRows.map((r) => r.productId)));
    return true;
  }

  /**
   * 매입을 저장·수정·삭제한 직후, 연결된 품목의 FIFO를 자동으로 다시 계산한다.
   * 매입 수정은 문서를 새 id로 다시 만들면서 남은 수량(remainingQty)이 원래
   * 수량으로 돌아가고, 삭제는 이미 팔린 뱃치를 통째로 없애며, 과거 날짜로 넣은
   * 매입은 FIFO 순서를 바꾼다 — 셋 다 그대로 두면 재고금액·매출원가가 틀어진다.
   * 실시간 리스너를 기다리지 않도록 로컬 캐시를 먼저 방금 저장한 내용으로 맞추고,
   * recalcProduct는 값이 실제로 달라진 문서만 저장한다.
   */
  async function applyAndRecalc(removedIds, addedRows, productIds) {
    cache = cache.filter((r) => !removedIds.includes(r.id)).concat(addedRows);
    const ids = Array.from(new Set(productIds.filter(Boolean)));
    const failed = [];
    for (const pid of ids) {
      try {
        await FifoEngine.recalcProduct(pid, { silent: true });
      } catch (err) {
        failed.push(pid);
        console.error('[FIFO 자동 재계산 실패]', pid, err);
      }
    }
    if (failed.length) {
      alert(`저장은 완료됐지만 품목 ${failed.length}개의 재고 재계산에 실패했습니다. 재고현황에서 해당 품목의 "FIFO 재계산"을 눌러주세요.`);
    }
  }

  /** 삭제하려는 매입 줄 중 이미 매출로 출고된 수량의 합계 (삭제 경고용). */
  function soldQtyOf(rows) {
    return rows.reduce((s, r) => s + Math.max(0, (r.qty || 0) - (r.remainingQty !== undefined ? r.remainingQty : r.qty || 0)), 0);
  }

  function deleteConfirmText(label, rows) {
    const sold = soldQtyOf(rows);
    return `${label}을(를) 삭제하시겠습니까?` + (sold > 0
      ? `

⚠️ 이 매입 중 ${sold.toLocaleString()}개가 이미 매출로 출고됐습니다. 삭제하면 관련 품목의 매출원가·재고금액을 자동으로 다시 계산합니다.`
      : '');
  }

  async function deleteRows(rows) {
    await batchWrite(rows.map((r) => ({ type: 'delete', path: path(), id: r.id })));
    await applyAndRecalc(rows.map((r) => r.id), [], rows.map((r) => r.productId));
  }

  async function remove(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    const group = row.docNo ? cache.filter((r) => r.docNo === row.docNo) : [row];
    const label = row.docNo ? `전표 ${row.docNo}(품목 ${group.length}개)` : '이 매입 내역';
    if (!confirm(deleteConfirmText(label, group))) return;
    await deleteRows(group);
  }

  /** 전표 키(전표No. 또는 옛 낱개 레코드의 id) 하나를 실제 문서 묶음으로
   * 되돌린다. docNo로 먼저 찾아보고, 없으면(옛 데이터) 그 id 자체를
   * 단일 문서로 취급한다. */
  function resolveGroupByKey(key) {
    const byDoc = cache.filter((r) => r.docNo === key);
    if (byDoc.length) return byDoc;
    const single = cache.find((r) => r.id === key);
    return single ? [single] : [];
  }

  /** 표 체크박스로 여러 전표(또는 옛 낱개 레코드)를 한 번에 삭제한다. */
  async function bulkDelete(selectedKeys) {
    if (!selectedKeys.length) return;
    const allRows = selectedKeys.flatMap(resolveGroupByKey);
    if (!allRows.length) return;
    if (!confirm(deleteConfirmText(`선택한 ${selectedKeys.length}건(품목 ${allRows.length}줄)`, allRows))) return;
    try {
      await deleteRows(allRows);
    } catch (err) {
      alert('삭제 중 오류가 발생했습니다: ' + err.message);
      console.error('[일괄삭제 실패]', err);
    }
  }

  /** 같은 전표(docNo)로 묶인 여러 품목 줄을 표에서 한 줄로 요약한다.
   * sales.js의 groupRows()와 동일한 로직(용어만 거래처→공급업체). */
  function groupRows(rawRows) {
    const groups = {};
    const order = [];
    rawRows.forEach((r) => {
      const key = r.docNo || ('__single_' + r.id);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });
    return order.map((key) => {
      const group = groups[key];
      if (group.length === 1) return group[0];
      const first = group[0];
      const totals = group.reduce((acc, r) => ({
        subtotal: acc.subtotal + rawNum(r.subtotal), vat: acc.vat + rawNum(r.vat), total: acc.total + rawNum(r.total)
      }), { subtotal: 0, vat: 0, total: 0 });
      return {
        id: first.id, docNo: first.docNo, date: first.date, vendor: first.vendor,
        item: first.item, spec: first.spec,
        qty: first.qty, unitPrice: first.unitPrice,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
        invNo: first.invNo, memo: first.memo
      };
    });
  }

  /** 표에서 전표(행)를 클릭하면 표 바로 아래 카드에 상세 내역을 펼쳐 보여준다
   * (모달 대신 인라인 표시 — daily.js에서 부르는 openDetailModal과는 별개). */
  function showDetailPanel(docNo) {
    if (!docNo) return;
    const group = cache.filter((r) => r.docNo === docNo);
    if (!group.length) return;
    openDetailDocNo = docNo;
    const totals = group.reduce((acc, r) => ({
      subtotal: acc.subtotal + rawNum(r.subtotal), vat: acc.vat + rawNum(r.vat), total: acc.total + rawNum(r.total)
    }), { subtotal: 0, vat: 0, total: 0 });

    const panel = document.getElementById('pu-detail-panel');
    panel.innerHTML = `
      <div class="card-title" style="display:flex">전표 ${escapeHtml(docNo)} 상세
        <button id="pu-detail-close" style="margin-left:auto">✕ 닫기</button>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">
        ${escapeHtml(group[0].date)} · ${escapeHtml(group[0].vendor)}
      </div>
      ${TableEngine.renderStaticTable([
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'item', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right', render: (v) => fmtNum(v) },
        { key: 'unitPrice', label: '단가', align: 'right', render: (v) => fmtNum(v) },
        { key: 'subtotal', label: '공급가액', align: 'right', render: (v) => fmtNum(v) }
      ], group)}
      <div class="sl-doc-totals" style="margin-top:8px">
        공급가액 ${totals.subtotal.toLocaleString()} + 부가세(10%) ${totals.vat.toLocaleString()} = 합계 ${totals.total.toLocaleString()}
      </div>
    `;
    panel.style.display = 'block';
    document.getElementById('pu-detail-close').addEventListener('click', () => { panel.style.display = 'none'; openDetailDocNo = null; });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** 재고(stock.js)·일별현황(daily.js)·대시보드에서 매입 데이터를 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 매입 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  /** 로그아웃 시 호출 — 이전 계정의 매입 목록·펼쳐둔 전표 상세가 남아 보이지 않도록 비운다. */
  function clearData() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    closePanel();
    cache = [];
    openDetailDocNo = null;
    const detail = document.getElementById('pu-detail-panel');
    detail.style.display = 'none';
    detail.innerHTML = '';
    tableInstance.render(cache);
    updateListeners.forEach((cb) => cb(cache));
  }

  return { init, startListening, getCache, onUpdate, refreshVendorOptions, refreshItemDatalist, showDetailPanel, clearData };
})();

window.PurchaseModule = PurchaseModule;
