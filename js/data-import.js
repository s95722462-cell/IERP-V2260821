// ══════════════════════════════════════════════════════════════
// data-import.js — 기존 ERP 데이터(엑셀) 일괄 가져오기
// iERP 2.0
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, excel-io.js,
//         fifo.js, customers.js, products.js, sales.js, purchase.js
//
// 설계 원칙:
//   - 순서가 중요하다: 거래처 → 품목 → 매입 → 매출. 매입/매출은
//     거래처명·품목명(정확히는 규격/모델명)으로 서로를 찾아 연결하기
//     때문에, 앞 단계가 끝난 뒤에 다음 단계를 올려야 정확히 이어진다.
//   - 매입/매출 원본 파일엔 전표번호가 없다(낱개 줄만 있음). 그래서
//     한 줄 = iERP 전표 1건(품목 1개짜리)으로 각각 새로 채번한다.
//     여러 줄을 날짜·거래처가 같다고 임의로 묶으면, 실제로는 다른
//     거래인데 잘못 합쳐질 위험이 있어 이 방식이 제일 안전하다.
//   - 매입/매출을 실제 거래일 오래된 순으로 하나씩 순서대로 저장한다.
//     매입을 전부 넣은 뒤에 매출을 넣으면, 오래된 매출이 나중 매입
//     뱃치에서 원가를 끌어오는 오류가 생긴다 — 반드시 날짜순 인터리브.
//   - genDocNo에 실제 거래일을 넘겨서, 전표번호에 오늘 날짜가 아니라
//     그 거래가 실제로 있었던 날짜가 들어가게 한다.
//   - 각 단계가 끝나면 해당 화면 모듈의 캐시(getCache() 배열)에 결과를
//     바로 반영해둔다 — Firestore 실시간 리스너가 돌아오길 기다리지
//     않고, 바로 다음 단계에서 이름으로 조회할 수 있게 하기 위함
//     (FifoEngine.applyOpsToLocalCache와 같은 이유의 같은 패턴).
//   - 매입/매출 파일의 "품목명/규격" 값은 iERP의 "규격"(모델명)에
//     해당한다. 등록된 품목 중 규격이 정확히 일치하는 걸 찾아 연결하고,
//     없으면(예: "일시_..." 같은 1회성 품목) 자유 입력 줄로 저장한다
//     (기존 매출/매입 등록 화면도 품목 매칭 안 되면 그렇게 동작함).
// ══════════════════════════════════════════════════════════════

const DataImportModule = (() => {
  function custPath() { const { currentUser } = getAuthState(); return `users/${currentUser.safeId}/companies/${curCompanyId()}/customers`; }
  function prodPath() { const { currentUser } = getAuthState(); return `users/${currentUser.safeId}/companies/${curCompanyId()}/products`; }
  function salesPath() { const { currentUser } = getAuthState(); return `users/${currentUser.safeId}/companies/${curCompanyId()}/sales`; }
  function purchasesPath() { const { currentUser } = getAuthState(); return `users/${currentUser.safeId}/companies/${curCompanyId()}/purchases`; }
  function counterPath() { const { currentUser } = getAuthState(); return `users/${currentUser.safeId}/companies/${curCompanyId()}/counters`; }

  let running = false;

  function init() {
    const panel = LayoutShell.registerPanel('dataimport');
    panel.innerHTML = `
      <div class="card">
        <div class="card-title">데이터 가져오기 (기존 ERP)</div>
        <div class="alert-banner">
          반드시 순서대로 진행하세요: ① 거래처 → ② 품목 → ③ 매입 → ④ 매출.
          매입·매출은 거래처명·품목 규격으로 서로 연결되기 때문에, 앞 단계가
          먼저 끝나 있어야 정확히 이어집니다. 건수가 많으면 시간이 걸릴 수
          있으니 진행 중엔 창을 닫거나 새로고침하지 마세요.
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">① 거래처 가져오기</div>
        <p style="font-size:12px;color:var(--text2);margin:0 0 8px">"거래처_정보" 파일을 그대로 올리면 됩니다. 이미 등록된 거래처명은 건너뜁니다.</p>
        <div class="btn-row">
          <input type="file" id="di-customers-file" accept=".xls,.xlsx">
          <button id="di-customers-btn">거래처 가져오기</button>
        </div>
        <pre class="di-log" id="di-customers-log"></pre>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">② 품목 가져오기</div>
        <p style="font-size:12px;color:var(--text2);margin:0 0 8px">
          "품목별_재고평가명세서" 파일. 품목분류(예: 기본그룹&gt;SV)의 마지막
          부분을 품목명으로, "품목명/규격" 칸을 규격으로 넣습니다. 매입·매출
          내역을 전부 가져올 예정이므로 초기재고는 0으로 두고(안 그러면
          재고가 두 번 잡힘), 기준단가는 재고금액÷현재재고로 추정해서 채웁니다.
        </p>
        <div class="btn-row">
          <input type="file" id="di-products-file" accept=".xls,.xlsx">
          <button id="di-products-btn">품목 가져오기</button>
        </div>
        <pre class="di-log" id="di-products-log"></pre>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">③ 매입 가져오기</div>
        <p style="font-size:12px;color:var(--text2);margin:0 0 8px">"기간별_구매명세서_상세" 파일. 한 줄을 전표 1건으로 보고 실제 거래일 기준으로 새로 채번합니다. 건수가 많으면 몇 분 걸릴 수 있습니다.</p>
        <label class="di-legacy-label" style="display:flex;gap:6px;align-items:flex-start;font-size:12px;margin:0 0 8px"><input type="checkbox" id="di-purchases-legacy" checked style="width:auto;margin-top:2px"><span><b>과거 자료로만 보관</b> — 재고·원가에 연결하지 않음, 같은 날·같은 거래처 줄은 전표 1건으로 묶음, 파일의 공급가액·부가세 그대로, 이미 올린 줄은 건너뜀</span></label>
        <div class="btn-row">
          <input type="file" id="di-purchases-file" accept=".xls,.xlsx">
          <button id="di-purchases-btn">매입 가져오기</button>
        </div>
        <pre class="di-log" id="di-purchases-log"></pre>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">④ 매출 가져오기</div>
        <p style="font-size:12px;color:var(--text2);margin:0 0 8px">"기간별_판매명세서_상세" 파일. 반드시 매입을 먼저 가져온 뒤에 진행하세요 — 등록된 매입 내역 기준으로 FIFO 매출원가를 계산합니다.</p>
        <label class="di-legacy-label" style="display:flex;gap:6px;align-items:flex-start;font-size:12px;margin:0 0 8px"><input type="checkbox" id="di-sales-legacy" checked style="width:auto;margin-top:2px"><span><b>과거 자료로만 보관</b> — 재고·원가에 연결하지 않음(지금 재고·FIFO 그대로), 같은 날·같은 거래처 줄은 전표 1건으로 묶음, 파일의 공급가액·부가세 그대로, 이미 올린 줄은 건너뜀</span></label>
        <div class="btn-row">
          <input type="file" id="di-sales-file" accept=".xls,.xlsx">
          <button id="di-sales-btn">매출 가져오기</button>
        </div>
        <pre class="di-log" id="di-sales-log"></pre>
      </div>
    `;

    document.getElementById('di-customers-btn').addEventListener('click', () => run('customers'));
    document.getElementById('di-products-btn').addEventListener('click', () => run('products'));
    document.getElementById('di-purchases-btn').addEventListener('click', () => run('purchases'));
    document.getElementById('di-sales-btn').addEventListener('click', () => run('sales'));
  }

  // ── 화면 표시 도우미 ──────────────────────────────────────
  function log(kind, msg) {
    const el = document.getElementById(`di-${kind}-log`);
    if (!el) return;
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
  function clearLog(kind) {
    const el = document.getElementById(`di-${kind}-log`);
    if (el) el.textContent = '';
  }

  async function run(kind) {
    if (running) { alert('다른 가져오기 작업이 진행 중입니다. 끝난 뒤 다시 시도해주세요.'); return; }
    const fileInput = document.getElementById(`di-${kind}-file`);
    const file = fileInput.files[0];
    if (!file) { alert('파일을 먼저 선택해주세요'); return; }

    const btn = document.getElementById(`di-${kind}-btn`);
    running = true;
    btn.disabled = true;
    clearLog(kind);
    log(kind, '파일을 읽는 중...');

    try {
      let result;
      if (kind === 'customers') result = await importCustomers(file);
      else if (kind === 'products') result = await importProducts(file);
      else if (kind === 'purchases' || kind === 'sales') {
        const txType = kind === 'sales' ? 'sale' : 'purchase';
        const legacy = document.getElementById(`di-${kind}-legacy`)?.checked;
        result = legacy ? await importLegacyTransactions(file, txType, kind) : await importTransactions(file, txType, kind);
      }

      log(kind, `완료 — 전체 ${result.total}건 중 새로 등록 ${result.added}건, 건너뜀(중복/기존) ${result.skippedDup || 0}건, 형식 오류로 제외 ${result.invalid || 0}건${result.failed ? `, 실패 ${result.failed}건` : ''}`);
      alert(`${kindLabel(kind)} 가져오기 완료\n\n새로 등록: ${result.added}건`);
    } catch (err) {
      log(kind, '오류: ' + err.message);
      alert('가져오는 중 오류가 발생했습니다: ' + err.message);
      console.error('[데이터 가져오기 실패]', kind, err);
    } finally {
      running = false;
      btn.disabled = false;
      fileInput.value = '';
    }
  }

  function kindLabel(kind) {
    return { customers: '거래처', products: '품목', purchases: '매입', sales: '매출' }[kind] || kind;
  }

  // ── 엑셀 공통: 헤더 줄 찾기 + 객체 배열로 변환 ──────────────
  /** aoa(행의 배열)에서, requiredHeaders를 전부 담고 있는 첫 번째 줄을 찾는다. */
  function findHeaderRow(aoa, requiredHeaders) {
    for (let i = 0; i < aoa.length; i++) {
      const row = (aoa[i] || []).map((c) => String(c == null ? '' : c).trim());
      if (requiredHeaders.every((h) => row.includes(h))) return i;
    }
    return -1;
  }

  /** headerRowIdx 다음 줄부터를, 헤더를 키로 하는 객체 배열로 바꾼다.
   * 완전히 빈 줄(모든 칸이 공백)은 제외한다. */
  function rowsFromAOA(aoa, headerRowIdx) {
    const headers = (aoa[headerRowIdx] || []).map((c) => String(c == null ? '' : c).trim());
    return aoa.slice(headerRowIdx + 1)
      .filter((r) => (r || []).some((c) => String(c == null ? '' : c).trim() !== ''))
      .map((r) => {
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = r[i]; });
        return obj;
      });
  }

  /** 날짜 칸(Date 객체 또는 문자열)을 'YYYY-MM-DD' 문자열로 통일한다. */
  function toDateStr(v) {
    if (!v) return '';
    if (v instanceof Date) {
      const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    const m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    return '';
  }

  // ── ① 거래처 가져오기 ──────────────────────────────────────
  async function importCustomers(file) {
    const aoa = await ExcelIO.readFileAOA(file);
    const headerIdx = findHeaderRow(aoa, ['거래처명', '사업자번호']);
    if (headerIdx === -1) throw new Error('"거래처명"/"사업자번호" 헤더를 찾지 못했습니다. 거래처_정보 파일이 맞는지 확인해주세요.');
    const rows = rowsFromAOA(aoa, headerIdx);

    const existingNames = new Set(CustomersModule.getCache().map((c) => (c.name || '').trim()).filter(Boolean));
    const ops = [];
    let added = 0, skippedDup = 0, invalid = 0;

    rows.forEach((r) => {
      const name = String(r['거래처명'] || '').trim();
      if (!name) { invalid++; return; }
      if (existingNames.has(name)) { skippedDup++; return; }

      const addr = [r['주소1'], r['주소2']].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
      const id = genId();
      const data = {
        name,
        bizno: String(r['사업자번호'] || '').trim(),
        ceo: String(r['대표자명'] || '').trim(),
        biztype: String(r['업태'] || '').trim(),
        bizitem: String(r['종목'] || '').trim(),
        tel: String(r['전화번호'] || '').trim(),
        email: '',
        addr,
        memo: '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      ops.push({ type: 'set', path: custPath(), id, data });
      CustomersModule.getCache().push({ id, ...data, createdAt: new Date() });
      existingNames.add(name);
      added++;
    });

    if (ops.length) await batchWrite(ops);
    return { total: rows.length, added, skippedDup, invalid };
  }

  // ── ② 품목 가져오기 ──────────────────────────────────────
  async function importProducts(file) {
    const aoa = await ExcelIO.readFileAOA(file);
    const headerIdx = findHeaderRow(aoa, ['품목코드', '품목명/규격']);
    if (headerIdx === -1) throw new Error('"품목코드"/"품목명/규격" 헤더를 찾지 못했습니다. 품목별_재고평가명세서 파일이 맞는지 확인해주세요.');
    const rows = rowsFromAOA(aoa, headerIdx);

    const existingKeys = new Set(ProductsModule.getCache().map((p) => `${p.name || ''}|${p.spec || ''}`));
    const ops = [];
    let added = 0, skippedDup = 0, invalid = 0;

    rows.forEach((r) => {
      const spec = String(r['품목명/규격'] || '').trim();
      if (!spec) { invalid++; return; }
      const category = String(r['품목분류'] || '').trim();
      const name = category.includes('>') ? category.split('>').pop().trim() : (category || '기타');
      const key = `${name}|${spec}`;
      if (existingKeys.has(key)) { skippedDup++; return; }

      const qty = rawNum(r['현재재고']);
      const stockValue = rawNum(r['재고금액']);
      const price = qty > 0 ? Math.round(stockValue / qty) : 0;

      const id = genId();
      const data = {
        code: String(r['품목코드'] || '').trim(),
        name, spec,
        maker: '',
        price,
        unit: String(r['단위'] || '').trim(),
        // 매입·매출 내역을 전부 가져올 예정이므로 초기재고는 0 —
        // 안 그러면 매입 누적분과 겹쳐서 재고가 두 배로 잡힌다.
        initStock: 0,
        safeStock: 0,
        memo: '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      ops.push({ type: 'set', path: prodPath(), id, data });
      ProductsModule.getCache().push({ id, ...data, createdAt: new Date() });
      existingKeys.add(key);
      added++;
    });

    if (ops.length) await batchWrite(ops);
    return { total: rows.length, added, skippedDup, invalid };
  }

  // ── 거래처 이름으로 찾고, 없으면 최소 정보로 새로 만든다 ──────
  async function findOrCreateCustomer(name) {
    name = String(name || '').trim();
    if (!name) return null;
    const found = CustomersModule.getCache().find((c) => (c.name || '').trim() === name);
    if (found) return found;

    const id = genId();
    const data = {
      name, bizno: '', ceo: '', biztype: '', bizitem: '', tel: '', email: '', addr: '',
      memo: '매입·매출 가져오기 중 자동 생성됨 — 정보 확인 필요',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await batchWrite([{ type: 'set', path: custPath(), id, data }]);
    const obj = { id, ...data, createdAt: new Date() };
    CustomersModule.getCache().push(obj);
    return obj;
  }

  // ── ③④ 매입/매출 가져오기 (한 줄 = 전표 1건, 날짜순 처리) ──────
  async function importTransactions(file, txType, kind) {
    const isSale = txType === 'sale';
    const aoa = await ExcelIO.readFileAOA(file);
    const headerIdx = findHeaderRow(aoa, ['거래일자', '거래처명', '품목명/규격']);
    if (headerIdx === -1) throw new Error('"거래일자"/"거래처명"/"품목명/규격" 헤더를 찾지 못했습니다. 파일 형식을 확인해주세요.');
    const rawRows = rowsFromAOA(aoa, headerIdx);

    const parsed = rawRows.map((r, idx) => ({
      date: toDateStr(r['거래일자']),
      party: String(r['거래처명'] || '').trim(),
      itemRaw: String(r['품목명/규격'] || '').trim(),
      qty: rawNum(r['수량']),
      unitPrice: rawNum(r['단가']),
      memo: String(r['비고'] || '').trim(),
      _idx: idx
    })).filter((r) => r.date && r.party && r.itemRaw);
    const invalid = rawRows.length - parsed.length;

    // 파일 안에서도 순서가 뒤섞여 있을 수 있어, 실제 거래일 오래된 순으로
    // 다시 정렬한 뒤 하나씩 처리한다 (매입을 먼저 다 넣고 매출을 넣으면
    // FIFO가 미래 매입에서 원가를 끌어오는 오류가 생기므로, 매입/매출을
    // 각각 이 함수로 따로 부르더라도 "날짜순 처리" 원칙은 지켜야 한다 —
    // 그래서 반드시 매입을 먼저 전부 가져온 뒤에 매출을 가져오도록 안내함).
    parsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._idx - b._idx));

    const path = isSale ? salesPath() : purchasesPath();
    const prefix = isSale ? 'S' : 'P';
    let added = 0, failed = 0;

    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i];
      try {
        const party = await findOrCreateCustomer(r.party);
        const product = ProductsModule.getCache().find((p) => (p.spec || '').trim() === r.itemRaw);
        const subtotal = r.qty * r.unitPrice;
        const vat = Math.round(subtotal * 0.1);
        const total = subtotal + vat;

        const docNo = await genDocNo(counterPath(), prefix, r.date);
        const id = genId();
        const data = {
          docNo, date: r.date,
          item: product ? product.name : r.itemRaw,
          spec: product ? product.spec : '',
          productId: product ? product.id : '',
          qty: r.qty, unitPrice: r.unitPrice,
          subtotal, vat, total,
          invNo: '', memo: r.memo
        };
        if (isSale) {
          data.buyerId = party ? party.id : '';
          data.buyer = party ? party.name : r.party;
        } else {
          data.vendorId = party ? party.id : '';
          data.vendor = party ? party.name : r.party;
          data.remainingQty = r.qty;
        }

        const ops = [];
        if (isSale && product) {
          const fifo = FifoEngine.consume(product.id, r.qty);
          data.costOfGoods = fifo.costOfGoods;
          data.costLots = fifo.costLots;
          data.costEstimated = fifo.estimated;
          ops.push(...fifo.ops);
          FifoEngine.applyOpsToLocalCache(fifo.ops);
        }
        ops.push({ type: 'set', path, id, data });
        await batchWrite(ops);

        if (isSale) SalesModule.getCache().push({ id, ...data });
        else PurchaseModule.getCache().push({ id, ...data });

        added++;
      } catch (e) {
        failed++;
        console.error('[가져오기 실패]', r, e);
      }

      if (kind && (i % 50 === 0 || i === parsed.length - 1)) {
        log(kind, `처리 중... ${i + 1}/${parsed.length}건 (성공 ${added}, 실패 ${failed})`);
      }
    }

    return { total: rawRows.length, added, invalid, failed };
  }

  // ── ③④ 과거 자료로만 보관 (2026-11-17, (주)겐시스템 2021~2025 원장) ──────
  // 지금 쓰는 자료와 부딪히지 않게:
  //   - productId 를 비우고 legacy:true 를 붙인다 → 재고현황(stock.js)·FIFO 에서
  //     빠지므로 지금 재고·매출원가가 바뀌지 않는다. 매입 remainingQty 도 0.
  //   - 공급가액·부가세·합계는 파일 값 그대로 (영세율 0원 줄이 10%로 바뀌지 않게).
  //   - 같은 날·같은 거래처 줄은 전표번호 1개로 묶는다 (원장은 거래처별 명세서
  //     한 장이 날짜별로 여러 줄로 풀려 있는 형태). 번호 날짜 = 실제 거래일,
  //     날짜별 카운터를 한 번에 n개 예약 → 그날 이미 있는 번호 다음부터.
  //   - 이미 같은 줄(날짜·거래처·품목·수량·단가·공급가액)이 있으면 그 개수만큼
  //     건너뛴다 → 같은 파일을 두 번 올려도 두 번 들어가지 않는다.
  async function reserveDocNos(prefix, date, n) {
    const day = date.replace(/-/g, '');
    const ref = db.collection(counterPath()).doc(prefix + day);
    const start = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data().seq || 0) : 0;
      tx.set(ref, { seq: cur + n }, { merge: true });
      return cur + 1;
    });
    return Array.from({ length: n }, (_, i) => `${prefix}${day}-${String(start + i).padStart(2, '0')}`);
  }

  async function importLegacyTransactions(file, txType, kind) {
    const isSale = txType === 'sale';
    const aoa = await ExcelIO.readFileAOA(file);
    const headerIdx = findHeaderRow(aoa, ['거래일자', '거래처명', '품목명/규격']);
    if (headerIdx === -1) throw new Error('"거래일자"/"거래처명"/"품목명/규격" 헤더를 찾지 못했습니다. 파일 형식을 확인해주세요.');
    const rawRows = rowsFromAOA(aoa, headerIdx);
    const has = (r, k) => r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '';

    const parsed = rawRows.map((r, idx) => {
      const qty = rawNum(r['수량']);
      const unitPrice = rawNum(r['단가']);
      const subtotal = has(r, '공급가액') ? rawNum(r['공급가액']) : qty * unitPrice;
      const vat = has(r, '부가세') ? rawNum(r['부가세']) : Math.round(subtotal * 0.1);
      const total = has(r, '합계') ? rawNum(r['합계']) : subtotal + vat;
      return {
        date: toDateStr(r['거래일자']),
        party: String(r['거래처명'] || '').trim(),
        itemRaw: String(r['품목명/규격'] || '').trim(),
        qty, unitPrice, subtotal, vat, total,
        memo: String(r['비고'] || '').trim(),
        _idx: idx
      };
    }).filter((r) => r.date && r.party && r.itemRaw);
    const invalid = rawRows.length - parsed.length;
    parsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._idx - b._idx));

    // 이미 들어 있는 줄 (같은 파일 다시 올림 대비)
    const cache = isSale ? SalesModule.getCache() : PurchaseModule.getCache();
    const keyOf = (date, party, item, qty, price, sub) => [date, party, item, rawNum(qty), rawNum(price), rawNum(sub)].join('|');
    const existing = new Map();
    cache.forEach((r) => {
      const party = String((isSale ? r.buyer : r.vendor) || '').trim();
      [r.item, r.spec].map((v) => String(v || '').trim()).filter(Boolean).forEach((item) => {
        const k = keyOf(r.date, party, item, r.qty, r.unitPrice, r.subtotal);
        existing.set(k, (existing.get(k) || 0) + 1);
      });
    });
    let skippedDup = 0;
    const todo = parsed.filter((r) => {
      const k = keyOf(r.date, r.party, r.itemRaw, r.qty, r.unitPrice, r.subtotal);
      const n = existing.get(k) || 0;
      if (n > 0) { existing.set(k, n - 1); skippedDup++; return false; }
      return true;
    });

    // 날짜+거래처로 묶기 (정렬 순서 유지)
    const groups = [];
    const gmap = new Map();
    todo.forEach((r) => {
      const gk = `${r.date}|${r.party}`;
      if (!gmap.has(gk)) { const g = { date: r.date, party: r.party, rows: [] }; gmap.set(gk, g); groups.push(g); }
      gmap.get(gk).rows.push(r);
    });

    const path = isSale ? salesPath() : purchasesPath();
    const prefix = isSale ? 'S' : 'P';
    const byDate = new Map();
    groups.forEach((g) => { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); });

    let added = 0, failed = 0, docs = 0, sumSub = 0, sumVat = 0, sumTotal = 0;
    let ops = [], pending = [];
    const flush = async () => {
      if (!ops.length) return;
      await batchWrite(ops);
      pending.forEach((row) => cache.push(row));
      added += pending.length;
      ops = []; pending = [];
    };

    const dates = [...byDate.keys()];
    for (let di = 0; di < dates.length; di++) {
      const date = dates[di];
      const dayGroups = byDate.get(date);
      try {
        const nos = await reserveDocNos(prefix, date, dayGroups.length);
        for (let gi = 0; gi < dayGroups.length; gi++) {
          const g = dayGroups[gi];
          const party = await findOrCreateCustomer(g.party);
          docs++;
          g.rows.forEach((r) => {
            const id = genId();
            const data = {
              docNo: nos[gi], date: r.date,
              item: r.itemRaw, spec: '', productId: '',
              qty: r.qty, unitPrice: r.unitPrice,
              subtotal: r.subtotal, vat: r.vat, total: r.total,
              invNo: '', memo: r.memo,
              legacy: true, importSrc: String(file.name || '').slice(0, 120)
            };
            if (isSale) {
              data.buyerId = party ? party.id : '';
              data.buyer = party ? party.name : r.party;
              data.isReturn = r.qty < 0;
            } else {
              data.vendorId = party ? party.id : '';
              data.vendor = party ? party.name : r.party;
              data.remainingQty = 0;
            }
            ops.push({ type: 'set', path, id, data });
            pending.push({ id, ...data });
            sumSub += r.subtotal; sumVat += r.vat; sumTotal += r.total;
          });
        }
        await flush(); // 날짜마다 저장 — 한 날짜가 실패해도 앞 날짜는 남고, 다시 올리면 남은 것만 들어감
      } catch (e) {
        failed += pending.length; ops = []; pending = [];
        console.error('[과거 자료 가져오기 실패]', date, e);
        log(kind, `실패: ${date} — ${e.message}`);
      }
      if (di % 20 === 0 || di === dates.length - 1) log(kind, `처리 중... 날짜 ${di + 1}/${dates.length}`);
    }
    try { await flush(); } catch (e) { failed += pending.length; log(kind, '실패(마지막 저장): ' + e.message); }

    log(kind, `전표 ${docs}건 · 줄 ${todo.length}건 · 공급가액 ${fmtNum(sumSub)} · 부가세 ${fmtNum(sumVat)} · 합계 ${fmtNum(sumTotal)}`);
    return { total: rawRows.length, added, skippedDup, invalid, failed };
  }

  return { init };
})();

window.DataImportModule = DataImportModule;
