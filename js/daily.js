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
        { key: 'docNo', label: '전표No.', render: (v, row) => {
          if (!v) return '';
          if (row.type === '매출') return `<button class="sl-docno-link" data-docno="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
          return escapeHtml(v); // 매입은 아직 전표 구조 적용 전(하위호환) — 텍스트로만 표시
        } },
        { key: 'item', label: '품목' },
        { key: 'spec', label: '규격' },
        { key: 'qty', label: '수량', align: 'right' },
        { key: 'total', label: '합계', align: 'right', render: (v) => '₩' + (v || 0).toLocaleString() }
      ],
      dateFilter: true,
      dateField: 'date',
      searchFields: ['party', 'item', 'docNo']
    });

    document.getElementById('daily-list-card').addEventListener('click', (e) => {
      const btn = e.target.closest('.sl-docno-link');
      if (btn) SalesModule.openDetailModal(btn.getAttribute('data-docno'));
    });
  }

  function computeRows() {
    const sales = SalesModule.getCache().map((r) => ({
      date: r.date, type: '매출', party: r.buyer, item: r.item, spec: r.spec, qty: r.qty, total: r.total, docNo: r.docNo || ''
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
