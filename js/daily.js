// ══════════════════════════════════════════════════════════════
// daily.js — 일별현황 (매출 + 매입 통합 조회)
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, layout-shell.js, table-engine.js,
//         sales.js, purchase.js
//
// stock.js와 마찬가지로 자체 데이터가 없는 "조회 전용" 화면입니다.
// 매출/매입 두 컬렉션을 합쳐서 하나의 표로 보여줍니다.
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
        { key: 'docNo', label: '전표No.', render: (v) =>
          v ? `<button class="sl-docno-link" data-docno="${escapeHtml(v)}">${escapeHtml(v)}</button>` : '' },
        { key: 'item', label: '품목' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['party', 'item', 'docNo'],
      onFilterChange: renderKpis
    });

    document.getElementById('daily-list-card').addEventListener('click', (e) => {
      const btn = e.target.closest('.sl-docno-link');
      if (!btn) return;
      const docNo = btn.getAttribute('data-docno');
      // 접두사 S(매출)/P(매입)로 어느 모듈의 전표인지 구분해 해당 상세 모달을 연다.
      if (docNo.startsWith('S')) SalesModule.openDetailModal(docNo);
      else if (docNo.startsWith('P')) PurchaseModule.openDetailModal(docNo);
    });
  }

  function computeRows() {
    const sales = SalesModule.getCache().map((r) => ({
      date: r.date, type: '매출', party: r.buyer, item: r.item, spec: r.spec, qty: r.qty, total: r.total, docNo: r.docNo || '',
      subtotal: r.subtotal || 0, costOfGoods: r.costOfGoods, costEstimated: !!r.costEstimated
    }));
    const purchases = PurchaseModule.getCache().map((r) => ({
      date: r.date, type: '매입', party: r.vendor, item: r.item, spec: r.spec, qty: r.qty, total: r.total, docNo: r.docNo || ''
    }));
    return [...sales, ...purchases].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  /** "전표건수" — 같은 전표(docNo)로 묶인 여러 품목 줄은 1건으로, 전표번호가
   * 없는(구조 개편 전) 옛 낱개 레코드는 각각 1건으로 센다. 화면의 낱개 줄
   * 개수("거래건수")와는 다른 지표라 KPI에 둘 다 보여준다. */
  function countDocs(rows) {
    const withDoc = new Set(rows.filter((r) => r.docNo).map((r) => r.docNo));
    const withoutDoc = rows.filter((r) => !r.docNo).length;
    return withDoc.size + withoutDoc;
  }

  function refresh() {
    const rows = computeRows();
    tableInstance.render(rows); // render()가 내부적으로 필터를 적용하며 onFilterChange를 통해 renderKpis도 호출한다
  }

  /** 지금 표에 실제로 보이는(검색·기간 필터 반영된) 행 기준으로 KPI를
   * 다시 계산한다 — table-engine.js의 onFilterChange 콜백으로 필터가
   * 바뀔 때마다 호출된다. 그래서 예를 들어 기간을 8월로 좁히면 이
   * KPI도 정확히 8월 한 달치 매출총이익·이익률로 바뀐다. */
  function renderKpis(rows) {
    const salesRows = rows.filter((r) => r.type === '매출');
    const salesTotal = salesRows.reduce((s, r) => s + (r.total || 0), 0);
    const purchTotal = rows.filter((r) => r.type === '매입').reduce((s, r) => s + (r.total || 0), 0);

    // 매출총이익 = 매출 공급가액 합계 - 매출원가(FIFO) 합계. 원가가
    // 아직 계산 안 된(옛 데이터 또는 미등록 품목) 줄은 원가 0으로 보고
    // 그만큼 이익이 과대평가될 수 있다는 걸 별도 표시로 알려준다.
    const salesSubtotal = salesRows.reduce((s, r) => s + (r.subtotal || 0), 0);
    const knownCostRows = salesRows.filter((r) => r.costOfGoods !== undefined && r.costOfGoods !== null);
    const cogsTotal = knownCostRows.reduce((s, r) => s + (r.costOfGoods || 0), 0);
    const missingCost = salesRows.length - knownCostRows.length;
    const hasEstimate = salesRows.some((r) => r.costEstimated);
    const grossProfit = salesSubtotal - cogsTotal;
    const margin = salesSubtotal > 0 ? (grossProfit / salesSubtotal * 100) : 0;

    let profitNote = '';
    if (missingCost > 0) profitNote = ` <span style="font-size:10px;color:var(--text2)">(원가 미계산 ${missingCost}줄 제외)</span>`;
    else if (hasEstimate) profitNote = ' <span style="font-size:10px;color:var(--amber)">(일부 추정치 포함)</span>';

    document.getElementById('daily-kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">매출합계</div><div class="kpi-val" style="color:var(--red)">₩${salesTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">매입합계</div><div class="kpi-val" style="color:var(--blue)">₩${purchTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">매출총이익${profitNote}</div><div class="kpi-val">₩${Math.round(grossProfit).toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">이익률</div><div class="kpi-val" style="color:var(--green)">${margin.toFixed(1)}%</div></div>
      <div class="kpi"><div class="kpi-label">전표건수</div><div class="kpi-val">${countDocs(rows)}건</div></div>
      <div class="kpi"><div class="kpi-label">품목줄 수</div><div class="kpi-val">${rows.length}줄</div></div>
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
