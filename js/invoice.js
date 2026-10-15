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
   * 지정한 거래처의, 지정한 기간 매출 내역(월 납품 내역 전체)을 모아
   * 엑셀 파일 한 장으로 내보냅니다. "매출 원장"용 원본 데이터이며,
   * 세부 서식(소계 줄 삽입, 강조 등)은 사용자가 엑셀에서 직접 정리하는
   * 것을 전제로, 여기서는 누락 없이 정확한 원본 데이터만 내보냅니다.
   * @param {{buyerId:string, dateFrom:string, dateTo:string}} params
   */
  function exportExcel({ buyerId, dateFrom, dateTo }) {
    const buyer = CustomersModule.getCache().find((c) => c.id === buyerId);
    if (!buyer) { alert('거래처를 선택하세요'); return; }

    const items = SalesModule.getCache()
      .filter((r) => r.buyerId === buyerId && (!dateFrom || r.date >= dateFrom) && (!dateTo || r.date <= dateTo))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!items.length) { alert('선택한 기간에 해당 거래처의 매출 내역이 없습니다'); return; }

    const totals = items.reduce((acc, it) => ({
      subtotal: acc.subtotal + rawNum(it.subtotal),
      vat: acc.vat + rawNum(it.vat),
      total: acc.total + rawNum(it.total)
    }), { subtotal: 0, vat: 0, total: 0 });

    const rows = items.map((it, idx) => ({
      'No.': idx + 1,
      '날짜': it.date,
      '품목명': it.item,
      '규격': it.spec || '',
      '수량': it.qty || 0,
      '단가': it.unitPrice || 0,
      '공급가액': it.subtotal || 0,
      '부가세': it.vat || 0,
      '합계': it.total || 0,
      '인보이스No.': it.invNo || '',
      '비고': it.memo || ''
    }));
    // 맨 아래 합계 줄 추가 — 원장에서 바로 확인할 수 있게
    rows.push({
      'No.': '', '날짜': '', '품목명': `합계 (${buyer.name}, ${dateFrom || '전체'} ~ ${dateTo || '전체'})`,
      '규격': '', '수량': '', '단가': '',
      '공급가액': totals.subtotal, '부가세': totals.vat, '합계': totals.total,
      '인보이스No.': '', '비고': ''
    });

    const filename = `매출원장_${buyer.name}_${dateFrom || ''}~${dateTo || ''}.xlsx`;
    const headerOrder = ['No.', '날짜', '품목명', '규격', '수량', '단가', '공급가액', '부가세', '합계', '인보이스No.', '비고'];
    ExcelIO.download(filename, rows, headerOrder, ['단가', '공급가액', '부가세', '합계']);
  }

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
      // 금액 필드가 빠진 옛 데이터가 섞여 있어도 합계가 NaN이 되지 않도록 0으로 본다
      subtotal: acc.subtotal + rawNum(it.subtotal),
      vat: acc.vat + rawNum(it.vat),
      total: acc.total + rawNum(it.total)
    }), { subtotal: 0, vat: 0, total: 0 });

    const bodyHtml = buildBodyHtml(company, buyer, items, totals, docNo);

    // 품목이 많으면(半 칸에 다 안 들어가 줄이 잘리는 걸 실측으로 확인한
    // 기준선) 절취선 2단 방식 대신, 절취선 없이 A4 전체를 쓰는 일반
    // 방식으로 자동 전환한다. 이 경우 내용이 넘치면 브라우저가 알아서
    // 다음 페이지로 넘긴다(.inv-table tr의 page-break-inside:avoid 덕분에
    // 행이 페이지 경계에서 잘리지 않음).
    const MAX_ITEMS_FOR_SPLIT_LAYOUT = 8;
    if (items.length > MAX_ITEMS_FOR_SPLIT_LAYOUT) {
      present(bodyHtml);
      return;
    }

    // A4 한 장에 공급자 보관용 / 공급받는자 보관용을 위아래로 나눠 찍고
    // 가운데 절취선을 넣는다 (품목이 적을 때만 — 위 기준 참고).
    present(`
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
  }

  /** 아이폰/아이패드 Safari는 목록 버튼에서 바로 부른 window.print()를 조용히
   * 무시하는 경우가 있어(아무 반응 없음), 모바일에서는 명세서를 화면에 미리보기로
   * 띄우고 사용자가 그 안의 "인쇄" 버튼을 직접 누르게 한다. 그래도 인쇄 창이
   * 안 뜨면 Safari 공유 → 프린트로 같은 결과(@media print)를 얻을 수 있다. */
  function isMobilePrint() {
    return window.matchMedia('(max-width: 768px)').matches
      || /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS(데스크톱 UA)
  }

  function present(html) {
    renderPrintArea(html);
    if (isMobilePrint()) openPreview();
    else window.print();
  }

  function openPreview() {
    const area = document.getElementById('invoice-print-area');
    area.classList.add('inv-preview-open');
    area.scrollTop = 0;
    fitPreview();
  }

  /** A4 폭(210mm) 그대로 그린 명세서를 화면 폭에 맞게 축소해서 보여준다 (인쇄에는 영향 없음).
   * zoom 대신 transform을 쓴다 — iOS Safari는 zoom 안에서 글자를 따로 키워(text autosizing)
   * 합계 줄이 겹치고 오른쪽 칸이 잘리는 문제가 있었다. */
  function fitPreview() {
    const area = document.getElementById('invoice-print-area');
    const sheet = area && area.querySelector('.inv-preview-sheet');
    const wrap = area && area.querySelector('.inv-preview-wrap');
    if (!sheet || !wrap) return;
    sheet.style.transform = '';
    const w = sheet.offsetWidth, h = sheet.offsetHeight;
    const scale = Math.min(1, (window.innerWidth - 16) / w);
    sheet.style.transform = scale < 1 ? `scale(${scale})` : '';
    wrap.style.width = Math.round(w * scale) + 'px';
    wrap.style.height = Math.round(h * scale) + 'px';
  }

  // ── PDF 저장 / 공유 ─────────────────────────────────────────
  // 홈 화면에 추가한 앱(iOS 독립 실행)이나 카톡 등 앱 안 브라우저에서는 window.print()도,
  // Safari 공유 버튼도 없다. 그래서 명세서를 그림으로 그려 PDF 파일을 직접 만들고,
  // 공유 시트(파일 저장·카톡·메일·프린트)가 되면 공유, 안 되면 파일로 내려받는다.
  const PDF_LIBS = [
    ['https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
     'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H'],
    ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
     'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk']
  ];
  let pdfLibsPromise = null;
  function loadPdfLibs() {
    if (window.html2canvas && window.jspdf) return Promise.resolve();
    if (pdfLibsPromise) return pdfLibsPromise;
    pdfLibsPromise = PDF_LIBS.reduce((p, [src, sri]) => p.then(() => new Promise((ok, fail) => {
      const el = document.createElement('script');
      el.src = src; el.integrity = sri; el.crossOrigin = 'anonymous';
      el.onload = ok; el.onerror = () => fail(new Error('PDF 라이브러리를 불러오지 못했습니다'));
      document.head.appendChild(el);
    })), Promise.resolve()).catch((e) => { pdfLibsPromise = null; throw e; });
    return pdfLibsPromise;
  }

  async function makePdfBlob() {
    await loadPdfLibs();
    const area = document.getElementById('invoice-print-area');
    const sheet = area.querySelector('.inv-preview-sheet');
    const prev = sheet.style.transform;
    sheet.style.transform = '';                       // 원래 크기(A4 폭)로 그린다
    try {
      const canvas = await window.html2canvas(sheet, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = 210, pageH = 297;
      const imgH = canvas.height * pageW / canvas.width;
      const img = canvas.toDataURL('image/jpeg', 0.92);
      for (let y = 0; y < imgH - 0.5; y += pageH) {   // A4보다 길면 여러 장으로
        if (y > 0) pdf.addPage();
        pdf.addImage(img, 'JPEG', 0, -y, pageW, imgH);
      }
      return pdf.output('blob');
    } finally {
      sheet.style.transform = prev;
    }
  }

  async function savePdf(btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'PDF 만드는 중…';
    try {
      const blob = await makePdfBlob();
      const name = `거래명세서_${currentPdfName || todayStr()}.pdf`;
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); }
        catch (e) { if (e && e.name !== 'AbortError') throw e; }   // 사용자가 공유 창을 닫은 경우는 오류 아님
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) {
      alert('PDF를 만들지 못했습니다: ' + (e && e.message ? e.message : e) + '\n인터넷 연결을 확인한 뒤 다시 눌러 주세요.');
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }
  let currentPdfName = '';

  function closePreview() {
    const area = document.getElementById('invoice-print-area');
    if (area) area.classList.remove('inv-preview-open');
  }

  /** 공급받는자/공급자 정보 박스 하나를 만듭니다. 짧은 항목(상호·대표자, 전화·팩스)은
   * 한 줄에 나란히, 긴 항목(사업자번호·주소)은 한 줄 전체를 씁니다. */
  function renderInfoBox(title, party) {
    return `
      <div class="inv-info-box">
        <div class="inv-info-title">${escapeHtml(title)}</div>
        <div class="inv-info-line"><b>사업자번호:</b> ${escapeHtml(party.bizno || '-')}</div>
        <div class="inv-info-line-pair"><span class="inv-info-half"><b>상호:</b> ${escapeHtml(party.company || party.name || '-')}</span><span class="inv-info-half"><b>대표자:</b> ${escapeHtml(party.ceo || '-')}</span></div>
        <div class="inv-info-line-pair"><span class="inv-info-half"><b>전화번호:</b> ${escapeHtml(party.tel || '-')}</span><span class="inv-info-half"><b>팩스번호:</b> ${escapeHtml(party.fax || '-')}</span></div>
        <div class="inv-addr-line"><span class="inv-addr-label"><b>주소:</b></span><span class="inv-addr-value">${escapeHtml(party.addr || '-')}</span></div>
      </div>`;
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
          ${renderInfoBox('공급받는자', { company: buyer.name, ...buyer })}
          ${renderInfoBox('공급자', company)}
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
                <td style="text-align:right">${fmtNum(it.qty)}</td>
                <td style="text-align:right">${fmtNum(it.unitPrice)}</td>
                <td style="text-align:right">${fmtNum(it.subtotal)}</td>
                <td style="text-align:right">${fmtNum(it.vat)}</td>
                <td style="text-align:right">${fmtNum(it.total)}</td>
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
    // 미리보기 바는 모바일 미리보기 화면에서만 보이고 인쇄에는 찍히지 않는다 (invoice.css)
    const m = /전표No:\s*([^<\s]+)/.exec(html);
    currentPdfName = m ? m[1] : '';
    area.innerHTML = `
      <div class="inv-preview-bar">
        <button type="button" class="ls-btn-primary" data-role="inv-pdf">PDF 저장 / 공유</button>
        <button type="button" data-role="inv-print">인쇄</button>
        <button type="button" data-role="inv-close">✕ 닫기</button>
        <div class="inv-preview-hint">PDF 저장 / 공유를 누르면 파일 앱 저장·카톡·메일·프린트를 고를 수 있습니다.</div>
      </div>
      <div class="inv-preview-wrap"><div class="inv-preview-sheet">${html}</div></div>`;
    area.querySelector('[data-role="inv-pdf"]').addEventListener('click', (e) => savePdf(e.currentTarget));
    area.querySelector('[data-role="inv-print"]').addEventListener('click', () => window.print());
    area.querySelector('[data-role="inv-close"]').addEventListener('click', closePreview);
  }

  return { generate, exportExcel };
})();

window.InvoiceModule = InvoiceModule;
