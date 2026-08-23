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

    // activeCols 병합 시 "새 칼럼" 판단 기준으로 쓰기 위해, colOrder를
    // 덮어쓰기 전(병합 전) 상태를 미리 기억해둔다.
    const knownKeysBeforeMerge = colOrder[tableId] ? colOrder[tableId].slice() : null;

    if (!colOrder[tableId]) {
      colOrder[tableId] = allKeys.slice();
    } else {
      colOrder[tableId] = mergeOrder(colOrder[tableId], allKeys);
    }

    if (!activeCols[tableId]) {
      activeCols[tableId] = opts.defaultActiveCols || allKeys.slice();
    } else {
      // "새 칼럼"인지는 allKeys(전체 칼럼)가 아니라, 예전에 저장해둔
      // 칼럼 순서(colOrder)에 이미 있었는지로 판단해야 한다. allKeys
      // 기준으로 비교하면 사용자가 항목 설정에서 꺼둔 칼럼(존재는 하지만
      // 활성 목록엔 없는 칼럼)까지 "새로 생긴 칼럼"으로 오인해서, 로그인·
      // 새로고침할 때마다 꺼둔 칼럼이 다시 켜져버리는 버그가 있었다.
      const knownKeys = knownKeysBeforeMerge || allKeys;
      const newKeys = allKeys.filter((k) => !knownKeys.includes(k));
      activeCols[tableId] = activeCols[tableId].filter((k) => allKeys.includes(k)).concat(newKeys);
    }

    const state = {
      tableId, opts, rawData: [],
      searchText: '', dateFrom: '', dateTo: '',
      sortKey: null, sortDir: 'asc',
      selectedIds: new Set()
    };
    instances[tableId] = state;

    buildDom(state);
    applyFixedHeight(state);
    return {
      render: (data) => { state.rawData = data; renderRows(state); }
    };
  }

  /** opts.maxHeight가 지정된 표는 .te-scroll에 항상 그 높이만큼만 보이고
   * 나머지는 내부 스크롤로 처리한다 (토글 버튼 없이 항상 이 상태 유지 —
   * 품목 수가 많은 화면에서 페이지 전체를 매번 스크롤하지 않도록, 검색과
   * 내부 스크롤만으로 충분하다는 판단에 따른 고정 동작). */
  function applyFixedHeight(state) {
    if (!state.opts.maxHeight || !state.rootEl) return;
    const scrollEl = state.rootEl.querySelector('.te-scroll');
    if (!scrollEl) return;
    scrollEl.style.maxHeight = state.opts.maxHeight + 'px';
    scrollEl.style.overflowY = 'auto';
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
        <div class="te-date-range">
          <input type="date" class="te-date" data-role="date-from">
          <span class="te-date-sep">~</span>
          <input type="date" class="te-date" data-role="date-to">
        </div>`;
    }
    if (opts.selectable) {
      toolbarHtml += `<button class="te-bulk-del-btn" data-role="bulk-delete" style="display:none">선택 삭제 (<span data-role="bulk-count">0</span>)</button>`;
    }
    toolbarHtml += `<button class="te-settings-btn" data-role="settings">항목 설정</button>`;
    toolbarHtml += '</div>';

    wrap.innerHTML = `
      ${toolbarHtml}
      <div class="te-scroll">
        <table class="te-table" id="te-table-${state.tableId}">
          <thead><tr></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="te-card-list" id="te-cards-${state.tableId}"></div>
      <div class="te-summary" data-role="summary"></div>
    `;
    opts.container.appendChild(wrap);
    state.rootEl = wrap;

    // 행 클릭 지원 (opts.rowId로 각 행의 식별값을 얻고, opts.onRowClick으로
    // 알려준다). "관리" 열 버튼 클릭은 행 클릭으로 취급하지 않는다.
    const tbodyEl = wrap.querySelector('tbody');
    tbodyEl.addEventListener('click', (e) => {
      // 체크박스 클릭은 행 클릭(상세보기 등)으로 취급하지 않고 선택 토글만 한다.
      const check = e.target.closest('.te-row-check');
      if (check) {
        const id = check.getAttribute('data-id');
        if (check.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
        updateBulkDeleteUi(state);
        return;
      }
      if (!state.opts.onRowClick) return;
      if (e.target.closest('.te-actions-col')) return;
      const tr = e.target.closest('tr[data-row-id]');
      if (!tr) return;
      const id = tr.getAttribute('data-row-id');
      if (id) state.opts.onRowClick(id);
    });

    // 카드뷰(모바일)에도 표(tbody)와 동일한 체크박스/행 클릭 동작을 붙인다.
    const cardsEl = wrap.querySelector('.te-card-list');
    cardsEl.addEventListener('click', (e) => {
      const check = e.target.closest('.te-row-check');
      if (check) {
        const id = check.getAttribute('data-id');
        if (check.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
        updateBulkDeleteUi(state);
        return;
      }
      if (!state.opts.onRowClick) return;
      if (e.target.closest('.te-card-actions')) return;
      const card = e.target.closest('.te-card[data-row-id]');
      if (!card) return;
      const id = card.getAttribute('data-row-id');
      if (id) state.opts.onRowClick(id);
    });

    // 헤더 클릭 위임: "전체 선택" 체크박스(선택 가능한 표에서만)와
    // 칼럼 헤더 클릭(정렬)을 여기서 함께 처리한다. 렌더링마다 헤더가
    // 통째로 다시 그려지므로 위임 방식으로 한 번만 등록해둔다.
    const theadEl = wrap.querySelector('thead');
    theadEl.addEventListener('click', (e) => {
      const master = e.target.closest('.te-check-all');
      if (master) {
        const rows = state.opts.rowId ? filterData(state).map((r) => String(state.opts.rowId(r) || '')).filter(Boolean) : [];
        if (master.checked) rows.forEach((id) => state.selectedIds.add(id));
        else state.selectedIds.clear();
        renderRows(state); // 체크 상태를 각 행 체크박스에도 반영하기 위해 다시 그린다
        return;
      }
      // 리사이즈 손잡이를 드래그하다 놓인 클릭은 정렬로 취급하지 않는다.
      if (e.target.closest('.te-resizer')) return;
      const th = e.target.closest('th.te-sortable');
      if (!th) return;
      const key = th.getAttribute('data-key');
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'asc';
      }
      renderRows(state);
    });

    if (opts.selectable) {
      wrap.querySelector('[data-role="bulk-delete"]').addEventListener('click', () => {
        if (!state.selectedIds.size) return;
        if (state.opts.onBulkDelete) state.opts.onBulkDelete(Array.from(state.selectedIds));
        state.selectedIds.clear();
        updateBulkDeleteUi(state);
      });
    }

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

  /** 칼럼 헤더 클릭으로 지정된 정렬을 적용한다. 숫자 값은 숫자로,
   * 그 외(날짜 문자열 YYYY-MM-DD, 거래처명, 규격 등)는 한글 로케일
   * 기준 문자열 비교로 정렬한다. 빈 값은 항상 맨 뒤로 보낸다. */
  function sortRows(state, rows) {
    const { sortKey, sortDir } = state;
    if (!sortKey) return rows;
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      const aEmpty = va === undefined || va === null || va === '';
      const bEmpty = vb === undefined || vb === null || vb === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      const na = Number(va), nb = Number(vb);
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
      return String(va).localeCompare(String(vb), 'ko') * dir;
    });
  }

  function renderRows(state) {
    const table = document.getElementById(`te-table-${state.tableId}`);
    if (!table) return;
    const theadRow = table.querySelector('thead tr');
    const tbody = table.querySelector('tbody');
    const configs = getActiveConfigs(state);
    const rows = sortRows(state, filterData(state));
    // 검색어·기간 필터가 바뀔 때마다, 지금 화면에 실제로 보이는 행
    // 목록을 화면 모듈에도 알려준다 (일별현황의 "기간별 이익률" KPI처럼,
    // 필터링된 결과 기준으로 합계를 다시 계산해야 하는 화면에서 사용).
    if (state.opts.onFilterChange) state.opts.onFilterChange(rows);

    // 헤더
    let headHtml = '';
    if (state.opts.selectable) {
      const allSelected = rows.length > 0 && rows.every((r) => {
        const rid = state.opts.rowId ? state.opts.rowId(r) : null;
        return rid && state.selectedIds.has(String(rid));
      });
      headHtml += `<th class="te-check-col"><input type="checkbox" class="te-check-all" ${allSelected ? 'checked' : ''}></th>`;
    }
    configs.forEach((c) => {
      const savedWidth = colWidths[state.tableId + '-' + c.key];
      const widthStyle = savedWidth ? `width:${savedWidth}px;min-width:${savedWidth}px;` : '';
      const alignStyle = c.align === 'right' ? 'text-align:right;' : '';
      const sortable = c.key !== '__no';
      let sortArrow = '';
      if (sortable && state.sortKey === c.key) {
        sortArrow = ` <span class="te-sort-arrow">${state.sortDir === 'desc' ? '▼' : '▲'}</span>`;
      }
      headHtml += `<th style="${widthStyle}${alignStyle}" data-key="${c.key}" class="${sortable ? 'te-sortable' : ''}">${escapeHtml(c.label)}${sortArrow}<div class="te-resizer"></div></th>`;
    });
    if (state.opts.rowActions) {
      const savedActWidth = colWidths[state.tableId + '-__actions'];
      const actWidthStyle = savedActWidth ? `width:${savedActWidth}px;min-width:${savedActWidth}px;` : '';
      headHtml += `<th class="te-actions-col" style="${actWidthStyle}" data-key="__actions">관리<div class="te-resizer"></div></th>`;
    }
    theadRow.innerHTML = headHtml;

    // 본문
    const colCount = configs.length + 1 + (state.opts.selectable ? 1 : 0);
    if (!rows.length) {
      tbody.innerHTML = `<tr class="te-empty"><td colspan="${colCount}">데이터가 없습니다</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row, idx) => {
        const rid = state.opts.rowId ? state.opts.rowId(row) : null;
        let rowHtml = `<tr${rid ? ` data-row-id="${escapeHtml(String(rid))}"` : ''}>`;
        if (state.opts.selectable) {
          const idStr = rid ? String(rid) : '';
          const checked = idStr && state.selectedIds.has(idStr);
          rowHtml += `<td class="te-check-col"><input type="checkbox" class="te-row-check" data-id="${escapeHtml(idStr)}" ${checked ? 'checked' : ''} ${idStr ? '' : 'disabled'}></td>`;
        }
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
    renderCardList(state, configs, rows);
    if (state.opts.selectable) updateBulkDeleteUi(state);
  }

  /** 모바일 폭에서는 CSS가 .te-scroll(표)을 숨기고 이 카드 목록을 대신
   * 보여준다. 표와 항상 동시에(같은 데이터로) 그려두고 CSS 미디어쿼리로
   * 어느 쪽을 보일지만 전환하므로, 창 크기를 바꿔도 별도 JS 없이 바로
   * 전환된다. 칼럼 순서 중 __no를 뺀 첫 번째 활성 칼럼을 카드 제목으로,
   * 나머지를 "라벨: 값" 줄로 보여준다 (항목 설정에서 순서를 바꾸면
   * 카드 제목도 그에 따라 바뀐다). */
  function renderCardList(state, configs, rows) {
    const cardsEl = state.rootEl.querySelector('.te-card-list');
    if (!cardsEl) return;
    if (!rows.length) {
      cardsEl.innerHTML = `<div class="te-card-empty">데이터가 없습니다</div>`;
      return;
    }
    const hasNo = configs.some((c) => c.key === '__no');
    const titleConfig = configs.find((c) => c.key !== '__no') || null;
    const bodyConfigs = configs.filter((c) => c !== titleConfig && c.key !== '__no');

    cardsEl.innerHTML = rows.map((row, idx) => {
      const rid = state.opts.rowId ? state.opts.rowId(row) : null;
      const titleValue = titleConfig
        ? (titleConfig.render ? titleConfig.render(row[titleConfig.key], row) : escapeHtml(row[titleConfig.key] ?? ''))
        : '';
      const bodyHtml = bodyConfigs.map((c) => {
        const raw = row[c.key];
        if (raw === undefined || raw === null || raw === '') return '';
        const value = c.render ? c.render(raw, row) : escapeHtml(raw);
        return `<div class="te-card-row"><span class="te-card-label">${escapeHtml(c.label)}</span><span class="te-card-value">${value}</span></div>`;
      }).join('');
      let checkboxHtml = '';
      if (state.opts.selectable) {
        const idStr = rid ? String(rid) : '';
        const checked = idStr && state.selectedIds.has(idStr);
        checkboxHtml = `<input type="checkbox" class="te-row-check" data-id="${escapeHtml(idStr)}" ${checked ? 'checked' : ''} ${idStr ? '' : 'disabled'}>`;
      }
      const noHtml = hasNo ? `<span class="te-card-no">${idx + 1}</span>` : '';
      const actionsHtml = state.opts.rowActions ? `<div class="te-card-actions">${state.opts.rowActions(row)}</div>` : '';
      return `
        <div class="te-card${state.opts.onRowClick ? ' te-card-clickable' : ''}"${rid ? ` data-row-id="${escapeHtml(String(rid))}"` : ''}>
          <div class="te-card-head">
            ${checkboxHtml}${noHtml}
            <span class="te-card-title">${titleValue}</span>
          </div>
          ${bodyHtml}
          ${actionsHtml}
        </div>
      `;
    }).join('');
  }

  /** "선택 삭제" 버튼의 표시 여부와 선택 개수를 갱신한다. */
  function updateBulkDeleteUi(state) {
    const btn = state.rootEl.querySelector('[data-role="bulk-delete"]');
    if (!btn) return;
    const n = state.selectedIds.size;
    btn.style.display = n > 0 ? '' : 'none';
    const countEl = btn.querySelector('[data-role="bulk-count"]');
    if (countEl) countEl.textContent = n;
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

  /**
   * TableEngine.create()로 만든 목록표가 아니라, sales.js/purchase.js/
   * daily.js의 "전표 상세" 같은 작은 고정 표를 그릴 때 쓰는 함수. 표
   * (.te-scroll)와 그 모바일용 카드뷰(.te-card-list)를 한 번에 만들어
   * 반환하므로, 이 함수로 만든 표는 목록표와 똑같이 모바일에서 자동으로
   * 카드형으로 바뀐다. columns/rows 형식은 create()의 opts.columns와 같다.
   * @param {{key:string, label:string, align?:'left'|'right', render?:(value:*, row:object)=>string}[]} columns
   * @param {object[]} rows
   * @returns {string} HTML
   */
  function renderStaticTable(columns, rows) {
    const theadHtml = columns.map((c) =>
      `<th${c.align === 'right' ? ' style="text-align:right"' : ''}>${escapeHtml(c.label)}</th>`
    ).join('');

    const cellHtml = (c, row, idx) => {
      if (c.key === '__no') return `<td style="text-align:center">${idx + 1}</td>`;
      const value = row[c.key];
      const cell = c.render ? c.render(value, row) : escapeHtml(value ?? '');
      return `<td${c.align === 'right' ? ' style="text-align:right"' : ''}>${cell}</td>`;
    };
    const tbodyHtml = rows.length
      ? rows.map((row, idx) => `<tr>${columns.map((c) => cellHtml(c, row, idx)).join('')}</tr>`).join('')
      : `<tr class="te-empty"><td colspan="${columns.length}">데이터가 없습니다</td></tr>`;

    const hasNo = columns.some((c) => c.key === '__no');
    const titleConfig = columns.find((c) => c.key !== '__no') || null;
    const bodyConfigs = columns.filter((c) => c !== titleConfig && c.key !== '__no');
    const cardsHtml = rows.length
      ? rows.map((row, idx) => {
          const titleValue = titleConfig
            ? (titleConfig.render ? titleConfig.render(row[titleConfig.key], row) : escapeHtml(row[titleConfig.key] ?? ''))
            : '';
          const bodyHtml = bodyConfigs.map((c) => {
            const raw = row[c.key];
            if (raw === undefined || raw === null || raw === '') return '';
            const value = c.render ? c.render(raw, row) : escapeHtml(raw);
            return `<div class="te-card-row"><span class="te-card-label">${escapeHtml(c.label)}</span><span class="te-card-value">${value}</span></div>`;
          }).join('');
          const noHtml = hasNo ? `<span class="te-card-no">${idx + 1}</span>` : '';
          return `<div class="te-card"><div class="te-card-head">${noHtml}<span class="te-card-title">${titleValue}</span></div>${bodyHtml}</div>`;
        }).join('')
      : `<div class="te-card-empty">데이터가 없습니다</div>`;

    return `
      <div class="te-scroll">
        <table class="te-table"><thead><tr>${theadHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table>
      </div>
      <div class="te-card-list">${cardsHtml}</div>
    `;
  }

  return { create, renderStaticTable };
})();

window.TableEngine = TableEngine;
