// ══════════════════════════════════════════════════════════════
// dashboard.js — 대시보드 (요약 지표 + 차트)
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, layout-shell.js, sales.js, purchase.js,
//         customers.js, products.js, stock.js, Chart.js(CDN)
//
// "최근 거래 내역"을 텍스트로 나열하던 표 대신, 한눈에 파악되는
// 차트(월별 매출/매입 추이, 거래처별 매출 비중)로 바꿨다. 최신
// 대시보드 UI 트렌드 조사 결과와 일치하는 방향("Bold KPI + 차트,
// 텍스트 나열 지양").
// ══════════════════════════════════════════════════════════════

const DashboardModule = (() => {
  let subscribed = false;
  let trendChart = null;
  let buyerChart = null;

  function init() {
    const panel = LayoutShell.registerPanel('dashboard');
    panel.innerHTML = `
      <div id="dash-low-stock-banner"></div>
      <div class="card">
        <div class="card-title">📊 주요 비즈니스 지표</div>
        <div class="stock-kpis" id="dash-kpis"></div>
      </div>
      <div class="dash-chart-row">
        <div class="card">
          <div class="card-title">📈 월별 매출/매입 추이</div>
          <div style="height:260px"><canvas id="dash-trend-chart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">🥧 거래처별 매출 비중 (TOP 5)</div>
          <div style="height:260px"><canvas id="dash-buyer-chart"></canvas></div>
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

    renderTrendChart(sales, purchases);
    renderBuyerChart(sales);
  }

  /** 최근 6개월(데이터가 있는 달만이 아니라 최근 6개월 전부)의 매출/매입
   * 합계를 막대그래프로 보여준다. */
  function renderTrendChart(sales, purchases) {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const sumByMonth = (rows) => months.map((m) =>
      rows.filter((r) => (r.date || '').startsWith(m)).reduce((s, r) => s + (r.total || 0), 0)
    );

    const ctx = document.getElementById('dash-trend-chart');
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months,
        datasets: [
          { label: '매출 (원)', data: sumByMonth(sales), backgroundColor: '#c0392b' },
          { label: '매입 (원)', data: sumByMonth(purchases), backgroundColor: '#1a3a6b' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { ticks: { callback: (v) => v.toLocaleString() } } }
      }
    });
  }

  /** 매출 상위 5개 거래처의 비중을 도넛차트로 보여준다. */
  function renderBuyerChart(sales) {
    const byBuyer = {};
    sales.forEach((r) => { byBuyer[r.buyer] = (byBuyer[r.buyer] || 0) + (r.total || 0); });
    const top5 = Object.entries(byBuyer).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const ctx = document.getElementById('dash-buyer-chart');
    if (buyerChart) buyerChart.destroy();
    buyerChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: top5.map(([name]) => name),
        datasets: [{
          data: top5.map(([, total]) => total),
          backgroundColor: ['#1a6b3c', '#1a3a6b', '#7a4a00', '#8b2020', '#4a4a4a']
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
      }
    });
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
