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
      <div class="card">
        <div class="card-title">주요 비즈니스 지표 <span id="dash-fy-label" style="font-weight:400;font-size:12px;color:var(--text2)"></span></div>
        <div class="stock-kpis" id="dash-kpis"></div>
      </div>
      <div class="dash-chart-row">
        <div class="card">
          <div class="card-title">월별 매출/매입 추이</div>
          <div style="height:260px"><canvas id="dash-trend-chart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">거래처별 매출 비중 (TOP 5, 회계연도)</div>
          <div style="height:260px"><canvas id="dash-buyer-chart"></canvas></div>
        </div>
      </div>
    `;

    // 다크/라이트 모드 전환 시 차트 색상(CSS 변수 읽어서 씀)을 즉시 다시 그린다
    window.addEventListener('ierp:theme-changed', () => {
      if (subscribed) refresh();
    });
  }

  function refresh() {
    const sales = SalesModule.getCache();
    const purchases = PurchaseModule.getCache();
    const customers = CustomersModule.getCache();
    const products = ProductsModule.getCache();
    const stock = StockModule.computeStock();

    // 매출·매입·이익 지표는 설정의 회계연도 기준으로 계산한다 (예전엔 전체 기간
    // 합계에서 매입 합계를 뺀 값을 "손익"으로 보여줬는데, 부가세가 섞이고 기간
    // 구분도 없어 실제 이익과 거리가 멀었다). 이익은 일별현황과 같은 정의:
    // 매출 공급가액 합계 - FIFO 매출원가 합계.
    const fy = String(SettingsModule.getFiscalYear());
    const inFy = (r) => (r.date || '').startsWith(fy);
    const fySales = sales.filter(inFy);
    const fyPurchases = purchases.filter(inFy);

    const salesTotal = fySales.reduce((s, r) => s + rawNum(r.total), 0);
    const purchTotal = fyPurchases.reduce((s, r) => s + rawNum(r.total), 0);
    const salesSubtotal = fySales.reduce((s, r) => s + rawNum(r.subtotal), 0);
    const cogsTotal = fySales.reduce((s, r) => s + rawNum(r.costOfGoods), 0);
    const grossProfit = salesSubtotal - cogsTotal;
    const margin = salesSubtotal > 0 ? (grossProfit / salesSubtotal * 100) : 0;
    const missingCost = fySales.filter((r) => r.costOfGoods === undefined || r.costOfGoods === null).length;
    const lowStock = stock.filter((r) => r.current <= 0 || (r.safeStock > 0 && r.current <= r.safeStock));

    document.getElementById('dash-fy-label').textContent = `— ${fy} 회계연도`;
    const salesDelta = monthToDateDelta(sales);
    const purchDelta = monthToDateDelta(purchases);
    const ico = (name, cls) => `<span class="kpi-ico ${cls}">${uiIcon(name)}</span>`;
    document.getElementById('dash-kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">${ico('sales', 'k-sales')}매출합계</div><div class="kpi-val" style="color:var(--red)">₩${salesTotal.toLocaleString()}</div>${deltaHtml(salesDelta)}</div>
      <div class="kpi"><div class="kpi-label">${ico('purchase', 'k-purchase')}매입합계</div><div class="kpi-val" style="color:var(--blue)">₩${purchTotal.toLocaleString()}</div>${deltaHtml(purchDelta)}</div>
      <div class="kpi"><div class="kpi-label">${ico('coins', 'k-profit')}매출총이익 (이익률 ${margin.toFixed(1)}%)</div><div class="kpi-val" title="매출 공급가액 - FIFO 매출원가${missingCost ? ` / 원가 미계산 매출 ${missingCost}줄은 원가 0으로 계산됨` : ''}">₩${Math.round(grossProfit).toLocaleString()}${missingCost ? ' *' : ''}</div><div class="kpi-delta">공급가액 − FIFO 매출원가</div></div>
      <div class="kpi"><div class="kpi-label">${ico('customers', 'k-accent')}거래처</div><div class="kpi-val">${customers.length}개</div></div>
      <div class="kpi"><div class="kpi-label">${ico('products', 'k-accent')}품목</div><div class="kpi-val">${products.length}개</div></div>
      <div class="kpi"><div class="kpi-label">${ico('warn', 'k-warn')}재고부족 품목</div><div class="kpi-val" style="color:${lowStock.length ? 'var(--amber)' : 'var(--text)'}">${lowStock.length}개</div><div class="kpi-delta">${lowStock.length ? '재고현황에서 확인하세요' : '모두 안전재고 이상'}</div></div>
    `;

    renderTrendChart(sales, purchases);
    renderBuyerChart(fySales);
  }

  /** 이번 달 1일~오늘 합계와, 지난달 같은 기간(1일~같은 날짜) 합계를 비교한 증감률(%).
   * 지난달 같은 기간이 0이면 비교하지 않는다(null). */
  function monthToDateDelta(rows) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const day = pad(now.getDate());
    const sum = (prefix) => rows.filter((r) => {
      const dt = r.date || '';
      return dt.startsWith(prefix) && dt.slice(8, 10) <= day;
    }).reduce((s, r) => s + rawNum(r.total), 0);
    const cur = sum(ym(now));
    const last = sum(ym(prev));
    if (!last) return null;
    return (cur - last) / Math.abs(last) * 100;
  }

  function deltaHtml(pct) {
    if (pct === null || !isFinite(pct)) return '<div class="kpi-delta">지난달 같은 기간 자료 없음</div>';
    const up = pct >= 0;
    return `<div class="kpi-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% <span style="color:var(--text3);font-weight:500">지난달 같은 기간 대비</span></div>`;
  }

  /** CSS 변수(:root/[data-theme=dark]에 정의된 실제 색상값)를 읽어온다.
   * 라이트/다크 모드가 바뀌어도 항상 지금 테마에 맞는 값을 가져오도록,
   * 차트를 그리는 시점마다 매번 새로 읽는다. */
  function themeColor(varName, fallback) {
    // 다크 모드 토큰은 <body data-theme="dark">에 걸리므로 body에서 읽는다
    // (예전엔 html에서 읽어 다크 모드에서도 차트가 라이트 색으로 그려졌다)
    const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
    return v || fallback;
  }

  /** 최근 3개월(데이터가 있는 달만이 아니라 최근 3개월 전부)의 매출/매입
   * 합계를 막대그래프로 보여준다. */
  function renderTrendChart(sales, purchases) {
    const months = [];
    const now = new Date();
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const sumByMonth = (rows) => months.map((m) =>
      rows.filter((r) => (r.date || '').startsWith(m)).reduce((s, r) => s + rawNum(r.total), 0)
    );

    const ctx = document.getElementById('dash-trend-chart');
    if (trendChart) trendChart.destroy();
    const textColor = themeColor('--text2', '#667085');
    const gridColor = themeColor('--border', '#DDE3EC');
    applyChartDefaults();
    const bar = { borderRadius: 6, borderSkipped: false, maxBarThickness: 36, categoryPercentage: 0.6, barPercentage: 0.85 };
    trendChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months,
        datasets: [
          { label: '매출 (원)', data: sumByMonth(sales), backgroundColor: themeColor('--chart-sales', '#E5484D'), ...bar },
          { label: '매입 (원)', data: sumByMonth(purchases), backgroundColor: themeColor('--chart-purchase', '#3E63DD'), ...bar }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: textColor }, grid: { display: false }, border: { color: gridColor } },
          y: { ticks: { color: textColor, callback: (v) => shortWon(v) }, grid: { color: gridColor }, border: { display: false } }
        },
        plugins: {
          legend: { align: 'end', labels: { color: textColor, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ₩${Number(c.raw).toLocaleString()}` } }
        }
      }
    });
  }

  /** 매출 상위 5개 거래처의 비중을 도넛차트로 보여준다. */
  function renderBuyerChart(sales) {
    const byBuyer = {};
    sales.forEach((r) => { byBuyer[r.buyer] = (byBuyer[r.buyer] || 0) + rawNum(r.total); });
    const top5 = Object.entries(byBuyer).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const ctx = document.getElementById('dash-buyer-chart');
    if (buyerChart) buyerChart.destroy();
    const textColor = themeColor('--text2', '#667085');
    applyChartDefaults();
    const narrow = window.matchMedia('(max-width: 720px)').matches;
    buyerChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: top5.map(([name]) => name),
        datasets: [{
          data: top5.map(([, total]) => total),
          backgroundColor: ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'].map((v) => themeColor(v, '#98A2B3')),
          borderColor: themeColor('--surface', '#FFFFFF'), borderWidth: 2, hoverOffset: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '64%',
        plugins: {
          legend: { position: narrow ? 'bottom' : 'right', labels: { color: textColor, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ₩${Number(c.raw).toLocaleString()}` } }
        }
      }
    });
  }

  /** 차트 글꼴·툴팁을 앱 디자인에 맞춘다 (Chart.js 전역 기본값). */
  function applyChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.plugins.tooltip.backgroundColor = themeColor('--text', '#101828');
    Chart.defaults.plugins.tooltip.titleColor = themeColor('--surface', '#FFFFFF');
    Chart.defaults.plugins.tooltip.bodyColor = themeColor('--surface', '#FFFFFF');
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
  }

  /** 축 눈금용 짧은 금액 표기 (예: 4,500,000 → 450만) */
  function shortWon(v) {
    const n = Number(v);
    if (Math.abs(n) >= 1e8) return (n / 1e8).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '억';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toLocaleString(undefined, { maximumFractionDigits: 0 }) + '만';
    return n.toLocaleString();
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
