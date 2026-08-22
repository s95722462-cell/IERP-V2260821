// ══════════════════════════════════════════════════════════════
// table-engine.js — 표 렌더링 · 칼럼 리사이즈 · 항목 설정 · 검색(텍스트+기간)
// iERP 2.0 / 5단계 모듈
//
// 의존성: security.js, table-engine.css(동봉)
//
// 설계 원칙 (1.0에서 배운 것):
//   1. 칼럼 하나를 드래그로 늘리면, 다른 칼럼은 절대 같이 줄어들면
//      안 된다. 드래그 시작 순간 모든 칼럼 너비를 지금 값으로
//      고정(table-layout:fixed)하고, 표 전체 너비만 늘려서 감싸는
//      영역이 가로 스크롤을 담당하게 한다.
//      (1.0에서 표 너비가 100%로 고정되어 있어서, 하나를 늘리면
//      나머지가 비율대로 눌리는 버그가 있었다 — 이 파일은 그 버그가
//      구조적으로 재발할 수 없게 만들어졌다.)
//   2. 화면에 보이는 모든 값은 escapeHtml을 거친다 (커스텀 렌더러를
//      쓰지 않는 한 기본 렌더러가 자동으로 처리한다).
//   3. 기간 검색은 모든 표(일별현황/매출장부/매입장부 등)가 이 모듈
//      하나를 공유해서 쓴다 — 표마다 따로 만들지 않는다.
// ══════════════════════════════════════════════════════════════

const TableEngine = (() => {
  let colWidths = {};
  let colOrder = {};
  let activeCols = {};
  const instances = {}; // tableId -> instance

  function loadPrefs() {
    try { colWidths = JSON.parse(localStorage.getItem('te_col_widths') || '{}'); } catch (e) { colWidths = {}; }
    try { colOrder = JSON.parse(localStorage.getItem('te_col_order') || '{}'); } catch (e) { colOrder = {}; }
    try { activeCols = JSON.parse(localStorage.getItem('te_active_cols') || '{}'); } catch (e) { activeCols = {}; }
  }
  function savePrefs() {
    localStorage.setItem('te_col_widths', JSON.stringify(colWidths));
    localStorage.setItem('te_col_order', JSON.stringify(colOrder));
    localStorage.setItem('te_active_cols', JSON.stringify(activeCols));
  }
  loadPrefs();

  /**
   * 표 인스턴스를 만듭니다. 검색창(옵션)+표+항목설정 모달까지 컨테이너
   * 안에 전부 그려 넣습니다.
   *
   * @param {string} tableId - 고유 식별자 (칼럼 너비/순서/표시여부 저장 키)
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {{key:string, label:string, align?:'left'|'right', render?:(value:*, row:object)=>string}[]} opts.columns
   * @param {boolean} [opts.dateFilter=false] - 기간(시작일~종료일) 검색 UI 표시 여부
   * @param {string} [opts.dateField='date'] - 기간 필터에 사용할 데이터 필드
   * @param {string[]} [opts.searchFields=[]] - 텍스트 검색 대상 필드 목록
   * @param {(row:object)=>string} [opts.rowActions] - 각 행 끝에 붙일 버튼 HTML (직접 escapeHtml 처리 책임은 호출자에게 있음)
   * @param {string[]} [opts.defaultActiveCols] - 처음 상태에서 보여줄 칼럼 key 목록 (생략 시 전체)
   */
  function create(tableId, opts) {
    // 화면(테이블)에 새 칼럼이 추가되거나 빠지면, 예전에 저장해둔
    // "항목 설정"(순서·표시여부)이 낡아서 새 칼럼이 설정 목록에 아예
    // 안 뜨는 문제가 있었다. 매번 create() 호출 시 현재 opts.columns
    // 기준으로 다시 맞춰준다: 없어진 칼럼은 빼고, 새로 생긴 칼럼은
    // (그냥 맨 뒤가 아니라) opts.columns에 정의된 위치에 맞게 끼워
    // 넣으면서 기본적으로 표시 상태로 켠다.
    const allKeys = opts.columns.map((c) => c.key);

    /** savedOrder에 없는 authoritativeKeys의 새 항목을, 그 항목 바로
     * 앞(정의 순서상)에 있으면서 이미 savedOrder에 있는 항목 뒤에 끼워
     * 넣는다. 그런 항목이 없으면(맨 앞 정의) savedOrder 맨 앞에 넣는다. */
    function mergeOrder(savedOrder, authoritativeKeys) {
      const result = savedOrder.filter((k) => authoritativeKeys.includes(k));
      authoritativeKeys.forEach((key, i) => {
        if (result.includes(key)) return;
        let insertAfterIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
          const idxInResult = result.indexOf(authoritativeKeys[j]);
          if (idxInResult !== -1) { insertAfterIdx = idxInResult; break; }
        }
        result.splice(insertAfterIdx + 1, 0, key);
      });
      return result;
    }

    if (!colOrder[tableId]) {
      colOrder[tableId] = allKeys.slice();
    } else {
      colOrder[tableId] = mergeOrder(colOrder[tableId], allKeys);
    }

    if (!activeCols[tableId]) {
      activeCols[tableId] = opts.defaultActiveCols || allKeys.slice();
    } else {
      const newKeys = allKeys.filter((k) => !activeCols[tableId].includes(k));
      activeCols[tableId] = activeCols[tableId].filter((k) => allKeys.includes(k)).concat(newKeys);
    }

    const state = {
      tableId, opts, rawData: [],
      searchText: '', dateFrom: '', dateTo: ''
    };
    instances[tableId] = state;

    buildDom(state);
    return {
      render: (data) => { state.rawData = data; renderRows(state); }
    };
  }

  function buildDom(state) {
    const opts = state.opts;
    const container = opts.container;
    const wrap = document.createElement('div');
    wrap.className = 'te-wrap';

    let toolbarHtml = '<div class="te-toolbar">';
    if (opts.searchFields && opts.searchFields.length) {
      toolbarHtml += `<input class="te-search" placeholder="검색..." data-role="search">`;
    }
    if (opts.dateFilter) {
      toolbarHtml += `
        <input type="date" class="te-date" data-role="date-from">
        <span class="te-date-sep">~</span>
        <input type="date" class="te-date" data-role="date-to">`;
    }
    toolbarHtml += `<button class="te-settings-btn" data-role="settings">⚙️ 항목 설정</button>`;
    toolbarHtml += '</div>';

    wrap.innerHTML = `
      ${toolbarHtml}
      <div class="te-scroll">
        <table class="te-table" id="te-table-${state.tableId}">
          <thead><tr></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="te-summary" data-role="summary"></div>
    `;
    opts.container.appendChild(wrap);
    state.rootEl = wrap;

    const searchInput = wrap.querySelector('[data-role="search"]');
    if (searchInput) searchInput.addEventListener('input', () => { state.searchText = searchInput.value.toLowerCase(); renderRows(state); });

    const dateFrom = wrap.querySelector('[data-role="date-from"]');
    const dateTo = wrap.querySelector('[data-role="date-to"]');
    if (dateFrom) dateFrom.addEventListener('change', () => { state.dateFrom = dateFrom.value; renderRows(state); });
    if (dateTo) dateTo.addEventListener('change', () => { state.dateTo = dateTo.value; renderRows(state); });

    wrap.querySelector('[data-role="settings"]').addEventListener('click', () => openColSettings(state));
  }

  function getActiveConfigs(state) {
    const { opts, tableId } = state;
    const order = colOrder[tableId];
    const active = activeCols[tableId];
    return order.filter((k) => active.includes(k)).map((k) => opts.columns.find((c) => c.key === k)).filter(Boolean);
  }

  function filterData(state) {
    let rows = state.rawData;
    const { opts } = state;

    if (state.searchText && opts.searchFields && opts.searchFields.length) {
      rows = rows.filter((r) =>
        opts.searchFields.some((f) => String(r[f] || '').toLowerCase().includes(state.searchText))
      );
    }
    if (opts.dateFilter) {
      const field = opts.dateField || 'date';
      if (state.dateFrom) rows = rows.filter((r) => (r[field] || '') >= state.dateFrom);
      if (state.dateTo) rows = rows.filter((r) => (r[field] || '') <= state.dateTo);
    }
    return rows;
  }

  function renderRows(state) {
    const table = document.getElementById(`te-table-${state.tableId}`);
    if (!table) return;
    const theadRow = table.querySelector('thead tr');
    const tbody = table.querySelector('tbody');
    const configs = getActiveConfigs(state);
    const rows = filterData(state);
    // 검색어·기간 필터가 바뀔 때마다, 지금 화면에 실제로 보이는 행
    // 목록을 화면 모듈에도 알려준다 (일별현황의 "기간별 이익률" KPI처럼,
    // 필터링된 결과 기준으로 합계를 다시 계산해야 하는 화면에서 사용).
    if (state.opts.onFilterChange) state.opts.onFilterChange(rows);

    // 헤더
    let headHtml = '';
    configs.forEach((c) => {
      const savedWidth = colWidths[state.tableId + '-' + c.key];
      const widthStyle = savedWidth ? `width:${savedWidth}px;min-width:${savedWidth}px;` : '';
      const alignStyle = c.align === 'right' ? 'text-align:right;' : '';
      headHtml += `<th style="${widthStyle}${alignStyle}" data-key="${c.key}">${escapeHtml(c.label)}<div class="te-resizer"></div></th>`;
    });
    if (state.opts.rowActions) {
      const savedActWidth = colWidths[state.tableId + '-__actions'];
      const actWidthStyle = savedActWidth ? `width:${savedActWidth}px;min-width:${savedActWidth}px;` : '';
      headHtml += `<th class="te-actions-col" style="${actWidthStyle}" data-key="__actions">관리<div class="te-resizer"></div></th>`;
    }
    theadRow.innerHTML = headHtml;

    // 본문
    if (!rows.length) {
      tbody.innerHTML = `<tr class="te-empty"><td colspan="${configs.length + 1}">데이터가 없습니다</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row, idx) => {
        let rowHtml = '<tr>';
        configs.forEach((c) => {
          // key가 '__no'인 칼럼은 저장된 데이터가 아니라, 지금 화면에 보이는
          // 순서 그대로 1,2,3...을 매기는 표시 전용 번호다 (검색·정렬 결과
          // 순서를 그대로 따라간다. 전표No.와는 별개).
          if (c.key === '__no') { rowHtml += `<td style="text-align:center">${idx + 1}</td>`; return; }
          const value = row[c.key];
          const cell = c.render ? c.render(value, row) : escapeHtml(value ?? '');
          const alignStyle = c.align === 'right' ? 'text-align:right;' : '';
          rowHtml += `<td style="${alignStyle}">${cell}</td>`;
        });
        if (state.opts.rowActions) rowHtml += `<td class="te-actions-col">${state.opts.rowActions(row)}</td>`;
        rowHtml += '</tr>';
        return rowHtml;
      }).join('');
    }

    bindResizers(table, state.tableId);
  }

  // ── 칼럼 리사이즈 (드래그 시작 시 모든 칼럼을 고정하는 방식) ──
  function bindResizers(table, tableId) {
    const ths = table.querySelectorAll('th');
    ths.forEach((col) => {
      const resizer = col.querySelector('.te-resizer');
      if (!resizer) return;
      let startX = 0;
      let startWidth = 0;

      const onMouseDown = (e) => {
        startX = e.clientX;
        startWidth = parseInt(window.getComputedStyle(col).width, 10);

        table.style.tableLayout = 'fixed';
        let sum = 0;
        ths.forEach((c) => {
          const w = parseInt(window.getComputedStyle(c).width, 10);
          c.style.width = w + 'px';
          c.style.minWidth = w + 'px';
          sum += w;
        });
        table.style.width = sum + 'px';

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        resizer.classList.add('resizing');
      };

      const onMouseMove = (e) => {
        const newWidth = startWidth + (e.clientX - startX);
        if (newWidth <= 30) return;
        const prevWidth = parseInt(col.style.width, 10) || startWidth;
        col.style.width = newWidth + 'px';
        col.style.minWidth = newWidth + 'px';
        const curTableWidth = parseInt(table.style.width, 10) || 0;
        table.style.width = (curTableWidth + (newWidth - prevWidth)) + 'px';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        resizer.classList.remove('resizing');
        const key = col.getAttribute('data-key');
        if (key) {
          colWidths[tableId + '-' + key] = parseInt(col.style.width, 10);
          savePrefs();
        }
      };

      resizer.addEventListener('mousedown', onMouseDown);
    });
  }

  // ── 항목 설정 모달 (표시/숨김 + 순서, 표별로 공유되는 단일 모달) ──
  function ensureSettingsModal() {
    if (document.getElementById('te-settings-modal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="te-modal-bg" id="te-settings-modal" style="display:none">
        <div class="te-modal">
          <div class="te-modal-title">항목 설정 <button class="te-modal-close" data-role="close">✕</button></div>
          <div id="te-settings-list"></div>
          <button class="te-btn-primary" data-role="apply">적용하기</button>
        </div>
      </div>
    `);
    document.getElementById('te-settings-modal').querySelector('[data-role="close"]').addEventListener('click', closeColSettings);
  }

  let settingsTableId = null;

  function openColSettings(state) {
    ensureSettingsModal();
    settingsTableId = state.tableId;
    const listEl = document.getElementById('te-settings-list');
    const order = colOrder[state.tableId];
    const active = activeCols[state.tableId];

    listEl.innerHTML = order.map((key) => {
      const col = state.opts.columns.find((c) => c.key === key);
      if (!col) return '';
      const checked = active.includes(key) ? 'checked' : '';
      return `
        <div class="te-settings-item" draggable="true" data-key="${key}">
          <span class="te-drag-handle">☰</span>
          <label><input type="checkbox" data-key="${key}" ${checked}> ${escapeHtml(col.label)}</label>
        </div>`;
    }).join('');

    bindDragReorder(listEl);

    document.getElementById('te-settings-modal').style.display = 'flex';
    document.getElementById('te-settings-modal').querySelector('[data-role="apply"]').onclick = () => applyColSettings(state);
  }

  function bindDragReorder(listEl) {
    let dragged = null;
    listEl.querySelectorAll('.te-settings-item').forEach((item) => {
      item.addEventListener('dragstart', () => { dragged = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragged || dragged === item) return;
        const rect = item.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        listEl.insertBefore(dragged, before ? item : item.nextSibling);
      });
    });
  }

  function closeColSettings() {
    const modal = document.getElementById('te-settings-modal');
    if (modal) modal.style.display = 'none';
  }

  function applyColSettings(state) {
    const listEl = document.getElementById('te-settings-list');
    const items = listEl.querySelectorAll('.te-settings-item');
    const newOrder = [];
    const newActive = [];
    items.forEach((item) => {
      const key = item.getAttribute('data-key');
      newOrder.push(key);
      if (item.querySelector('input[type="checkbox"]').checked) newActive.push(key);
    });
    colOrder[state.tableId] = newOrder;
    activeCols[state.tableId] = newActive;
    savePrefs();
    closeColSettings();
    renderRows(state);
  }

  return { create };
})();

window.TableEngine = TableEngine;
