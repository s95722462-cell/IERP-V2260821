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
        { key: 'date', label: '날짜' },
        { key: 'type', label: '구분', render: (v) => v === '매출'
          ? '<span class="badge badge-red">매출</span>'
          : '<span class="badge badge-blue">매입</span>' },
        { key: 'party', label: '거래처/업체' },
        { key: 'item', label: '품목' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['party', 'item']
    });
  }

  function computeRows() {
    const sales = SalesModule.getCache().map((r) => ({
      date: r.date, type: '매출', party: r.buyer, item: r.item, spec: r.spec, qty: r.qty, total: r.total
    }));
    const purchases = PurchaseModule.getCache().map((r) => ({
      date: r.date, type: '매입', party: r.vendor, item: r.item, spec: r.spec, qty: r.qty, total: r.total
    }));
    return [...sales, ...purchases].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  function refresh() {
    const rows = computeRows();
    tableInstance.render(rows);
    renderKpis(rows);
  }

  function renderKpis(rows) {
    const salesTotal = rows.filter((r) => r.type === '매출').reduce((s, r) => s + (r.total || 0), 0);
    const purchTotal = rows.filter((r) => r.type === '매입').reduce((s, r) => s + (r.total || 0), 0);
    document.getElementById('daily-kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">매출합계</div><div class="kpi-val" style="color:var(--red)">₩${salesTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">매입합계</div><div class="kpi-val" style="color:var(--blue)">₩${purchTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">손익</div><div class="kpi-val">₩${(salesTotal - purchTotal).toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">거래건수</div><div class="kpi-val">${rows.length}건</div></div>
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
