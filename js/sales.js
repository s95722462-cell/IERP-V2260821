// ══════════════════════════════════════════════════════════════
// sales.js — 매출 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js,
//         customers.js, products.js, invoice.js
// 데이터 경로: users/{safeId}/companies/{companyId}/sales/{id}
//             users/{safeId}/companies/{companyId}/counters/{S+날짜}  (전표번호 채번용)
//
// 설계 원칙 (1.0에서 배운 것 + 이번 개편):
//   - 부가세는 모든 매출에 항상 10% 자동 계산 (통화 구분 없음 — 요구사항
//     정의서 확정 사항).
//   - 품목 자동완성으로 선택하면 반드시 productId를 저장해 재고 계산이
//     정확히 매칭되게 한다 (이름 문자열만 비교하지 않음).
//   - "전표(docNo) = 품목 여러 줄" 구조: 실제 저장은 여전히 sales 컬렉션에
//     품목 한 줄 = 문서 한 개(예전 그대로, 대시보드·재고현황·일별현황
//     코드를 안 건드리기 위함)지만, 같은 전표에 속한 줄은 전부 같은
//     docNo를 공유한다. docNo는 db.js의 genDocNo()로 트랜잭션 채번해
//     동시 저장해도 번호가 안 겹친다. 수정/삭제/명세서 발행은 docNo
//     단위로 그룹째 처리한다. docNo가 없는(개편 이전) 옛 데이터는
//     낱개 레코드로 계속 정상 동작한다 (하위호환, 마이그레이션 불필요).
// ══════════════════════════════════════════════════════════════

const SalesModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingDocNo = null;   // 수정 중인 전표번호 (null이면 신규 입력)
  let editingIds = [];       // 저장 시 지울 기존 문서 id들 (docNo 그룹 전체 또는 옛 낱개 레코드 1개)
  let unsubscribe = null;
  let updateListeners = [];
  let rowSeq = 0;

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/sales`;
  }
  function counterPath() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/counters`;
  }

  function init() {
    const panel = LayoutShell.registerPanel('sales');
    panel.innerHTML = `
      <div class="card" id="sl-list-card">
        <div class="card-title card-title-action" style="display:flex;align-items:center">
          매출 내역
          <button class="ls-btn-primary" id="sl-add-btn" style="margin-left:auto;width:auto">+ 새 매출 등록</button>
        </div>
      </div>
      <div class="card" id="sl-detail-panel" style="margin-top:16px;display:none"></div>
      <details class="card" style="margin-top:16px">
        <summary class="card-title" style="cursor:pointer">거래처·기간별 거래명세서 발행 (세금계산서 발행용 자료)</summary>
        <div class="form-grid" style="margin-top:10px">
          <div class="fg"><label>거래처</label><select id="sl-inv-buyer"><option value="">— 선택 —</option></select></div>
          <div class="fg"><label>시작일</label><input id="sl-inv-from" type="date"></div>
          <div class="fg"><label>종료일</label><input id="sl-inv-to" type="date"></div>
        </div>
        <button class="ls-btn-primary" id="sl-inv-btn" style="width:auto;margin-top:8px">PDF 생성</button>
      </details>

      <div class="side-panel-bg" id="sl-panel-bg" style="display:none">
        <div class="side-panel side-panel-wide">
          <div class="card-title" style="display:flex;align-items:center">
            <span id="sl-panel-title">새 매출 등록</span>
            <span id="sl-docno-badge" class="badge badge-blue" style="display:none;margin-left:8px"></span>
            <button id="sl-panel-close" style="margin-left:auto">✕</button>
          </div>
          <div class="form-grid">
            <div class="fg"><label>날짜 *</label><input id="sl-date" type="date"></div>
            <div class="fg"><label>거래처 *</label>
              <select id="sl-buyer"><option value="">— 선택 —</option></select>
            </div>
            <div class="fg"><label>인보이스No.</label><input id="sl-invno"></div>
            <div class="fg" style="grid-column:1/-1"><label>비고</label><input id="sl-memo"></div>
          </div>

          <div class="sl-items-head">
            <div>No.</div><div>품목명</div><div>규격</div><div>수량</div><div>단가</div><div>공급가액</div><div></div>
          </div>
          <div id="sl-items-container"></div>
          <datalist id="sl-item-list"></datalist>
          <button type="button" id="sl-add-row-btn" class="sl-add-row-btn">+ 품목 추가</button>

          <div class="sl-doc-totals" id="sl-doc-totals">공급가액 0 + 부가세(10%) 0 = 합계 0</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="ls-btn-primary" id="sl-save-btn" style="width:auto">저장</button>
            <button id="sl-cancel-btn">취소</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('sl-date').value = todayStr();
    addRow(); // 처음엔 빈 줄 1개로 시작

    document.getElementById('sl-add-btn').addEventListener('click', () => { resetForm(); openPanel(); });
    document.getElementById('sl-panel-close').addEventListener('click', closePanel);
    document.getElementById('sl-panel-bg').addEventListener('click', (e) => {
      if (e.target.id === 'sl-panel-bg') closePanel();
    });
    document.getElementById('sl-save-btn').addEventListener('click', async () => { const ok = await save(); if (ok) closePanel(); });
    document.getElementById('sl-cancel-btn').addEventListener('click', closePanel);
    document.getElementById('sl-add-row-btn').addEventListener('click', () => addRow());

    const itemsContainer = document.getElementById('sl-items-container');
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
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'docNo', label: '전표No.', render: (v) => v ? `<span class="sl-docno-link">${escapeHtml(v)}</span>` : '' },
        { key: 'date', label: '날짜' },
        { key: 'buyer', label: '거래처' },
        { key: 'item', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'unitPrice', label: '단가', align: 'right', render: (v) => (typeof v === 'number') ? v.toLocaleString() : (v || '') },
        { key: 'subtotal', label: '공급가액', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'vat', label: '부가세', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() },
        { key: 'invNo', label: '인보이스No.' },
        { key: 'memo', label: '비고' }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['buyer', 'item', 'docNo'],
      rowId: (row) => row.docNo || row.id, // 전표 있으면 전표No., 없으면(옛 데이터) 그 줄 자체의 id
      onRowClick: (key) => showDetailPanel(key),
      selectable: true,
      onBulkDelete: bulkDelete,
      rowActions: (row) => `
        <button data-act="invoice" data-id="${row.id}">명세서</button>
        <button data-act="edit" data-id="${row.id}">수정</button>
        <button data-act="del" data-id="${row.id}">삭제</button>`
    });

    document.getElementById('sl-list-card').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') startEdit(id);
      if (btn.getAttribute('data-act') === 'del') remove(id);
      if (btn.getAttribute('data-act') === 'invoice') printSingleInvoice(id);
    });
  }

  function startListening() {
    if (unsubscribe) unsubscribe();
    unsubscribe = DbEngine.listen(path(), {
      orderBy: { field: 'date', direction: 'desc' },
      onData: (docs) => {
        cache = sortByDateThenDoc(docs);
        tableInstance.render(groupRows(cache));
        updateListeners.forEach((cb) => cb(cache));
      }
    });
    refreshBuyerOptions();
    refreshItemDatalist();
  }

  /** 날짜로 정렬한 뒤, 같은 전표(docNo)의 품목 줄들이 표에서 서로 떨어지지
   * 않고 붙어서 보이도록 전표No.를 2차 정렬 기준으로 쓴다. Firestore
   * 복합 색인 없이 화면단에서만 처리해 안전하게 구현한다. */
  function sortByDateThenDoc(docs) {
    return docs.slice().sort((a, b) => {
      const d = (b.date || '').localeCompare(a.date || '');
      if (d !== 0) return d;
      return (a.docNo || a.id).localeCompare(b.docNo || b.id);
    });
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

  // ── 품목 줄(행) 관리 ──────────────────────────────────────

  /** 품목 입력 줄을 하나 추가합니다. data가 있으면 그 값으로 채워 넣습니다(수정 시 사용). */
  function addRow(data) {
    const key = 'r' + (++rowSeq);
    const container = document.getElementById('sl-items-container');
    const div = document.createElement('div');
    div.className = 'sl-item-row';
    div.setAttribute('data-rowkey', key);
    div.innerHTML = `
      <span class="ri-no"></span>
      <input class="ri-item" list="sl-item-list" placeholder="품목명" value="${escapeHtml(data?.item || '')}">
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

  /** 품목 줄의 No.(1, 2, 3...)를 화면에 다시 매긴다. 줄 추가/삭제 시마다 호출. */
  function renumberRows() {
    document.querySelectorAll('#sl-items-container .sl-item-row').forEach((row, idx) => {
      const noEl = row.querySelector('.ri-no');
      if (noEl) noEl.textContent = idx + 1;
    });
  }

  function removeRow(rowEl) {
    const container = document.getElementById('sl-items-container');
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
    const vat = Math.round(subtotal * 0.1); // 항상 10% (통화 구분 없음 — 요구사항 확정 사항)
    const total = subtotal + vat;
    return { qty, price, subtotal, vat, total };
  }

  function recalcRow(rowEl) {
    const { subtotal } = rowValues(rowEl);
    rowEl.querySelector('.ri-subtotal').textContent = subtotal.toLocaleString();
    recalcTotal();
  }

  function recalcTotal() {
    const rows = document.querySelectorAll('#sl-items-container .sl-item-row');
    let subtotal = 0, vat = 0, total = 0;
    rows.forEach((r) => {
      const v = rowValues(r);
      subtotal += v.subtotal; vat += v.vat; total += v.total;
    });
    document.getElementById('sl-doc-totals').textContent =
      `공급가액 ${subtotal.toLocaleString()} + 부가세(10%) ${vat.toLocaleString()} = 합계 ${total.toLocaleString()}`;
  }

  // ── 등록/수정 폼 전체 ──────────────────────────────────────

  /** 오른쪽 슬라이드 패널을 연다 (새 매출 등록 / 수정 공용). */
  function openPanel() {
    document.getElementById('sl-panel-bg').style.display = 'flex';
  }

  /** 패널을 닫고 폼을 비운다. */
  function closePanel() {
    document.getElementById('sl-panel-bg').style.display = 'none';
    resetForm();
  }

  function resetForm() {
    document.getElementById('sl-date').value = todayStr();
    document.getElementById('sl-buyer').value = '';
    document.getElementById('sl-invno').value = '';
    document.getElementById('sl-memo').value = '';
    document.getElementById('sl-items-container').innerHTML = '';
    addRow();
    editingDocNo = null;
    editingIds = [];
    document.getElementById('sl-panel-title').textContent = '새 매출 등록';
    document.getElementById('sl-docno-badge').style.display = 'none';
    document.getElementById('sl-save-btn').textContent = '저장';
  }

  /** 전표번호(또는 전표번호 없는 옛 낱개 레코드)를 폼에 통째로 불러와 수정 상태로 만든다. */
  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    const group = row.docNo ? cache.filter((r) => r.docNo === row.docNo) : [row];

    document.getElementById('sl-date').value = row.date || '';
    document.getElementById('sl-buyer').value = row.buyerId || '';
    document.getElementById('sl-invno').value = row.invNo || '';
    document.getElementById('sl-memo').value = row.memo || '';

    document.getElementById('sl-items-container').innerHTML = '';
    group.forEach((r) => addRow(r));

    editingDocNo = row.docNo || null;
    editingIds = group.map((r) => r.id);

    document.getElementById('sl-panel-title').textContent = '매출 수정';
    const badge = document.getElementById('sl-docno-badge');
    if (row.docNo) { badge.textContent = row.docNo; badge.style.display = ''; }
    else badge.style.display = 'none';

    document.getElementById('sl-save-btn').textContent = '수정 저장';
    recalcTotal();
    openPanel();
  }

  async function save() {
    const date = document.getElementById('sl-date').value;
    const buyerId = document.getElementById('sl-buyer').value;
    if (!date || !buyerId) { alert('날짜, 거래처는 필수입니다'); return false; }

    const rowEls = Array.from(document.querySelectorAll('#sl-items-container .sl-item-row'));
    const itemRows = rowEls
      .map((el) => ({
        item: el.querySelector('.ri-item').value.trim(),
        spec: el.querySelector('.ri-spec').value.trim(),
        ...rowValues(el)
      }))
      .filter((r) => r.item); // 품목명 없는 빈 줄은 저장하지 않음

    if (!itemRows.length) { alert('품목을 최소 1개 이상 입력하세요'); return false; }

    const buyer = CustomersModule.getCache().find((c) => c.id === buyerId);
    const invNo = document.getElementById('sl-invno').value;
    const memo = document.getElementById('sl-memo').value;

    // 수정 중이면 기존 전표번호를 그대로 쓰고, 신규면 새로 채번한다
    // (옛 낱개 레코드를 수정하는 경우도 이번에 새 전표번호를 받아 정식 전표로 승격된다).
    let docNo;
    try {
      docNo = editingDocNo || await genDocNo(counterPath(), 'S');
    } catch (err) {
      alert('전표번호 채번 중 오류가 발생했습니다: ' + err.message);
      console.error('[채번 실패]', err);
      return false;
    }

    const ops = [];
    editingIds.forEach((id) => ops.push({ type: 'delete', path: path(), id }));
    itemRows.forEach((r) => {
      const product = ProductsModule.findByNameSpec(r.item, r.spec);
      const saleId = genId();
      const saleData = {
        docNo, date, buyerId,
        buyer: buyer ? buyer.name : '',
        item: r.item, spec: r.spec,
        productId: product ? product.id : '',
        qty: r.qty, unitPrice: r.price,
        subtotal: r.subtotal, vat: r.vat, total: r.total,
        invNo, memo
      };

      // 등록된 품목과 정확히 매칭되면 FIFO로 매출원가를 계산해 같이
      // 저장한다 (자유 입력 품목명이라 매칭 안 되면 원가 계산 생략).
      // 매입 뱃치의 남은 수량을 갱신하는 ops도 이 매출 저장과 같은
      // batch에 묶어서, 저장이 중간에 실패해도 반쪽만 반영되지 않게 한다.
      if (product) {
        const fifo = FifoEngine.consume(product.id, r.qty);
        saleData.costOfGoods = fifo.costOfGoods;
        saleData.costLots = fifo.costLots;
        saleData.costEstimated = fifo.estimated;
        ops.push(...fifo.ops);
        // 한 전표 안에 같은 품목이 여러 줄로 나뉘어 있을 때, 다음 줄
        // 계산에서 이번 줄이 방금 깎은 재고가 바로 반영되도록 로컬
        // 캐시에도 즉시 적용해둔다 (실제 Firestore 반영은 이 함수
        // 마지막의 batchWrite(ops) 한 번으로 묶어서 한다).
        FifoEngine.applyOpsToLocalCache(fifo.ops);
      }

      ops.push({ type: 'set', path: path(), id: saleId, data: saleData });
    });

    try {
      await batchWrite(ops);
      return true;
    } catch (err) {
      alert('저장 중 오류가 발생했습니다: ' + err.message);
      console.error('[저장 실패]', err);
      return false;
    }
  }

  /** 전표번호가 있으면 그 전표 전체(품목 여러 줄)를, 없으면(옛 데이터) 그 한 줄만 삭제한다. */
  async function remove(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    const group = row.docNo ? cache.filter((r) => r.docNo === row.docNo) : [row];
    const label = row.docNo ? `전표 ${row.docNo}(품목 ${group.length}개)` : '이 매출 내역';
    if (!confirm(`${label}을(를) 삭제하시겠습니까?`)) return;
    await batchWrite(group.map((r) => ({ type: 'delete', path: path(), id: r.id })));
  }

  /** 전표 키(전표No. 또는 옛 낱개 레코드의 id) 하나를 실제 문서 묶음으로
   * 되돌린다. docNo로 먼저 찾아보고, 없으면(옛 데이터) 그 id 자체를
   * 단일 문서로 취급한다 — docNo 문자열과 Firestore 문서 id는 형식이
   * 겹칠 일이 없어서 순서대로 시도해도 안전하다. */
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
    if (!confirm(`선택한 ${selectedKeys.length}건(품목 ${allRows.length}줄)을 삭제하시겠습니까?`)) return;
    try {
      await batchWrite(allRows.map((r) => ({ type: 'delete', path: path(), id: r.id })));
    } catch (err) {
      alert('삭제 중 오류가 발생했습니다: ' + err.message);
      console.error('[일괄삭제 실패]', err);
    }
  }

  /** 같은 전표(docNo)로 묶인 여러 품목 줄을 표에서 한 줄로 요약한다.
   * 전표번호가 없는(개편 이전) 옛 낱개 레코드는 원래 값 그대로 한 줄로 둔다.
   * 실제 계산(재고·대시보드 등)에 쓰이는 flat한 cache 자체는 안 건드리고,
   * 표시용으로만 별도 배열을 만든다. */
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
        subtotal: acc.subtotal + (r.subtotal || 0), vat: acc.vat + (r.vat || 0), total: acc.total + (r.total || 0)
      }), { subtotal: 0, vat: 0, total: 0 });
      return {
        id: first.id, docNo: first.docNo, date: first.date, buyer: first.buyer,
        item: first.item, spec: first.spec,
        qty: first.qty, unitPrice: first.unitPrice,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
        invNo: first.invNo, memo: first.memo
      };
    });
  }

  /** 표에서 전표(행)를 클릭하면 표 바로 아래 카드에 상세 내역을 펼쳐 보여준다
   * (모달 대신 인라인 표시 — 여러 화면 사이를 오가는 daily.js에서 부르는
   * openDetailModal과는 별개 함수다). */
  function showDetailPanel(docNo) {
    if (!docNo) return;
    const group = cache.filter((r) => r.docNo === docNo);
    if (!group.length) return;
    const totals = group.reduce((acc, r) => ({
      subtotal: acc.subtotal + (r.subtotal || 0), vat: acc.vat + (r.vat || 0), total: acc.total + (r.total || 0)
    }), { subtotal: 0, vat: 0, total: 0 });

    const panel = document.getElementById('sl-detail-panel');
    panel.innerHTML = `
      <div class="card-title" style="display:flex">전표 ${escapeHtml(docNo)} 상세
        <button id="sl-detail-close" style="margin-left:auto">✕ 닫기</button>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">
        ${escapeHtml(group[0].date)} · ${escapeHtml(group[0].buyer)}
      </div>
      ${TableEngine.renderStaticTable([
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'item', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'unitPrice', label: '단가', align: 'right', render: (v) => (v || 0).toLocaleString() },
        { key: 'subtotal', label: '공급가액', align: 'right', render: (v) => (v || 0).toLocaleString() }
      ], group)}
      <div class="sl-doc-totals" style="margin-top:8px">
        공급가액 ${totals.subtotal.toLocaleString()} + 부가세(10%) ${totals.vat.toLocaleString()} = 합계 ${totals.total.toLocaleString()}
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="ls-btn-primary" id="sl-detail-print" style="width:auto">이 전표 명세서 발행</button>
      </div>
    `;
    panel.style.display = 'block';
    document.getElementById('sl-detail-close').addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('sl-detail-print').addEventListener('click', () => InvoiceModule.generate({ docNo }));
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** 재고(stock.js)·일별현황(daily.js)·대시보드에서 매출 데이터를 참조할 때 사용합니다. */
  function getCache() { return cache; }

  /** 매출 데이터가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onUpdate(cb) { updateListeners.push(cb); }

  /** 매출 내역 표의 "명세서" 버튼 — 전표번호가 있으면 그 전표 전체를, 없으면(옛 데이터)
   * 그 거래처·그 날짜로 근사 발행한다. */
  function printSingleInvoice(id) {
    const row = cache.find((r) => r.id === id);
    if (!row) return;
    if (row.docNo) InvoiceModule.generate({ docNo: row.docNo });
    else InvoiceModule.generate({ buyerId: row.buyerId, dateFrom: row.date, dateTo: row.date });
  }

  return { init, startListening, getCache, onUpdate, refreshBuyerOptions, refreshItemDatalist, showDetailPanel };
})();

window.SalesModule = SalesModule;
