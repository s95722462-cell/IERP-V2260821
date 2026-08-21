// ══════════════════════════════════════════════════════════════
// stock.js — 재고현황 (품목/매출/매입 데이터로 자동 계산)
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, layout-shell.js, table-engine.js,
//         products.js, sales.js, purchase.js
//
// 이 화면은 자체 Firestore 데이터가 없습니다 — products/sales/purchase
// 세 모듈의 onUpdate() 구독으로 셋 중 무엇이 바뀌어도 자동으로
// 다시 계산합니다. (등록 폼이 없는 순수 계산/조회 화면)
//
// 매칭 규칙: productId가 있으면 productId로, 없으면(예: 미등록
// 품목으로 자유 입력한 경우) 품목명+규격 정확히 일치로 매칭합니다.
// ══════════════════════════════════════════════════════════════

const StockModule = (() => {
  let tableInstance = null;

  function init() {
    const panel = LayoutShell.registerPanel('stock');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">📦 재고현황 <span style="font-weight:400;font-size:12px;color:var(--text2)">— 매출 차감 / 매입 증가 자동 반영</span></div>
        <div class="stock-kpis" id="stock-kpis"></div>
      </div>
      <div class="card" id="stock-list-card" style="margin-top:16px">
        <div class="card-title">재고 목록</div>
      </div>
    `;

    tableInstance = TableEngine.create('stock', {
      container: document.getElementById('stock-list-card'),
      columns: [
        { key: 'code', label: '품목코드' },
        { key: 'name', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'unit', label: '단위' },
        { key: 'initStock', label: '초기재고', align: 'right' },
        { key: 'inQty', label: '입고(매입)', align: 'right' },
        { key: 'outQty', label: '출고(매출)', align: 'right' },
        { key: 'current', label: '현재고', align: 'right', render: renderCurrent },
        { key: 'stockValue', label: '재고금액', align: 'right', render: (v) => '₩' + Math.round(v || 0).toLocaleString() },
        { key: 'safeStock', label: '안전재고', align: 'right' },
        { key: 'status', label: '상태', render: renderStatus }
      ],
      searchFields: ['name', 'code', 'spec']
    });
  }

  function renderCurrent(value, row) {
    const color = row.current <= 0 ? 'var(--red)' : (row.safeStock > 0 && row.current <= row.safeStock ? 'var(--amber)' : 'inherit');
    return `<span style="color:${color};font-weight:700">${(value || 0).toLocaleString()}</span>`;
  }

  function renderStatus(value, row) {
    if (row.current <= 0) return '<span style="color:var(--red)">⛔ 재고없음</span>';
    if (row.safeStock > 0 && row.current <= row.safeStock) return '<span style="color:var(--amber)">⚠️ 재고부족</span>';
    return '<span style="color:var(--green)">✅ 정상</span>';
  }

  /** 등록된 품목 목록에 매출/매입 데이터를 매칭해 현재고를 계산합니다. */
  function computeStock() {
    const products = ProductsModule.getCache();
    const sales = SalesModule.getCache();
    const purchases = PurchaseModule.getCache();

    return products.map((p) => {
      const matchIn = (r) => (r.productId && r.productId === p.id) || (!r.productId && r.item === p.name && (r.spec || '') === (p.spec || ''));
      const inQty = purchases.filter(matchIn).reduce((s, r) => s + (r.qty || 0), 0);
      const outQty = sales.filter(matchIn).reduce((s, r) => s + (r.qty || 0), 0);
      const current = (p.initStock || 0) + inQty - outQty;
      return {
        ...p,
        inQty, outQty, current,
        stockValue: current * (p.price || 0)
      };
    });
  }

  function refresh() {
    const rows = computeStock();
    tableInstance.render(rows);
    renderKpis(rows);
  }

  function renderKpis(rows) {
    const total = rows.length;
    const low = rows.filter((r) => r.safeStock > 0 && r.current <= r.safeStock && r.current > 0).length;
    const empty = rows.filter((r) => r.current <= 0).length;
    const totalValue = rows.reduce((s, r) => s + r.stockValue, 0);
    document.getElementById('stock-kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">전체 품목</div><div class="kpi-val">${total}개</div></div>
      <div class="kpi"><div class="kpi-label">재고 부족</div><div class="kpi-val" style="color:var(--amber)">${low}개</div></div>
      <div class="kpi"><div class="kpi-label">재고 없음</div><div class="kpi-val" style="color:var(--red)">${empty}개</div></div>
      <div class="kpi"><div class="kpi-label">전체 재고금액</div><div class="kpi-val" style="color:var(--green)">₩${Math.round(totalValue).toLocaleString()}</div></div>
    `;
  }

  let subscribed = false;

  /** 품목/매출/매입 구독 이벤트에 연결합니다. 로그인 직후 한 번만 호출하면 됩니다
   * (회사를 전환해도 각 모듈이 알아서 새 회사 데이터로 갱신하고, 이 구독은 계속 유효합니다). */
  function startListening() {
    if (!subscribed) {
      ProductsModule.onUpdate(refresh);
      SalesModule.onUpdate(refresh);
      PurchaseModule.onUpdate(refresh);
      subscribed = true;
    }
    refresh(); // 이미 로드되어 있는 데이터로 즉시 한 번 계산
  }

  return { init, startListening, computeStock };
})();

window.StockModule = StockModule;
