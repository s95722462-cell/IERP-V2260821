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
//   - 예외: 매입을 수정·삭제하거나 과거 날짜로 새 매입을 넣으면 뱃치 자체가
//     바뀌므로, purchase.js가 해당 품목만 자동으로 재계산한다 (값이 달라진
//     문서만 저장하므로 쓰기량은 작다). 매출 수정·삭제는 release()로 처리.
//   - 반품(음수 수량)은 restock()이 가장 최근 출고 뱃치로 원가 그대로 되돌린다.
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
    if (qty < 0) return restock(productId, -qty);
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

  /** 초기재고 가상 뱃치 + 매입 뱃치 전부(이미 다 팔린 것 포함)를, 원래 수량
   * (originalQty)과 남은 수량을 함께 담아 반환한다 — 반품 복귀용. */
  function getAllLots(productId) {
    const product = ProductsModule.getCache().find((p) => p.id === productId);
    const lots = [];
    if (product) {
      const orig = product.initStock || 0;
      const rem = product.initStockRemaining !== undefined ? product.initStockRemaining : orig;
      lots.push({ type: 'init', id: product.id, date: '0000-00-00', unitPrice: product.price || 0, remainingQty: rem, originalQty: orig });
    }
    PurchaseModule.getCache()
      .filter((r) => r.productId === productId)
      .forEach((r) => lots.push({
        type: 'purchase', id: r.id, date: r.date, unitPrice: r.unitPrice || 0,
        remainingQty: r.remainingQty !== undefined ? r.remainingQty : r.qty, originalQty: r.qty || 0
      }));
    lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));
    return lots;
  }

  /**
   * 반품(매출취소) 수량을 재고로 되돌린다. FIFO에서 가장 나중에 출고된
   * 뱃치(= 이미 일부라도 팔린 뱃치 중 가장 최근 것)부터 원래 수량 한도까지
   * 채워 넣고, 그 뱃치 단가만큼을 마이너스 매출원가로 기록한다 — 즉 "나갈 때의
   * 원가 그대로 되돌아온다". 되돌릴 자리가 없으면(팔린 적 없는 품목의 반품 등)
   * 마지막 단가로 추정한 마이너스 원가만 남긴다 (estimated 표시).
   * costLots의 qty는 음수로 기록해서, release()가 반품 줄을 수정·삭제할 때
   * 그 복귀분을 다시 빼낼 수 있게 한다.
   */
  function restock(productId, qty) {
    const lots = getAllLots(productId).reverse();
    let remaining = qty;
    let cost = 0;
    const used = [];
    const ops = [];
    for (const lot of lots) {
      if (remaining <= 0) break;
      const room = lot.originalQty - lot.remainingQty;
      const put = Math.min(remaining, room);
      if (put <= 0) continue;
      cost -= put * lot.unitPrice;
      used.push({ type: lot.type, id: lot.id, qty: -put, unitPrice: lot.unitPrice });
      remaining -= put;
      const newRemaining = lot.remainingQty + put;
      if (lot.type === 'init') {
        ops.push({ type: 'set', path: productsPath(), id: lot.id, data: { initStockRemaining: newRemaining }, merge: true });
      } else {
        ops.push({ type: 'set', path: purchasesPath(), id: lot.id, data: { remainingQty: newRemaining }, merge: true });
      }
    }
    let estimated = false;
    if (remaining > 0) {
      const lastPrice = lots.length ? lots[0].unitPrice : 0;
      cost -= remaining * lastPrice;
      used.push({ type: 'estimate', qty: -remaining, unitPrice: lastPrice });
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

  /**
   * 매출 줄들이 저장 당시 소진했던 뱃치(costLots)를 원래대로 되돌리는 ops를
   * 만든다. 매출을 수정(기존 줄 삭제 후 재저장)하거나 삭제할 때 같은 batch에
   * 묶어서 커밋해야, 재고가 이중 차감되거나 삭제 후에도 빠진 채로 남지 않는다.
   * 일반 매출(qty 양수)은 뱃치에 수량을 돌려놓고, 반품(qty 음수 — restock()이
   * 채워 넣었던 분량)은 반대로 다시 빼낸다. 결과는 0~원래 수량 범위로 맞춘다.
   * 이미 삭제된 매입/품목을 가리키는 뱃치는 건너뛴다 (merge set으로 빈 문서가
   * 새로 생기는 걸 막기 위함). costLots가 없는 옛 매출은 되돌릴 정보가 없어
   * 아무 것도 하지 않는다 — 그런 경우는 재고현황의 "FIFO 재계산"으로 맞춘다.
   * @returns {object[]} batchWrite ops
   */
  function release(saleRows) {
    const purchaseQty = {};
    const initQty = {};
    saleRows.forEach((s) => (s.costLots || []).forEach((lot) => {
      if (!lot.qty) return;
      if (lot.type === 'purchase') purchaseQty[lot.id] = (purchaseQty[lot.id] || 0) + lot.qty;
      else if (lot.type === 'init') initQty[lot.id] = (initQty[lot.id] || 0) + lot.qty;
    }));
    const clamp = (v, max) => Math.max(0, Math.min(v, max));

    const ops = [];
    Object.entries(purchaseQty).forEach(([id, qty]) => {
      const r = PurchaseModule.getCache().find((x) => x.id === id);
      if (!r) return;
      const cur = r.remainingQty !== undefined ? r.remainingQty : r.qty;
      ops.push({ type: 'set', path: purchasesPath(), id, data: { remainingQty: clamp(cur + qty, r.qty || 0) }, merge: true });
    });
    Object.entries(initQty).forEach(([id, qty]) => {
      const p = ProductsModule.getCache().find((x) => x.id === id);
      if (!p) return;
      const cur = p.initStockRemaining !== undefined ? p.initStockRemaining : (p.initStock || 0);
      ops.push({ type: 'set', path: productsPath(), id, data: { initStockRemaining: clamp(cur + qty, p.initStock || 0) }, merge: true });
    });
    return ops;
  }

  /**
   * 품목 하나의 FIFO를 처음부터 다시 계산한다: 모든 매입 뱃치와 초기재고를
   * 원래 수량으로 리셋한 뒤, 그 품목이 들어간 모든 매출(반품 포함)을 날짜
   * 오래된 순으로 다시 훑으며 소진/복귀시킨다.
   * 계산은 전부 메모리에서 먼저 끝내고, 실제로 값이 달라진 문서만 저장한다
   * — 예전엔 매출 한 건마다 무조건 다시 썼어서, 매출이 많은 품목은 한 번
   * 누를 때마다 수백 건씩 쓰기가 발생했다(Firestore 무료 한도 부담).
   * 재고현황의 수동 버튼과, 매입 수정·삭제 직후의 자동 재계산이 같이 쓴다.
   * @param {string} productId
   * @param {{silent?:boolean}} [opts] - silent면 완료 alert를 띄우지 않는다
   * @returns {Promise<{sales:number, changedSales:number, changedLots:number}|undefined>}
   */
  async function recalcProduct(productId, { silent = false } = {}) {
    const product = ProductsModule.getCache().find((p) => p.id === productId);
    if (!product) { if (!silent) alert('품목을 찾을 수 없습니다'); return; }

    const purchases = PurchaseModule.getCache().filter((r) => r.productId === productId);
    const origRemaining = new Map(purchases.map((r) => [r.id, r.remainingQty]));
    const origInit = product.initStockRemaining;
    purchases.forEach((r) => { r.remainingQty = r.qty; });
    product.initStockRemaining = product.initStock || 0;

    const salesForProduct = SalesModule.getCache()
      .filter((r) => r.productId === productId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));

    const saleUpdates = [];
    for (const s of salesForProduct) {
      const result = consume(productId, s.qty || 0);
      applyOpsToLocalCache(result.ops);
      const changed = s.costOfGoods !== result.costOfGoods
        || !!s.costEstimated !== result.estimated
        || JSON.stringify(s.costLots || null) !== JSON.stringify(result.costLots);
      if (changed) saleUpdates.push({ s, data: { costOfGoods: result.costOfGoods, costLots: result.costLots, costEstimated: result.estimated } });
    }

    const lotOps = [];
    purchases.forEach((r) => {
      if (origRemaining.get(r.id) !== r.remainingQty) {
        lotOps.push({ type: 'set', path: purchasesPath(), id: r.id, data: { remainingQty: r.remainingQty }, merge: true });
      }
    });
    if (origInit !== product.initStockRemaining) {
      lotOps.push({ type: 'set', path: productsPath(), id: productId, data: { initStockRemaining: product.initStockRemaining }, merge: true });
    }
    const ops = lotOps.concat(saleUpdates.map((u) => ({ type: 'set', path: salesPath(), id: u.s.id, data: u.data, merge: true })));

    try {
      if (ops.length) await batchWrite(ops);
    } catch (err) {
      // 저장 실패 시 로컬 캐시를 원래 값으로 되돌려, 화면이 저장 안 된 계산 결과를 보여주지 않게 한다
      purchases.forEach((r) => { r.remainingQty = origRemaining.get(r.id); });
      product.initStockRemaining = origInit;
      throw err;
    }
    saleUpdates.forEach((u) => Object.assign(u.s, u.data));

    if (!silent) alert(`"${product.name}" 품목의 FIFO 재계산이 완료됐습니다 (매출 ${salesForProduct.length}건 확인, 원가 변경 ${saleUpdates.length}건)`);
    return { sales: salesForProduct.length, changedSales: saleUpdates.length, changedLots: lotOps.length };
  }

  return { getLots, consume, release, applyOpsToLocalCache, recalcProduct };
})();

window.FifoEngine = FifoEngine;
