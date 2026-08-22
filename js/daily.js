// ══════════════════════════════════════════════════════════════
// daily.js — 일별현황 (매출 + 매입 통합 조회)
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, layout-shell.js, table-engine.js,
//         sales.js, purchase.js
//
// stock.js와 마찬가지로 자체 데이터가 없는 "조회 전용" 화면입니다.
// 매출/매입 두 컬렉션을 합쳐서 하나의 표로 보여줍니다.
//
// sales.js/purchase.js와 동일한 원칙: 같은 전표(docNo)의 여러 품목
// 줄은 표에서 한 줄로 요약하고, 그 줄을 클릭하면 모달이 아니라
// 화면 안(표 바로 아래)에 상세 내역이 펼쳐진다.
// ══════════════════════════════════════════════════════════════

const DailyModule = (() => {
  let tableInstance = null;
  let subscribed = false;

  function init() {
    const panel = LayoutShell.registerPanel('daily');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">📅 일별 매출 / 매입 현황</div>
        <div class="stock-kpis" id="daily-kpis"></div>
      </div>
      <div class="card" id="daily-list-card" style="margin-top:16px">
        <div class="card-title">거래 내역</div>
      </div>
      <div class="card" id="daily-detail-panel" style="margin-top:16px;display:none"></div>
    `;

    tableInstance = TableEngine.create('daily', {
      container: document.getElementById('daily-list-card'),
      columns: [
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'date', label: '날짜' },
        { key: 'type', label: '구분', render: (v) => v === '매출'
          ? '<span class="badge badge-red">매출</span>'
          : '<span class="badge badge-blue">매입</span>' },
        { key: 'party', label: '거래처/업체' },
        { key: 'docNo', label: '전표No.', render: (v) => v ? `<span class="sl-docno-link">${escapeHtml(v)}</span>` : '' },
        { key: 'item', label: '품목' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['party', 'item', 'docNo'],
      rowId: (row) => row.docNo || '',
      onRowClick: (docNo) => showDetailPanel(docNo),
      onFilterChange: renderKpis
    });
  }

  /** 매출/매입 낱개 레코드를 하나의 배열로 합친다 (그룹핑 전 원본). */
  function computeRawRows() {
    const sales = SalesModule.getCache().map((r) => ({
      id: r.id, date: r.date, type: '매출', party: r.buyer, item: r.item, spec: r.spec, qty: r.qty, total: r.total, docNo: r.docNo || '',
      subtotal: r.subtotal || 0, costOfGoods: r.costOfGoods, costEstimated: !!r.costEstimated
    }));
    const purchases = PurchaseModule.getCache().map((r) => ({
      id: r.id, date: r.date, type: '매입', party: r.vendor, item: r.item, spec: r.spec, qty: r.qty, total: r.total, docNo: r.docNo || '',
      subtotal: r.subtotal || 0
    }));
    return [...sales, ...purchases].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  /** 같은 전표(docNo)의 여러 품목 줄을 표에서 한 줄로 요약한다. 전표번호가
   * 없는(개편 이전) 옛 낱개 레코드는 원래 값 그대로 한 줄로 둔다.
   * __lineCount·매출총이익 계산에 필요한 합계 필드도 여기서 같이
   * 집계해서, KPI가 요약된 뒤에도 정확하게 계산되도록 한다. */
  function groupRows(rawRows) {
    const groups = {};
    const order = [];
    rawRows.forEach((r) => {
      const key = r.docNo || ('__single_' + r.type + '_' + r.id);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });
    return order.map((key) => {
      const group = groups[key];
      const first = group[0];
      if (group.length === 1) return { ...first, __lineCount: 1 };

      const subtotal = group.reduce((s, r) => s + (r.subtotal || 0), 0);
      const total = group.reduce((s, r) => s + (r.total || 0), 0);
      const knownCost = group.filter((r) => r.costOfGoods !== undefined && r.costOfGoods !== null);
      return {
        id: first.id, date: first.date, type: first.type, party: first.party, docNo: first.docNo,
        item: `${first.item} 외 ${group.length - 1}건`, spec: '-', qty: '-', total,
        subtotal,
        costOfGoods: first.type === '매출' && knownCost.length ? knownCost.reduce((s, r) => s + r.costOfGoods, 0) : undefined,
        costEstimated: group.some((r) => r.costEstimated),
        __missingCost: first.type === '매출' ? (group.length - knownCost.length) : 0,
        __lineCount: group.length
      };
    });
  }

  function refresh() {
    tableInstance.render(groupRows(computeRawRows())); // render()가 내부적으로 필터를 적용하며 onFilterChange를 통해 renderKpis도 호출한다
  }

  /** 표에서 전표(행)를 클릭하면 표 바로 아래 카드에 상세 내역을 펼쳐 보여준다
   * (매출/매입 화면 자체의 showDetailPanel과 별개 — 여긴 두 화면 데이터를
   * 합쳐서 보여주는 화면이라 전표번호 접두사(S/P)로 출처를 가려낸다). */
  function showDetailPanel(docNo) {
    if (!docNo) return;
    const isSale = docNo.startsWith('S');
    const source = isSale ? SalesModule.getCache() : PurchaseModule.getCache();
    const group = source.filter((r) => r.docNo === docNo);
    if (!group.length) return;
    const partyLabel = isSale ? group[0].buyer : group[0].vendor;
    const totals = group.reduce((acc, r) => ({
      subtotal: acc.subtotal + (r.subtotal || 0), vat: acc.vat + (r.vat || 0), total: acc.total + (r.total || 0)
    }), { subtotal: 0, vat: 0, total: 0 });

    const panel = document.getElementById('daily-detail-panel');
    panel.innerHTML = `
      <div class="card-title" style="display:flex">
        전표 ${escapeHtml(docNo)} 상세 (${isSale ? '매출' : '매입'})
        <button id="daily-detail-close" style="margin-left:auto">✕ 닫기</button>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">
        ${escapeHtml(group[0].date)} · ${escapeHtml(partyLabel || '')}
      </div>
      <table class="te-table">
        <thead><tr><th>No.</th><th>품목명</th><th>규격</th><th>수량</th><th>단가</th><th>공급가액</th></tr></thead>
        <tbody>
          ${group.map((r, idx) => `
            <tr>
              <td style="text-align:center">${idx + 1}</td>
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
    `;
    panel.style.display = 'block';
    document.getElementById('daily-detail-close').addEventListener('click', () => { panel.style.display = 'none'; });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** 지금 표에 실제로 보이는(검색·기간 필터 반영된, 전표 단위로 요약된)
   * 행 기준으로 KPI를 다시 계산한다 — table-engine.js의 onFilterChange
   * 콜백으로 필터가 바뀔 때마다 호출된다. */
  function renderKpis(rows) {
    const salesRows = rows.filter((r) => r.type === '매출');
    const salesTotal = salesRows.reduce((s, r) => s + (r.total || 0), 0);
    const purchTotal = rows.filter((r) => r.type === '매입').reduce((s, r) => s + (r.total || 0), 0);

    // 매출총이익 = 매출 공급가액 합계 - 매출원가(FIFO) 합계. 원가가
    // 아직 계산 안 된(옛 데이터 또는 미등록 품목) 줄은 원가 0으로 보고
    // 그만큼 이익이 과대평가될 수 있다는 걸 별도 표시로 알려준다.
    const salesSubtotal = salesRows.reduce((s, r) => s + (r.subtotal || 0), 0);
    const cogsTotal = salesRows.reduce((s, r) => s + (r.costOfGoods || 0), 0);
    const missingCost = salesRows.reduce((s, r) => s + (r.__missingCost !== undefined ? r.__missingCost : (r.costOfGoods === undefined ? 1 : 0)), 0);
    const hasEstimate = salesRows.some((r) => r.costEstimated);
    const grossProfit = salesSubtotal - cogsTotal;
    const margin = salesSubtotal > 0 ? (grossProfit / salesSubtotal * 100) : 0;
    const lineCount = rows.reduce((s, r) => s + (r.__lineCount || 1), 0);

    let profitNote = '';
    if (missingCost > 0) profitNote = ` <span style="font-size:10px;color:var(--text2)">(원가 미계산 ${missingCost}줄 제외)</span>`;
    else if (hasEstimate) profitNote = ' <span style="font-size:10px;color:var(--amber)">(일부 추정치 포함)</span>';

    document.getElementById('daily-kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">매출합계</div><div class="kpi-val" style="color:var(--red)">₩${salesTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">매입합계</div><div class="kpi-val" style="color:var(--blue)">₩${purchTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">매출총이익${profitNote}</div><div class="kpi-val">₩${Math.round(grossProfit).toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">이익률</div><div class="kpi-val" style="color:var(--green)">${margin.toFixed(1)}%</div></div>
      <div class="kpi"><div class="kpi-label">전표건수</div><div class="kpi-val">${rows.length}건</div></div>
      <div class="kpi"><div class="kpi-label">품목줄 수</div><div class="kpi-val">${lineCount}줄</div></div>
    `;
  }

  function startListening() {
    if (!subscribed) {
      SalesModule.onUpdate(refresh);
      PurchaseModule.onUpdate(refresh);
      subscribed = true;
    }
    refresh();
  }

  return { init, startListening };
})();

window.DailyModule = DailyModule;
