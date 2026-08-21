// ══════════════════════════════════════════════════════════════
// dashboard.js — 대시보드 (요약 지표 + 최근 거래)
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, layout-shell.js, sales.js, purchase.js,
//         customers.js, products.js, stock.js
// ══════════════════════════════════════════════════════════════

const DashboardModule = (() => {
  let subscribed = false;

  function init() {
    const panel = LayoutShell.registerPanel('dashboard');
    panel.innerHTML = `
      <div id="dash-low-stock-banner"></div>
      <div class="card">
        <div class="card-title">📊 주요 비즈니스 지표</div>
        <div class="stock-kpis" id="dash-kpis"></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">🕒 최근 거래 내역</div>
        <div class="te-scroll">
          <table class="te-table">
            <thead><tr><th>No.</th><th>날짜</th><th>구분</th><th>거래처</th><th>품목</th><th style="text-align:right">금액</th></tr></thead>
            <tbody id="dash-recent-tbody"></tbody>
          </table>
        </div>
      </div>
    `;
  }

  function refresh() {
    const sales = SalesModule.getCache();
    const purchases = PurchaseModule.getCache();
    const customers = CustomersModule.getCache();
    const products = ProductsModule.getCache();
    const stock = StockModule.computeStock();

    const salesTotal = sales.reduce((s, r) => s + (r.total || 0), 0);
    const purchTotal = purchases.reduce((s, r) => s + (r.total || 0), 0);
    const lowStock = stock.filter((r) => r.current <= 0 || (r.safeStock > 0 && r.current <= r.safeStock));

    document.getElementById('dash-kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">매출합계</div><div class="kpi-val" style="color:var(--red)">₩${salesTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">매입합계</div><div class="kpi-val" style="color:var(--blue)">₩${purchTotal.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">손익</div><div class="kpi-val">₩${(salesTotal - purchTotal).toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">거래처</div><div class="kpi-val">${customers.length}개</div></div>
      <div class="kpi"><div class="kpi-label">품목</div><div class="kpi-val">${products.length}개</div></div>
      <div class="kpi"><div class="kpi-label">재고부족 품목</div><div class="kpi-val" style="color:var(--amber)">${lowStock.length}개</div></div>
    `;

    const banner = document.getElementById('dash-low-stock-banner');
    banner.innerHTML = lowStock.length
      ? `<div class="alert-banner">⚠️ 재고 부족 알림: ${lowStock.length}개의 품목이 안전 재고 미만이거나 없습니다.</div>`
      : '';

    const recent = [
      ...sales.map((r) => ({ ...r, _type: '매출', _party: r.buyer })),
      ...purchases.map((r) => ({ ...r, _type: '매입', _party: r.vendor }))
    ].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10);

    document.getElementById('dash-recent-tbody').innerHTML = recent.length
      ? recent.map((r, idx) => `
        <tr>
          <td style="text-align:center">${idx + 1}</td>
          <td>${escapeHtml(r.date || '')}</td>
          <td>${r._type === '매출' ? '<span class="badge badge-red">매출</span>' : '<span class="badge badge-blue">매입</span>'}</td>
          <td>${escapeHtml(r._party || '')}</td>
          <td>${escapeHtml(r.item || '')}</td>
          <td style="text-align:right">₩${(r.total || 0).toLocaleString()}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--text2)">거래 내역이 없습니다</td></tr>';
  }

  function startListening() {
    if (!subscribed) {
      SalesModule.onUpdate(refresh);
      PurchaseModule.onUpdate(refresh);
      CustomersModule.onUpdate(refresh);
      ProductsModule.onUpdate(refresh);
      subscribed = true;
    }
    refresh();
  }

  return { init, startListening };
})();

window.DashboardModule = DashboardModule;
