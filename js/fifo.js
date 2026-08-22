// ══════════════════════════════════════════════════════════════
// fifo.js — 매출원가(FIFO) 계산 공용 모듈
// iERP 2.0
//
// 의존성: auth.js(curCompanyId, getAuthState), db.js(batchWrite),
//         products.js, purchase.js, sales.js
//
// 설계 원칙 (사용자와 합의한 정책):
//   - 매출 저장 시점에 "그때 남아있는 매입 뱃치" 기준으로 원가를 계산해
//     그대로 저장해둔다. 이후 과거 매입·매출을 수정해도 자동으로
//     다시 계산하지 않는다 — 대신 재고현황 화면에 품목별 "FIFO 재계산"
//     버튼을 두어, 필요할 때 사용자가 직접 눌러서 처음부터 다시
//     계산하게 한다. (실시간 자동 재계산은 정확하지만, 매번 과거
//     데이터를 건드릴 때마다 대량의 문서를 조용히 다시 쓰는 구조라
//     이 프로젝트 규모에선 오히려 예측하기 어렵고 위험하다고 판단함)
//   - 초기재고(품목 등록 시 넣는 수량)는 매입 문서가 아니라서, 가장
//     오래된 "가상의 뱃치"로 취급한다. 단가는 품목의 "기준단가"를 쓴다.
//   - 매입 각 줄(문서)이 곧 하나의 FIFO 뱃치다. remainingQty 필드로
//     그 뱃치에서 아직 안 팔리고 남은 수량을 추적한다.
// ══════════════════════════════════════════════════════════════

const FifoEngine = (() => {
  function purchasesPath() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/purchases`;
  }
  function productsPath() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/products`;
  }
  function salesPath() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/sales`;
  }

  /** 특정 품목의 매입 뱃치(+초기재고 가상 뱃치)를, 남은 수량이 있는 것만
   * 오래된 날짜순으로 반환한다. */
  function getLots(productId) {
    const product = ProductsModule.getCache().find((p) => p.id === productId);
    const lots = [];
    if (product) {
      const initRemaining = (product.initStockRemaining !== undefined)
        ? product.initStockRemaining
        : (product.initStock || 0);
      if (initRemaining > 0) {
        lots.push({ type: 'init', id: product.id, date: '0000-00-00', unitPrice: product.price || 0, remainingQty: initRemaining });
      }
    }
    PurchaseModule.getCache()
      .filter((r) => r.productId === productId && (r.remainingQty !== undefined ? r.remainingQty : r.qty) > 0)
      .forEach((r) => lots.push({
        type: 'purchase', id: r.id, date: r.date, unitPrice: r.unitPrice || 0,
        remainingQty: r.remainingQty !== undefined ? r.remainingQty : r.qty
      }));
    lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));
    return lots;
  }

  /**
   * 품목 하나를 qty만큼 FIFO로 소진한 것으로 계산한다. 실제 저장(뱃치의
   * 남은 수량 갱신)은 하지 않고, 필요한 batchWrite ops만 만들어 반환한다
   * — 호출한 쪽(sales.js)이 매출 저장 ops와 한 batch로 묶어서 같이
   * 커밋해야 원자적으로 안전하기 때문이다.
   * @returns {{costOfGoods:number, costLots:object[], estimated:boolean, ops:object[]}}
   */
  function consume(productId, qty) {
    const lots = getLots(productId);
    let remaining = qty;
    let cost = 0;
    const used = [];
    const ops = [];

    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.remainingQty);
      if (take <= 0) continue;
      cost += take * lot.unitPrice;
      used.push({ type: lot.type, id: lot.id, qty: take, unitPrice: lot.unitPrice });
      remaining -= take;
      const newRemaining = lot.remainingQty - take;
      if (lot.type === 'init') {
        ops.push({ type: 'set', path: productsPath(), id: lot.id, data: { initStockRemaining: newRemaining }, merge: true });
      } else {
        ops.push({ type: 'set', path: purchasesPath(), id: lot.id, data: { remainingQty: newRemaining }, merge: true });
      }
    }

    // 남은 뱃치보다 판 수량이 많으면(마이너스 재고) 마지막 단가로
    // 부족분을 추정 계산하고, 추정치라는 표시를 남긴다.
    let estimated = false;
    if (remaining > 0) {
      const lastPrice = lots.length ? lots[lots.length - 1].unitPrice : 0;
      cost += remaining * lastPrice;
      used.push({ type: 'estimate', qty: remaining, unitPrice: lastPrice });
      estimated = true;
    }

    return { costOfGoods: cost, costLots: used, estimated, ops };
  }

  /** 방금 쓴 값을 로컬 캐시(PurchaseModule/ProductsModule)에도 즉시
   * 반영한다 — Firestore 실시간 리스너가 돌아오기 전에 recalcProduct()가
   * 연속으로 다음 매출을 계산할 때도 최신 상태를 보게 하기 위함. */
  function applyOpsToLocalCache(ops) {
    ops.forEach((op) => {
      if (op.data && 'remainingQty' in op.data) {
        const row = PurchaseModule.getCache().find((r) => r.id === op.id);
        if (row) row.remainingQty = op.data.remainingQty;
      }
      if (op.data && 'initStockRemaining' in op.data) {
        const p = ProductsModule.getCache().find((r) => r.id === op.id);
        if (p) p.initStockRemaining = op.data.initStockRemaining;
      }
    });
  }

  /** 품목 하나의 FIFO를 처음부터 다시 계산한다: 모든 매입 뱃치와 초기재고를
   * 원래 수량으로 리셋한 뒤, 그 품목이 들어간 모든 매출을 날짜 오래된
   * 순으로 다시 훑으며 소진시킨다. 과거 매입·매출을 수정한 뒤 눌러서
   * 쓰는 수동 버튼용 함수다. */
  async function recalcProduct(productId) {
    const product = ProductsModule.getCache().find((p) => p.id === productId);
    if (!product) { alert('품목을 찾을 수 없습니다'); return; }

    const resetOps = [];
    PurchaseModule.getCache()
      .filter((r) => r.productId === productId)
      .forEach((r) => resetOps.push({ type: 'set', path: purchasesPath(), id: r.id, data: { remainingQty: r.qty }, merge: true }));
    resetOps.push({ type: 'set', path: productsPath(), id: productId, data: { initStockRemaining: product.initStock || 0 }, merge: true });
    if (resetOps.length) await batchWrite(resetOps);
    applyOpsToLocalCache(resetOps);

    const salesForProduct = SalesModule.getCache()
      .filter((r) => r.productId === productId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));

    for (const s of salesForProduct) {
      const result = consume(productId, s.qty || 0);
      const saveOps = result.ops.concat([{
        type: 'set', path: salesPath(), id: s.id,
        data: { costOfGoods: result.costOfGoods, costLots: result.costLots, costEstimated: result.estimated },
        merge: true
      }]);
      await batchWrite(saveOps);
      applyOpsToLocalCache(result.ops);
    }

    alert(`"${product.name}" 품목의 FIFO 재계산이 완료됐습니다 (매출 ${salesForProduct.length}건 반영)`);
  }

  return { getLots, consume, recalcProduct };
})();

window.FifoEngine = FifoEngine;
