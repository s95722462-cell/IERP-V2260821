// ══════════════════════════════════════════════════════════════
// invoice.js — 거래명세서 (브라우저 인쇄 다이얼로그 방식)
// iERP 2.0 / 화면 모듈
//
// 의존성: security.js, sales.js, customers.js, invoice.css(동봉)
//
// 설계 변경 이력:
//   처음엔 jsPDF로 직접 PDF를 그리는 방식으로 만들었으나, jsPDF에
//   한글 폰트가 내장되어 있지 않아 별도 폰트 파일(1~3MB)을 준비해야
//   하는 문제가 있었다. 대신 이 방식으로 전환:
//     - 인쇄용 HTML을 화면에 숨겨서 그려두고
//     - window.print()로 브라우저 자체 인쇄 다이얼로그를 띄운다
//     - 사용자가 그 안에서 "PDF로 저장"을 선택하면 끝
//   이러면 한글 폰트 문제가 아예 생기지 않고(시스템 폰트 그대로 사용),
//   페이지가 넘칠 때 자동 분할도 브라우저가 알아서 처리해서
//   1.0에서 계속 씨름했던 여백 문제도 구조적으로 사라진다.
// ══════════════════════════════════════════════════════════════

const InvoiceModule = (() => {
  /**
   * 지정한 거래처의, 지정한 기간 매출 내역을 모아 인쇄용 화면을 그리고
   * 브라우저 인쇄 다이얼로그를 띄웁니다. 사용자가 그 안에서 "PDF로 저장"을
   * 선택하면 실제 PDF 파일이 만들어집니다.
   * @param {{buyerId:string, dateFrom:string, dateTo:string}} params
   */
  function generate({ buyerId, dateFrom, dateTo, docNo }) {
    let items;
    if (docNo) {
      // 전표 단위 발행 — 매출 내역 표의 "명세서" 버튼, 전표 상세보기 모달에서 사용
      items = SalesModule.getCache().filter((r) => r.docNo === docNo);
      if (!items.length) { alert('해당 전표를 찾을 수 없습니다'); return; }
      buyerId = items[0].buyerId;
    } else {
      items = SalesModule.getCache().filter((r) =>
        r.buyerId === buyerId && (!dateFrom || r.date >= dateFrom) && (!dateTo || r.date <= dateTo)
      );
      if (!items.length) { alert('선택한 기간에 해당 거래처의 매출 내역이 없습니다'); return; }
    }

    const buyer = CustomersModule.getCache().find((c) => c.id === buyerId);
    if (!buyer) { alert('거래처를 선택하세요'); return; }

    const company = companies[activeCoIdx];
    const totals = items.reduce((acc, it) => ({
      subtotal: acc.subtotal + it.subtotal,
      vat: acc.vat + it.vat,
      total: acc.total + it.total
    }), { subtotal: 0, vat: 0, total: 0 });

    const bodyHtml = buildBodyHtml(company, buyer, items, totals, docNo);

    // 품목이 많으면(半 칸에 다 안 들어가 줄이 잘리는 걸 실측으로 확인한
    // 기준선) 절취선 2단 방식 대신, 절취선 없이 A4 전체를 쓰는 일반
    // 방식으로 자동 전환한다. 이 경우 내용이 넘치면 브라우저가 알아서
    // 다음 페이지로 넘긴다(.inv-table tr의 page-break-inside:avoid 덕분에
    // 행이 페이지 경계에서 잘리지 않음).
    const MAX_ITEMS_FOR_SPLIT_LAYOUT = 8;
    if (items.length > MAX_ITEMS_FOR_SPLIT_LAYOUT) {
      renderPrintArea(bodyHtml);
      window.print();
      return;
    }

    // A4 한 장에 공급자 보관용 / 공급받는자 보관용을 위아래로 나눠 찍고
    // 가운데 절취선을 넣는다 (품목이 적을 때만 — 위 기준 참고).
    renderPrintArea(`
      <div class="inv-page">
        <div class="inv-copy">
          <div class="inv-copy-label">공급자 보관용</div>
          ${bodyHtml}
        </div>
        <div class="inv-cutline"><span>✂ 절 취 선 ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑</span></div>
        <div class="inv-copy">
          <div class="inv-copy-label">공급받는자 보관용</div>
          ${bodyHtml}
        </div>
      </div>
    `);
    window.print();
  }

  function buildBodyHtml(company, buyer, items, totals, docNo) {
    return `
      <div class="inv-doc">
        <h1 class="inv-title">거 래 명 세 서</h1>

        <div class="inv-meta-row">
          <div>${docNo ? '전표No: ' + escapeHtml(docNo) : ''}</div>
          <div>발행일: ${escapeHtml(todayStr())}</div>
        </div>

        <div class="inv-info-row">
          <div class="inv-info-box">
            <div class="inv-info-title">공급받는자</div>
            <div>${escapeHtml(buyer.name)}</div>
            <div>사업자번호: ${escapeHtml(buyer.bizno || '-')}</div>
            <div>대표자: ${escapeHtml(buyer.ceo || '-')}</div>
            <div>주소: ${escapeHtml(buyer.addr || '-')}</div>
            <div>전화번호: ${escapeHtml(buyer.tel || '-')}</div>
            <div>팩스번호: ${escapeHtml(buyer.fax || '-')}</div>
          </div>
          <div class="inv-info-box">
            <div class="inv-info-title">공급자</div>
            <div>${escapeHtml(company.company || '-')}</div>
            <div>사업자번호: ${escapeHtml(company.bizno || '-')}</div>
            <div>대표자: ${escapeHtml(company.ceo || '-')}</div>
            <div>주소: ${escapeHtml(company.addr || '-')}</div>
            <div>연락처: ${escapeHtml(company.tel || '-')}</div>
          </div>
        </div>

        <table class="inv-table">
          <thead>
            <tr>
              <th>No.</th><th>품목명</th><th>규격</th><th>수량</th>
              <th>단가</th><th>공급가액</th><th>부가세</th><th>합계</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((it, idx) => `
              <tr>
                <td style="text-align:center">${idx + 1}</td>
                <td>${escapeHtml(it.item)}</td>
                <td>${escapeHtml(it.spec || '')}</td>
                <td style="text-align:right">${(it.qty || 0).toLocaleString()}</td>
                <td style="text-align:right">${(it.unitPrice || 0).toLocaleString()}</td>
                <td style="text-align:right">${(it.subtotal || 0).toLocaleString()}</td>
                <td style="text-align:right">${(it.vat || 0).toLocaleString()}</td>
                <td style="text-align:right">${(it.total || 0).toLocaleString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>

        <div class="inv-totals">
          <div>공급가액: ${totals.subtotal.toLocaleString()}</div>
          <div>부가세: ${totals.vat.toLocaleString()}</div>
          <div class="inv-total-final">합계: ${totals.total.toLocaleString()}</div>
        </div>

        <div class="inv-sign-row">
          <div>인수자: ______________________ (서명)</div>
        </div>

        <div class="inv-footer">${escapeHtml(company.footer || '')}</div>
      </div>
    `;
  }

  /** 인쇄 전용 영역에 내용을 채웁니다. 평소엔 화면에 안 보이다가,
   * invoice.css의 @media print 규칙에 의해 인쇄할 때만 나타납니다. */
  function renderPrintArea(html) {
    let area = document.getElementById('invoice-print-area');
    if (!area) {
      area = document.createElement('div');
      area.id = 'invoice-print-area';
      document.body.appendChild(area);
    }
    area.innerHTML = html;
  }

  return { generate };
})();

window.InvoiceModule = InvoiceModule;
