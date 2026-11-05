// ══════════════════════════════════════════════════════════════
// products.js — 품목 등록 · 목록 · 수정
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, db.js, auth.js, layout-shell.js, table-engine.js
// 데이터 경로: users/{safeId}/companies/{companyId}/products/{id}
// ══════════════════════════════════════════════════════════════

const ProductsModule = (() => {
  let cache = [];
  let tableInstance = null;
  let editingId = null;
  let pendingNew = null; // 방금 새로 저장한 품목 (저장 성공 후 매입/매출 바로 작성 제안용)
  let unsubscribe = null;
  let updateListeners = [];

  function path() {
    const { currentUser } = getAuthState();
    return `users/${currentUser.safeId}/companies/${curCompanyId()}/products`;
  }

  function init() {
    const panel = LayoutShell.registerPanel('products');
    panel.innerHTML = `
      <div class="card" id="pr-list-card">
        <div class="card-title card-title-action" style="display:flex;align-items:center">
          품목 목록
          <button class="ls-btn-primary" id="pr-add-btn" style="margin-left:auto;width:auto">+ 새 품목 추가</button>
        </div>
      </div>

      <details class="card" style="margin-top:16px">
        <summary class="card-title" style="cursor:pointer">엑셀 대량 업로드 / 관리</summary>
        <div class="btn-row" style="margin-top:10px">
          <button id="pr-tmpl-btn">엑셀 템플릿 다운로드</button>
          <button id="pr-upload-btn">엑셀 업로드(대량 등록)</button>
          <button id="pr-export-btn">엑셀 다운로드(현재 품목)</button>
          <button id="pr-fix-btn" title="예전 엑셀 업로드로 등록됐지만 화면에 안 보이는 품목이 있으면 복구합니다">숨은 품목 복구</button>
          <button id="pr-delete-all-btn" style="color:var(--red)" title="이 회사의 품목을 전부 삭제합니다 (되돌릴 수 없음)">전체 품목 일괄 삭제</button>
          <input type="file" id="pr-upload-input" accept=".xlsx,.xls,.csv" style="display:none">
        </div>
      </details>

      <div class="side-panel-bg" id="pr-panel-bg" style="display:none">
        <div class="side-panel">
          <div class="card-title" style="display:flex;align-items:center">
            <span id="pr-panel-title">새 품목 등록</span>
            <button id="pr-panel-close" style="margin-left:auto" aria-label="닫기" title="닫기">✕</button>
          </div>
          <div class="form-grid">
            <div class="form-section">기본 정보</div>
            <div class="fg"><label>품목코드</label><input id="pr-code"></div>
            <div class="fg"><label>품목명 *</label><input id="pr-name" placeholder="부품명/모델명"></div>
            <div class="fg"><label>규격/사양</label><input id="pr-spec"></div>
            <div class="fg"><label>제조사</label><input id="pr-maker"></div>
            <div class="form-section">단가 · 재고</div>
            <div class="fg"><label>기준단가</label><input id="pr-price" type="text" inputmode="numeric" value="0"></div>
            <div class="fg"><label>단위</label><input id="pr-unit" placeholder="EA/SET/BOX"></div>
            <div class="fg"><label>초기재고</label><input id="pr-initstock" type="number" value="0"></div>
            <div class="fg"><label>안전재고(경고기준)</label><input id="pr-safestock" type="number" value="0"></div>
            <div class="form-section">메모</div>
            <div class="fg" style="grid-column:1/-1"><label>메모</label><input id="pr-memo"></div>
          </div>
          <div class="btn-row" style="margin-top:10px">
            <button class="ls-btn-primary" id="pr-save-btn" style="width:auto">저장</button>
            <button id="pr-cancel-btn">취소</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('pr-add-btn').addEventListener('click', () => { fillForm(null); openPanel(); });
    bindCommaInput(document.getElementById('pr-price'));
    document.getElementById('pr-panel-close').addEventListener('click', closePanel);
    document.getElementById('pr-panel-bg').addEventListener('click', (e) => {
      if (e.target.id === 'pr-panel-bg') closePanel(); // 패널 바깥(어두운 배경) 클릭 시 닫기
    });
    bindSaveButton(document.getElementById('pr-save-btn'), save, () => {
      closePanel();
      // 새로 추가한 품목이면 바로 매입/매출 전표로 이어서 작성할지 묻는다 (수정 때는 묻지 않음)
      if (pendingNew) { const d = pendingNew; pendingNew = null; offerQuickTx(d); }
    });
    document.getElementById('pr-cancel-btn').addEventListener('click', closePanel);
    document.getElementById('pr-tmpl-btn').addEventListener('click', downloadTemplate);
    document.getElementById('pr-export-btn').addEventListener('click', exportExcel);
    document.getElementById('pr-upload-btn').addEventListener('click', () => document.getElementById('pr-upload-input').click());
    document.getElementById('pr-upload-input').addEventListener('change', handleUpload);
    document.getElementById('pr-fix-btn').addEventListener('click', fixMissingCreatedAt);
    document.getElementById('pr-delete-all-btn').addEventListener('click', deleteAllProducts);

    tableInstance = TableEngine.create('products', {
      container: document.getElementById('pr-list-card'),
      columns: [
        { key: '__no', label: 'No.', align: 'center' },
        { key: 'code', label: '코드' },
        { key: 'name', label: '품목명' },
        { key: 'spec', label: '규격' },
        { key: 'maker', label: '제조사' },
        { key: 'price', label: '기준단가', align: 'right', render: (v) => '₩' + fmtNum(v) },
        { key: 'unit', label: '단위' },
        { key: 'safeStock', label: '안전재고', align: 'right' },
        { key: 'memo', label: '메모' }
      ],
      searchFields: ['name', 'code', 'spec'],
      maxHeight: 440,
      rowActions: (row) => rowIconBtn('edit', row.id) + rowIconBtn('del', row.id)
    });

    document.getElementById('pr-list-card').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') startEdit(id);
      if (btn.getAttribute('data-act') === 'del') remove(id);
    });
  }

  /** 오른쪽 슬라이드 패널을 연다 (새 품목 추가 / 수정 공용). */
  function openPanel() {
    document.getElementById('pr-panel-bg').style.display = 'flex';
    EntryUI.setPageMode('pr-panel-bg', true, closePanel); // 팝업 대신 본문 화면으로 (매출·매입과 같게)
  }

  /** 패널을 닫고 폼을 비운다. */
  function closePanel() {
    document.getElementById('pr-panel-bg').style.display = 'none';
    EntryUI.setPageMode('pr-panel-bg', false);
    fillForm(null);
  }

  function startListening() {
    if (unsubscribe) unsubscribe();
    unsubscribe = DbEngine.listen(path(), {
      orderBy: { field: 'createdAt', direction: 'desc' },
      onData: (docs) => { cache = docs; tableInstance.render(cache); updateListeners.forEach((cb) => cb(cache)); }
    });
  }

  function fillForm(row) {
    document.getElementById('pr-code').value = row?.code || '';
    document.getElementById('pr-name').value = row?.name || '';
    document.getElementById('pr-spec').value = row?.spec || '';
    document.getElementById('pr-maker').value = row?.maker || '';
    document.getElementById('pr-price').value = (row?.price ?? 0).toLocaleString();
    document.getElementById('pr-unit').value = row?.unit || '';
    document.getElementById('pr-initstock').value = row?.initStock ?? 0;
    document.getElementById('pr-safestock').value = row?.safeStock ?? 0;
    document.getElementById('pr-memo').value = row?.memo || '';
    editingId = row ? row.id : null;
    document.getElementById('pr-panel-title').textContent = row ? '품목 수정' : '새 품목 등록';
    document.getElementById('pr-save-btn').textContent = row ? '수정 저장' : '저장';
  }

  function startEdit(id) {
    const row = cache.find((r) => r.id === id);
    if (row) { fillForm(row); openPanel(); }
  }

  async function save() {
    const name = document.getElementById('pr-name').value.trim();
    pendingNew = null;
    if (!name) { alert('품목명을 입력하세요'); return false; }
    const data = {
      code: document.getElementById('pr-code').value,
      name,
      spec: document.getElementById('pr-spec').value,
      maker: document.getElementById('pr-maker').value,
      price: rawNum(document.getElementById('pr-price').value),
      unit: document.getElementById('pr-unit').value,
      initStock: rawNum(document.getElementById('pr-initstock').value),
      safeStock: rawNum(document.getElementById('pr-safestock').value),
      memo: document.getElementById('pr-memo').value
    };
    if (editingId) {
      await updateDoc(path(), editingId, data);
    } else {
      await addDoc(path(), data);
      pendingNew = data;
    }
    return true;
  }

  /** 새 품목 저장 직후: "이 품목으로 바로 전표를 작성하시겠습니까? [매입 등록] [매출 등록] [아니오]"
   * 매입/매출을 고르면 그 화면으로 가서 새 전표 창을 열고 첫 줄에 품목·규격·단가를 채운다. */
  function offerQuickTx(product) {
    let bg = document.getElementById('pr-quick-modal');
    if (!bg) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="te-modal-bg" id="pr-quick-modal" style="display:none">
          <div class="te-modal" role="dialog" aria-modal="true" aria-labelledby="pr-quick-title">
            <div class="te-modal-title" id="pr-quick-title">새 품목 등록 완료</div>
            <div id="pr-quick-msg" style="margin:6px 0 16px;line-height:1.6"></div>
            <div class="btn-row" style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="ls-btn-primary" id="pr-quick-purchase" style="width:auto">매입 등록</button>
              <button class="ls-btn-primary" id="pr-quick-sale" style="width:auto">매출 등록</button>
              <button id="pr-quick-no" style="width:auto">아니오</button>
            </div>
          </div>
        </div>`);
      bg = document.getElementById('pr-quick-modal');
    }
    const label = product.name + (product.spec ? ` (${product.spec})` : '');
    document.getElementById('pr-quick-msg').innerHTML =
      `새 품목 「${escapeHtml(label)}」을 등록했습니다.<br>이 품목으로 바로 전표를 작성하시겠습니까?`;
    const close = () => { bg.style.display = 'none'; };
    document.getElementById('pr-quick-no').onclick = close;
    bg.onclick = (e) => { if (e.target === bg) close(); };
    document.getElementById('pr-quick-sale').onclick = () => {
      close();
      LayoutShell.navigate('sales');
      SalesModule.startNewWithItem(product);
    };
    document.getElementById('pr-quick-purchase').onclick = () => {
      if (rawNum(product.initStock) > 0 &&
          !confirm(`초기재고 ${rawNum(product.initStock).toLocaleString()}개가 이미 들어가 있습니다.\n매입으로 등록하면 재고가 그만큼 더 늘어납니다. 계속할까요?`)) return;
      close();
      LayoutShell.navigate('purchase');
      PurchaseModule.startNewWithItem(product);
    };
    bg.style.display = 'flex';
  }

  async function remove(id) {
    if (!confirm('이 품목을 삭제하시겠습니까?')) return;
    await deleteDoc(path(), id);
    showToast('품목을 삭제했습니다');
  }

  /** 다른 화면(매출/매입/재고)에서 품목 목록을 참조할 때 사용합니다. */
  function getCache() { return cache; }

  // ── 엑셀 업로드/다운로드 (대량 등록) ──────────────────────────
  // 업로드 양식의 칼럼명. 다운로드/템플릿/업로드 셋이 항상 이 순서·이름을
  // 그대로 써야 서로 어긋나지 않는다 (아래 EXCEL_HEADERS 하나로 통일).
  const EXCEL_HEADERS = ['코드', '품목명', '규격', '제조사', '기준단가', '단위', '초기재고', '안전재고', '메모'];

  function downloadTemplate() {
    ExcelIO.downloadTemplate('품목_업로드양식.xlsx', EXCEL_HEADERS);
  }

  function exportExcel() {
    const rows = cache.map((p) => ({
      코드: p.code || '', 품목명: p.name || '', 규격: p.spec || '', 제조사: p.maker || '',
      기준단가: p.price || 0, 단위: p.unit || '', 초기재고: p.initStock || 0,
      안전재고: p.safeStock || 0, 메모: p.memo || ''
    }));
    ExcelIO.download('품목_목록.xlsx', rows, EXCEL_HEADERS);
  }

  async function handleUpload(e) {
    const file = e.target.files[0];
    e.target.value = ''; // 같은 파일을 다시 선택해도 change 이벤트가 또 뜨도록 초기화
    if (!file) return;

    let rows;
    try {
      rows = await ExcelIO.readFile(file);
    } catch (err) {
      alert('엑셀 파일을 읽는 중 오류가 발생했습니다: ' + err.message);
      return;
    }
    if (!rows.length) { alert('업로드할 데이터가 없습니다'); return; }

    // 중복 판정: 코드+품목명+규격을 다 합친 값이 완전히 같을 때만
    // "이미 등록된 품목"으로 보고 건너뛴다 (정책 확정: 덮어쓰지 않고
    // 새 품목만 추가). 코드만 보고 판정하면, 여러 품목이 같은 코드를
    // 공유하는 파일(예: 브랜드 코드를 공통으로 쓰는 경우)에서 첫 줄
    // 빼고 전부 중복으로 잘못 걸러지는 사고가 나서 복합키로 바꿨다.
    const existingKeys = new Set(cache.map((p) => `${p.code || ''}|${p.name || ''}|${p.spec || ''}`));

    const ops = [];
    let skipped = 0, invalid = 0;
    rows.forEach((r) => {
      const name = String(r['품목명'] || '').trim();
      if (!name) { invalid++; return; }
      const code = String(r['코드'] || '').trim();
      const spec = String(r['규격'] || '').trim();
      const key = `${code}|${name}|${spec}`;
      if (existingKeys.has(key)) { skipped++; return; }

      ops.push({
        type: 'set', path: path(), id: genId(),
        data: {
          code, name, spec,
          maker: String(r['제조사'] || '').trim(),
          price: rawNum(r['기준단가']),
          unit: String(r['단위'] || '').trim(),
          initStock: rawNum(r['초기재고']),
          safeStock: rawNum(r['안전재고']),
          memo: String(r['메모'] || '').trim(),
          // 목록 조회가 createdAt 기준으로 정렬하는데, Firestore는
          // 정렬 기준 필드가 아예 없는 문서는 조회 결과에서 통째로
          // 빼버린다 (에러 없이 조용히 제외). 일반 등록(addDoc)은
          // 자동으로 채워주지만 대량 업로드는 이 필드를 직접 안
          // 넣고 있어서, 업로드는 성공해도 목록엔 하나도 안 보이던
          // 사고가 있었다.
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }
      });
      // 같은 업로드 파일 안에서도 복합키가 겹치면 그 다음 줄부턴 또
      // 건너뛰도록 방금 추가한 것도 바로 반영해둔다.
      existingKeys.add(key);
    });

    if (ops.length) {
      try {
        await batchWrite(ops);
      } catch (err) {
        alert('엑셀 업로드 중 오류가 발생했습니다: ' + err.message);
        return;
      }
    }
    alert(`엑셀 업로드 완료\n\n새로 등록: ${ops.length}건\n중복으로 건너뜀: ${skipped}건${invalid ? `\n품목명 없어서 제외: ${invalid}건` : ''}`);
  }

  /**
   * 예전 엑셀 업로드 버그로 createdAt이 빠진 채 저장된 품목을 찾아 복구합니다.
   * 목록 조회는 createdAt 기준 정렬이라 이 필드가 없는 문서는 화면에서
   * 통째로 빠지는데(Firestore의 orderBy 특성), 정렬 조건 없이 전체를
   * 다시 조회해서 그 문서들만 골라 createdAt을 채워 넣는다. 한 번만
   * 실행하면 되는 일회성 복구 기능이다.
   */
  async function fixMissingCreatedAt() {
    if (!confirm('예전 엑셀 업로드로 화면에 안 보이던 품목이 있는지 확인하고 복구합니다. 계속할까요?')) return;
    let snap;
    try {
      snap = await db.collection(path()).get();
    } catch (err) {
      alert('조회 중 오류가 발생했습니다: ' + err.message);
      return;
    }
    const missing = snap.docs.filter((d) => !d.data().createdAt);
    if (!missing.length) { alert('숨은 품목이 없습니다 — 이미 전부 정상 표시되고 있습니다.'); return; }

    const ops = missing.map((d) => ({
      type: 'set', path: path(), id: d.id,
      data: { createdAt: firebase.firestore.FieldValue.serverTimestamp() }, merge: true
    }));
    try {
      await batchWrite(ops);
    } catch (err) {
      alert('복구 중 오류가 발생했습니다: ' + err.message);
      return;
    }
    alert(`복구 완료 — ${missing.length}개 품목이 목록에 다시 나타납니다.`);
  }

  /**
   * 이 회사의 품목을 전부 삭제하는 관리자용 정리 기능입니다. 잘못된
   * 엑셀 업로드로 빈 값짜리 품목이 대량으로 쌓였을 때, 지우고 처음부터
   * 다시 올리는 용도입니다. 되돌릴 수 없어서 회사명을 직접 입력해야만
   * 진행되도록 이중 확인을 둡니다. 매출/매입에 이미 연결된 품목이라도
   * (productId로) 과거 거래 기록 자체는 남아있으니 거래 내역이
   * 사라지지는 않지만, 품목 마스터가 없어지면 향후 그 품목 자동완성은
   * 안 됩니다.
   */
  async function deleteAllProducts() {
    const company = companies[activeCoIdx];
    const companyName = company ? company.company : '';
    const typed = prompt(
      `"${companyName}"의 품목을 전부 삭제합니다. 되돌릴 수 없습니다.\n\n` +
      `계속하려면 회사명을 정확히 입력하세요: ${companyName}`
    );
    if (typed !== companyName) {
      if (typed !== null) alert('입력한 회사명이 일치하지 않아 취소되었습니다.');
      return;
    }

    let snap;
    try {
      snap = await db.collection(path()).get();
    } catch (err) {
      alert('조회 중 오류가 발생했습니다: ' + err.message);
      return;
    }
    if (!snap.docs.length) { alert('삭제할 품목이 없습니다.'); return; }

    const ops = snap.docs.map((d) => ({ type: 'delete', path: path(), id: d.id }));
    try {
      await batchWrite(ops);
    } catch (err) {
      alert('삭제 중 오류가 발생했습니다: ' + err.message);
      return;
    }
    alert(`${ops.length}개 품목을 전부 삭제했습니다.`);
  }

  /** 품목 데이터가 바뀔 때마다 호출될 콜백을 등록합니다 (재고 화면이 사용). */
  function onUpdate(cb) { updateListeners.push(cb); }

  /** 이름+규격으로 등록된 품목을 정확히 찾습니다 (자동완성 매칭용). */
  function findByNameSpec(name, spec) {
    return cache.find((p) => p.name === name && (p.spec || '') === (spec || ''));
  }

  /** 로그아웃 시 호출 — 이전 계정의 품목 목록이 남아 보이지 않도록 비운다. */
  function clearData() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    closePanel();
    cache = [];
    tableInstance.render(cache);
    updateListeners.forEach((cb) => cb(cache));
  }

  /** 매출·매입 품목 줄의 "품목명" 목록 — 같은 이름(PLC, SERVO…)은 한 번만,
   * 규격은 붙이지 않는다. 규격은 이름을 고른 뒤 규격 칸 목록에서 고른다. */
  function nameOptionsHtml() {
    const names = Array.from(new Set(cache.map((p) => p.name).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'ko'));
    return names.map((n) => `<option value="${escapeHtml(n)}">`).join('');
  }

  /** 그 품목명에 등록된 규격 목록 (규격 칸 자동완성용) */
  function specOptionsHtml(name) {
    const specs = Array.from(new Set(cache.filter((p) => p.name === name).map((p) => p.spec || '').filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
    return specs.map((s) => `<option value="${escapeHtml(s)}">`).join('');
  }

  function fillSpecList(rowEl, name) {
    const dl = rowEl.querySelector('datalist.ri-spec-list');
    if (dl) dl.innerHTML = specOptionsHtml(name);
  }

  /** 품목 줄(매출·매입 공통): 이름을 고르면 규격 목록을 그 이름 것만으로 채우고,
   * 규격이 하나뿐이면 규격·단가까지 바로 채운다. 예전처럼 "이름 (규격)"을
   * 직접 쳐도 그대로 알아듣는다. */
  function pickItemName(rowEl) {
    const itemEl = rowEl.querySelector('.ri-item');
    const specEl = rowEl.querySelector('.ri-spec');
    const priceEl = rowEl.querySelector('.ri-price');
    const { name, hint } = splitNameAndHint(itemEl.value);
    const matches = cache.filter((p) => p.name === name);
    let product = hint ? findByNameSpec(name, hint) : null;
    if (!product && matches.length === 1) product = matches[0];
    fillSpecList(rowEl, name);
    if (product) {
      itemEl.value = product.name;
      specEl.value = product.spec || '';
      priceEl.value = (product.price || 0).toLocaleString();
    } else if (matches.length > 1) {
      itemEl.value = name;
      const same = matches.find((p) => (p.spec || '') === specEl.value);
      if (same) priceEl.value = (same.price || 0).toLocaleString();
      else specEl.value = '';
      specEl.focus();
    }
  }

  /** 규격을 고르면 그 품목의 단가를 채운다. */
  function pickItemSpec(rowEl) {
    const name = rowEl.querySelector('.ri-item').value.trim();
    const product = findByNameSpec(name, rowEl.querySelector('.ri-spec').value.trim());
    if (product) rowEl.querySelector('.ri-price').value = (product.price || 0).toLocaleString();
  }

  /** 전표 입력 중 "＋ 새 품목 등록" — 품목명·규격·기준단가만으로 바로 만든다.
   * 초기재고는 0 (재고는 매입 전표로 들어오게 해서 두 번 잡히지 않게). */
  async function quickAdd({ name, spec, price }) {
    const data = { code: '', name, spec: spec || '', maker: '', price: rawNum(price), unit: '', initStock: 0, safeStock: 0, memo: '' };
    const ref = await addDoc(path(), data);
    let p = cache.find((x) => x.id === ref.id);
    if (!p) { p = { id: ref.id, ...data }; cache = [p, ...cache]; }
    return p;
  }

  return { init, startListening, getCache, onUpdate, findByNameSpec, clearData, quickAdd,
    nameOptionsHtml, specOptionsHtml, fillSpecList, pickItemName, pickItemSpec };
})();

window.ProductsModule = ProductsModule;
