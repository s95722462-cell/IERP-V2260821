// ══════════════════════════════════════════════════════════════
// entry-ui.js — 매출·매입 전표 입력 도우미 (2026-11-05 사용자 견본 승인)
//
//  1. 품목명 창 / 규격 창 따로: 이름만(중복 없이) → 그 이름의 규격만, 단가·재고 표시
//  2. 없는 품목·규격·거래처는 그 자리에서 등록 (품목 목록·거래처 목록에 바로 저장)
//  3. 거래처(공급업체)별 최근 단가: 그 거래처와 마지막으로 거래한 단가를 채움
//  4. 키보드: ↑↓ Enter 선택, Enter 로 다음 칸, 단가에서 Enter → 다음 줄, Ctrl+S 저장
//  5. 사이드 메뉴 「＋ 새로 등록」(매출·매입·품목), Alt+1/2/3, 휴대폰 ＋ 버튼
//
// 의존성: security.js(escapeHtml, rawNum, fmtNum), customers.js, products.js,
//         sales.js, purchase.js, stock.js, layout-shell.js
// 목록 창은 body 에 붙는 떠 있는 상자 하나를 모든 칸이 같이 쓴다 (옆 창 스크롤에 잘리지 않게).
// ══════════════════════════════════════════════════════════════

const EntryUI = (() => {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s,\-_/()]/g, '');
  const won = (n) => (Math.round(rawNum(n)) || 0).toLocaleString();
  const pkey = (name, spec) => `${name}|${spec || ''}`;

  function hl(text, q) {
    const t = escapeHtml(String(text ?? ''));
    if (!q) return t;
    const words = q.split(/\s+/).filter(Boolean).map((w) => escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return t;
    return t.replace(new RegExp('(' + words.join('|') + ')', 'gi'), '<mark>$1</mark>');
  }

  // ── 떠 있는 목록 창 (공용) ─────────────────────────────────
  let dd = null;
  let cur = null;

  function ensureDd() {
    if (dd) return dd;
    dd = document.createElement('div');
    dd.className = 'eu-dd';
    dd.id = 'eu-dd';
    dd.setAttribute('role', 'listbox');
    dd.style.display = 'none';
    document.body.appendChild(dd);
    dd.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-i]');
      if (!el || !cur) return;
      e.preventDefault();
      const c = cur;
      const it = c.items[+el.dataset.i];
      close();
      c.onPick(it);
    });
    window.addEventListener('resize', close);
    document.addEventListener('scroll', (e) => { if (cur && !dd.contains(e.target)) position(); }, true);
    return dd;
  }

  function position() {
    if (!cur) return;
    const r = cur.inp.getBoundingClientRect();
    dd.style.minWidth = Math.max(r.width, 220) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 240 && r.top > below) { dd.style.top = ''; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = ''; dd.style.top = (r.bottom + 4) + 'px'; }
    const left = Math.min(r.left, window.innerWidth - dd.offsetWidth - 6);
    dd.style.left = Math.max(6, left) + 'px';
  }

  function render(c) {
    const { html, items } = c.build(c.inp.value.trim());
    c.items = items;
    if (!items.length) { if (cur === c) close(); return; }
    c.act = Math.max(0, Math.min(c.act, items.length - 1));
    ensureDd().innerHTML = html;
    const a = dd.querySelector(`[data-i="${c.act}"]`);
    if (a) { a.classList.add('act'); a.scrollIntoView({ block: 'nearest' }); }
    cur = c;
    dd.style.display = 'block';
    position();
  }

  function close() { if (dd) dd.style.display = 'none'; cur = null; }
  function isOpenFor(c) { return cur === c && dd && dd.style.display === 'block'; }

  /** 입력칸에 목록 창을 붙인다. build(q) → {html, items}, onPick(item|null) */
  function attach(inp, build, onPick) {
    const c = { inp, build, onPick, act: 0, items: [] };
    inp.setAttribute('autocomplete', 'off');
    inp.removeAttribute('list');
    inp.addEventListener('focus', () => { c.act = 0; render(c); });
    inp.addEventListener('input', () => { c.act = 0; render(c); });
    inp.addEventListener('blur', () => setTimeout(() => { if (cur === c) close(); }, 150));
    inp.addEventListener('keydown', (e) => {
      const open = isOpenFor(c);
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { c.act = 0; render(c); } else { c.act = Math.min(c.act + 1, c.items.length - 1); render(c); } }
      else if (e.key === 'ArrowUp') { if (open) { e.preventDefault(); c.act = Math.max(c.act - 1, 0); render(c); } }
      else if (e.key === 'Enter') { e.preventDefault(); const it = open ? c.items[c.act] : null; close(); c.onPick(it); }
      else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); close(); } }
      else if (e.key === 'Tab') { close(); }
    });
    return c;
  }

  // ── 거래처 / 공급업체 ─────────────────────────────────────
  /** @param kind '거래처' | '공급업체'  @param onPicked 고른 뒤 (첫 품목 칸으로 이동 등) */
  function bindParty(nameId, hiddenId, kind, onPicked) {
    const inp = document.getElementById(nameId);
    const hid = document.getElementById(hiddenId);
    if (!inp || !hid) return;
    attach(inp, (q) => {
      const all = CustomersModule.getCache();
      const list = all.filter((c) => !q || norm(c.name).includes(norm(q))).slice(0, 60);
      const items = [];
      let html = '';
      list.forEach((c) => {
        items.push({ type: 'pick', c });
        html += `<div class="eu-opt eu-opt-party" data-i="${items.length - 1}"><span>${hl(c.name, q)}</span><span class="eu-dim">${escapeHtml(c.ceo || '')}</span></div>`;
      });
      if (q && !all.some((c) => c.name === q)) {
        items.push({ type: 'add', q });
        html += `<div class="eu-add" data-i="${items.length - 1}">＋ "${escapeHtml(q)}" 새 ${kind}로 등록</div>`;
      }
      return { html, items };
    }, async (it) => {
      if (!it) { if (onPicked) onPicked(); return; }
      if (it.type === 'add') {
        if (!confirm(`"${it.q}"을(를) 새 ${kind}로 등록할까요?\n(사업자번호·연락처는 나중에 거래처 화면에서 채우면 됩니다)`)) return;
        try {
          const id = await CustomersModule.quickAdd(it.q);
          inp.value = it.q; hid.value = id;
          if (window.showToast) showToast(`새 ${kind} "${it.q}"을(를) 등록했습니다`);
        } catch (err) { alert(`${kind} 등록 중 오류: ` + err.message); return; }
      } else {
        inp.value = it.c.name; hid.value = it.c.id;
      }
      if (onPicked) onPicked();
    });
  }

  // ── 품목 줄 ───────────────────────────────────────────────
  /** 거래처별 최근 단가: Map(이름|규격 → {price, date}) */
  function recentMap(kind, partyId) {
    const m = new Map();
    if (!partyId) return m;
    const rows = kind === 'sale'
      ? SalesModule.getCache().filter((r) => r.buyerId === partyId && rawNum(r.qty) > 0)
      : PurchaseModule.getCache().filter((r) => r.vendorId === partyId && rawNum(r.qty) > 0);
    rows.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .forEach((r) => { const k = pkey(r.item, r.spec); if (!m.has(k)) m.set(k, { price: rawNum(r.unitPrice), date: String(r.date || '').slice(5) }); });
    return m;
  }

  function stockMap() {
    try { return new Map(StockModule.computeStock().map((s) => [s.id, s.current])); } catch (e) { return new Map(); }
  }

  /**
   * @param tr 품목 줄 (.sl-item-row, 안에 .ri-item .ri-spec .ri-qty .ri-price)
   * @param ctx { kind:'sale'|'purchase', partyHiddenId, partyName(), recalcRow(tr), nextRow(tr) }
   */
  function bindItemRow(tr, ctx) {
    const nameIn = tr.querySelector('.ri-item');
    const specIn = tr.querySelector('.ri-spec');
    const qtyIn = tr.querySelector('.ri-qty');
    const priceIn = tr.querySelector('.ri-price');
    let hint = tr.querySelector('.ri-hint');
    if (!hint) { hint = document.createElement('div'); hint.className = 'ri-hint'; specIn.parentElement.appendChild(hint); }
    const partyId = () => (document.getElementById(ctx.partyHiddenId) || {}).value || '';
    let recent = new Map();
    let stock = new Map();
    const refreshCtx = () => { recent = recentMap(ctx.kind, partyId()); stock = stockMap(); };

    // ① 품목명 창: 이름만, 중복 없이
    attach(nameIn, (q) => {
      if (!cur || cur.inp !== nameIn) refreshCtx();
      const products = ProductsModule.getCache();
      const recNames = new Set([...recent.keys()].map((k) => k.split('|')[0]));
      const names = Array.from(new Set(products.map((p) => p.name).filter(Boolean)))
        .filter((n) => !q || norm(n).includes(norm(q)))
        .sort((a, b) => a.localeCompare(b, 'ko'));
      const items = [];
      let html = '';
      const opt = (n) => {
        const cnt = products.filter((p) => p.name === n).length;
        items.push({ type: 'name', n });
        return `<div class="eu-opt eu-opt-name" data-i="${items.length - 1}"><span class="eu-strong">${hl(n, q)}</span><span class="eu-dim">규격 ${cnt}개</span></div>`;
      };
      const rec = names.filter((n) => recNames.has(n));
      const rest = names.filter((n) => !recNames.has(n));
      if (rec.length) {
        html += `<div class="eu-sec">${escapeHtml(ctx.partyName() || '')} 최근 거래</div>` + rec.map(opt).join('');
        if (rest.length) html += '<div class="eu-sec">전체 품목</div>';
      }
      html += rest.slice(0, 80).map(opt).join('');
      if (q && !products.some((p) => norm(p.name) === norm(q))) {
        items.push({ type: 'add', q });
        html += `<div class="eu-add" data-i="${items.length - 1}">＋ "${escapeHtml(q)}" 새 품목으로 등록</div>`;
      }
      return { html, items };
    }, (it) => {
      if (!it) { specIn.focus(); return; }
      if (it.type === 'add') { openNewForm(it.q, ''); return; }
      nameIn.value = it.n;
      const specs = ProductsModule.getCache().filter((p) => p.name === it.n);
      if (specs.length === 1) { fill(specs[0]); return; }
      if (!specs.some((p) => (p.spec || '') === specIn.value)) { specIn.value = ''; hint.textContent = ''; }
      delete tr.dataset.filled;
      specIn.focus();
    });

    // ② 규격 창: 고른 품목명의 규격만 (품목명이 비어 있으면 전체 규격에서 검색)
    attach(specIn, (q) => {
      if (!cur || cur.inp !== specIn) refreshCtx();
      const nm = nameIn.value.trim();
      const products = ProductsModule.getCache();
      const known = nm && products.some((p) => p.name === nm);
      let list = products.filter((p) => (!known || p.name === nm) && (!q || norm(p.spec).includes(norm(q)) || (!known && norm(p.name + p.spec).includes(norm(q)))));
      list = list.sort((a, b) => (recent.has(pkey(b.name, b.spec)) ? 1 : 0) - (recent.has(pkey(a.name, a.spec)) ? 1 : 0)
        || String(a.spec || '').localeCompare(String(b.spec || ''), 'ko', { numeric: true })).slice(0, 80);
      const items = [];
      let html = '';
      if (known || !nm) html += `<div class="eu-sec">${known ? escapeHtml(nm) + ' 규격' : '전체 규격 (품목명을 먼저 고르면 좁혀집니다)'}</div>`;
      if (known || !nm) list.forEach((p) => {
        const r = recent.get(pkey(p.name, p.spec));
        const st = stock.has(p.id) ? stock.get(p.id) : null;
        items.push({ type: 'spec', p });
        html += `<div class="eu-opt eu-opt-spec" data-i="${items.length - 1}">
          <span>${known ? '' : `<b>${escapeHtml(p.name)}</b> `}${hl(p.spec || '(규격 없음)', q)}</span>
          <span class="eu-num">₩${won(r ? r.price : p.price)}${r ? `<span class="eu-recent">최근 ${escapeHtml(r.date)}</span>` : ''}</span>
          <span class="eu-stock${st !== null && st <= 0 ? ' eu-zero' : ''}">${st === null ? '' : (st <= 0 ? '재고 0' : '재고 ' + fmtNum(st))}</span></div>`;
      });
      if (nm && q && !products.some((p) => p.name === nm && norm(p.spec) === norm(q))) {
        items.push({ type: 'add', q });
        html += `<div class="eu-add" data-i="${items.length - 1}">＋ "${escapeHtml(nm)}"에 새 규격 "${escapeHtml(q)}" 등록</div>`;
      } else if (nm && !known && !q) {
        items.push({ type: 'add', q: '' });
        html += `<div class="eu-add" data-i="${items.length - 1}">＋ "${escapeHtml(nm)}" 새 품목으로 등록</div>`;
      }
      return { html, items };
    }, (it) => {
      if (!it) { qtyIn.focus(); qtyIn.select(); return; }
      if (it.type === 'add') { openNewForm(nameIn.value.trim(), it.q); return; }
      fill(it.p);
    });

    function fill(p) {
      refreshCtx();
      const r = recent.get(pkey(p.name, p.spec));
      nameIn.value = p.name;
      specIn.value = p.spec || '';
      priceIn.value = won(r ? r.price : p.price);
      const st = stock.has(p.id) ? stock.get(p.id) : null;
      const stTxt = st === null ? '' : ` · 재고 ${fmtNum(st)}`;
      hint.innerHTML = r
        ? `<span class="eu-recent">● 최근 단가 (${escapeHtml(r.date)})</span> · 기준 ₩${won(p.price)}${stTxt}`
        : `기준단가 ₩${won(p.price)}${stTxt}${ctx.kind === 'sale' && st !== null && st <= 0 ? ' <b class="eu-warn">재고 없음</b>' : ''}`;
      tr.dataset.filled = pkey(p.name, p.spec);
      removeNewForm();
      ctx.recalcRow(tr);
      qtyIn.focus(); qtyIn.select();
    }

    function removeNewForm() {
      const nf = tr.nextElementSibling;
      if (nf && nf.classList.contains('ri-newform-row')) nf.remove();
    }

    function openNewForm(name, spec) {
      removeNewForm();
      const cols = tr.children.length;
      const nf = document.createElement('tr');
      nf.className = 'ri-newform-row';
      nf.innerHTML = `<td colspan="${cols}"><div class="eu-newform">
        <div class="eu-nf-title">새 품목 등록 — 품목 목록에 저장되고 이 줄에 바로 채워집니다 (초기재고 0)</div>
        <label>품목명<input class="nf-name" value="${escapeHtml(name)}"></label>
        <label>규격<input class="nf-spec" value="${escapeHtml(spec.toUpperCase())}"></label>
        <label>기준단가<input class="nf-price" inputmode="numeric" placeholder="0"></label>
        <button type="button" class="ls-btn-primary nf-save" style="width:auto">등록</button>
        <button type="button" class="nf-cancel" style="width:auto">취소</button></div></td>`;
      tr.after(nf);
      const n = nf.querySelector('.nf-name');
      const s = nf.querySelector('.nf-spec');
      const pr = nf.querySelector('.nf-price');
      bindCommaInput(pr);
      (!name ? n : (!spec ? s : pr)).focus();
      let busy = false;
      const save = async () => {
        if (busy) return;
        const data = { name: n.value.trim(), spec: s.value.trim(), price: rawNum(pr.value) };
        if (!data.name) { alert('품목명을 입력하세요'); n.focus(); return; }
        const dup = ProductsModule.findByNameSpec(data.name, data.spec);
        if (dup) { fill(dup); return; }
        busy = true;
        try {
          const p = await ProductsModule.quickAdd(data);
          if (window.showToast) showToast(`새 품목 "${data.name}${data.spec ? ' ' + data.spec : ''}"을(를) 등록했습니다`);
          fill(p);
        } catch (err) { alert('품목 등록 중 오류: ' + err.message); }
        finally { busy = false; }
      };
      nf.querySelector('.nf-save').addEventListener('click', save);
      nf.querySelector('.nf-cancel').addEventListener('click', () => { nf.remove(); nameIn.focus(); });
      nf.querySelectorAll('input').forEach((x) => x.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nf.remove(); nameIn.focus(); }
      }));
    }

    nameIn.addEventListener('input', () => { delete tr.dataset.filled; hint.textContent = ''; });
    specIn.addEventListener('input', () => { delete tr.dataset.filled; });
    qtyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); priceIn.focus(); priceIn.select(); } });
    priceIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ctx.nextRow(tr); } });
  }

  /** 예전 방식("이름 (규격)" 직접 입력 후 change)용 — 목록 창으로 이미 채운 줄은 건드리지 않는다. */
  function isFilled(tr) {
    const k = pkey(tr.querySelector('.ri-item').value.trim(), tr.querySelector('.ri-spec').value.trim());
    return tr.dataset.filled === k;
  }

  // ── 매출 저장 전 재고 확인 ─────────────────────────────────
  /** @param lines [{item, spec, qty}] @param editingRows 수정 중인 기존 줄(재고에서 이미 빠져 있음) */
  function confirmStock(lines, editingRows) {
    const sm = stockMap();
    const need = new Map();
    lines.forEach((l) => {
      if (rawNum(l.qty) <= 0) return;
      const p = ProductsModule.findByNameSpec(l.item, l.spec);
      if (!p) return;
      need.set(p.id, { p, qty: (need.get(p.id)?.qty || 0) + rawNum(l.qty) });
    });
    const back = new Map();
    (editingRows || []).forEach((r) => { if (r.productId) back.set(r.productId, (back.get(r.productId) || 0) + rawNum(r.qty)); });
    const short = [];
    need.forEach(({ p, qty }, id) => {
      if (!sm.has(id)) return;
      const have = sm.get(id) + (back.get(id) || 0);
      if (qty > have) short.push(`· ${p.name}${p.spec ? ' ' + p.spec : ''}: 재고 ${fmtNum(have)}개, 이번 출고 ${fmtNum(qty)}개`);
    });
    if (!short.length) return true;
    return confirm(`재고가 부족한 품목이 있습니다.\n${short.join('\n')}\n\n그래도 저장할까요?`);
  }

  // ── 사이드 메뉴 「＋ 새로 등록」, 단축키, Ctrl+S, 휴대폰 ＋ ────────
  function openNew(kind) {
    close();
    const map = { sale: ['sales', 'sl-add-btn'], purchase: ['purchase', 'pu-add-btn'], product: ['products', 'pr-add-btn'] };
    const [panel, btn] = map[kind];
    LayoutShell.navigate(panel);
    const b = document.getElementById(btn);
    if (b) b.click();
    const menu = document.getElementById('eu-new-menu');
    if (menu) menu.hidden = true;
    const sb = document.getElementById('ls-sidebar');
    if (sb && sb.classList.contains('mobile-open')) document.getElementById('ls-mobile-backdrop')?.click();
  }

  function menuHtml(id) {
    return `<div class="eu-new-menu" id="${id}" hidden>
      <button type="button" data-new="sale">매출 등록 <kbd>Alt+1</kbd></button>
      <button type="button" data-new="purchase">매입 등록 <kbd>Alt+2</kbd></button>
      <button type="button" data-new="product">품목 등록 <kbd>Alt+3</kbd></button></div>`;
  }

  function initGlobal() {
    const top = document.querySelector('#ls-sidebar .ls-sidebar-top');
    if (top && !document.getElementById('eu-new-btn')) {
      const wrap = document.createElement('div');
      wrap.className = 'eu-new-wrap';
      wrap.innerHTML = `<button type="button" class="eu-new-btn" id="eu-new-btn" title="새로 등록 (매출·매입·품목)" aria-haspopup="true">＋<span class="eu-new-label"> 새로 등록</span></button>${menuHtml('eu-new-menu')}`;
      top.after(wrap);
      const menu = wrap.querySelector('#eu-new-menu');
      wrap.querySelector('#eu-new-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
      menu.addEventListener('click', (e) => { const b = e.target.closest('[data-new]'); if (b) openNew(b.dataset.new); });
      document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) menu.hidden = true; });
    }
    if (!document.getElementById('eu-fab')) {
      const fab = document.createElement('div');
      fab.className = 'eu-fab-wrap';
      fab.innerHTML = `<button type="button" class="eu-fab" id="eu-fab" title="새로 등록" aria-label="새로 등록">＋</button>${menuHtml('eu-fab-menu')}`;
      document.body.appendChild(fab);
      const m = fab.querySelector('#eu-fab-menu');
      fab.querySelector('#eu-fab').addEventListener('click', (e) => { e.stopPropagation(); m.hidden = !m.hidden; });
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-new]'); if (b) { m.hidden = true; openNew(b.dataset.new); } });
      document.addEventListener('click', (e) => { if (!fab.contains(e.target)) m.hidden = true; });
    }
    document.addEventListener('keydown', (e) => {
      const app = document.getElementById('ls-app');
      if (!app || app.style.display === 'none' || getComputedStyle(app).display === 'none') return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        openNew({ 1: 'sale', 2: 'purchase', 3: 'product' }[e.key]);
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        const pairs = [['sl-panel-bg', 'sl-save-btn'], ['pu-panel-bg', 'pu-save-btn'], ['pr-panel-bg', 'pr-save-btn'], ['cu-panel-bg', 'cu-save-btn']];
        const open = pairs.find(([bg]) => { const el = document.getElementById(bg); return el && el.style.display !== 'none'; });
        if (open) { e.preventDefault(); close(); document.getElementById(open[1]).click(); }
      }
    });
  }

  return { attach, bindParty, bindItemRow, isFilled, confirmStock, initGlobal, openNew, closeDropdown: close };
})();

window.EntryUI = EntryUI;
