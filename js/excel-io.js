// ══════════════════════════════════════════════════════════════
// excel-io.js — 엑셀 업로드/다운로드 공용 모듈
// iERP 2.0
//
// 의존성: SheetJS(xlsx.full.min.js, index.html에서 CDN으로 로드),
//         security.js(escapeHtml는 여기선 안 씀 — 참고용 주석)
//
// 설계 원칙:
//   - 이 모듈은 "엑셀 파일 ↔ 자바스크립트 배열" 변환만 담당한다.
//     그 배열을 어떻게 검증하고 Firestore에 저장할지는 각 화면
//     모듈(products.js 등)이 알아서 한다 — 화면마다 필드 구성과
//     중복 처리 정책이 다르기 때문에, 여기서 그 로직까지 떠안으면
//     오히려 화면마다 억지로 끼워맞추게 된다.
//   - 품목뿐 아니라 나중에 매출·매입 등 다른 화면에서도 그대로
//     재사용할 수 있도록, 특정 화면 지식(품목 필드명 등)을 이
//     파일에 넣지 않는다.
// ══════════════════════════════════════════════════════════════

const ExcelIO = (() => {
  /**
   * 사용자가 고른 엑셀 파일(.xlsx/.xls/.csv)을 읽어, 첫 번째 시트를
   * "헤더 줄 = 각 칸의 키" 형태의 객체 배열로 변환합니다.
   * 예: 헤더가 "품목명, 규격"이면 각 행이 { 품목명: '...', 규격: '...' }.
   * @param {File} file - <input type="file"> 에서 얻은 파일 객체
   * @returns {Promise<object[]>}
   */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const firstSheetName = wb.SheetNames[0];
          const sheet = wb.Sheets[firstSheetName];
          // defval: '' — 빈 칸을 undefined 대신 빈 문자열로 통일해,
          // 각 화면 모듈에서 매번 null 체크를 반복하지 않아도 되게 한다.
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * 헤더 줄만 있는 빈 엑셀 템플릿을 다운로드합니다 (사용자가 이 양식에
   * 맞춰 채운 뒤 다시 업로드하도록 안내하는 용도).
   * @param {string} filename - 확장자(.xlsx) 포함
   * @param {string[]} headers - 첫 줄에 들어갈 칼럼명 목록
   */
  function downloadTemplate(filename, headers) {
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, filename);
  }

  /**
   * 객체 배열을 엑셀 파일로 다운로드합니다 (현재 등록된 데이터를
   * 백업하거나 확인하는 용도).
   * @param {string} filename - 확장자(.xlsx) 포함
   * @param {object[]} rows - 각 행 데이터 (키가 그대로 헤더가 됨)
   * @param {string[]} [headerOrder] - 칼럼 순서를 강제하고 싶을 때 지정
   * @param {string[]} [numberFormatCols] - 천단위 콤마(#,##0) 서식을 적용할
   *   칼럼명 목록 (headerOrder에 쓴 이름과 동일해야 함). 셀 값 자체는
   *   그대로 숫자로 저장되고, 화면에 보이는 표시 방식만 바뀝니다 —
   *   그래서 엑셀에서 계산식(합계 등)에 그대로 활용할 수 있습니다.
   */
  function download(filename, rows, headerOrder, numberFormatCols) {
    const ws = headerOrder
      ? XLSX.utils.json_to_sheet(rows, { header: headerOrder })
      : XLSX.utils.json_to_sheet(rows);

    if (numberFormatCols && numberFormatCols.length) {
      const headers = headerOrder || Object.keys(rows[0] || {});
      const range = XLSX.utils.decode_range(ws['!ref']);
      numberFormatCols.forEach((colName) => {
        const colIdx = headers.indexOf(colName);
        if (colIdx === -1) return;
        for (let r = range.s.r + 1; r <= range.e.r; r++) { // +1: 헤더 줄(0행)은 건너뜀
          const cellRef = XLSX.utils.encode_cell({ r, c: colIdx });
          const cell = ws[cellRef];
          if (cell && cell.t === 'n') cell.z = '#,##0';
        }
      });
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, filename);
  }

  /**
   * 헤더 줄이 맨 위에 있지 않은 레거시 리포트 형식(예: 기존 ERP에서
   * 뽑은 "OO명세서" 파일 - 위에 제목·조회조건 줄이 몇 줄 있고 그 아래에
   * 실제 헤더가 나옴)을 읽을 때 쓴다. readFile()과 달리 첫 줄을 헤더로
   * 가정하지 않고, 시트 전체를 "행의 배열"(각 행은 셀 값의 배열) 그대로
   * 돌려준다 — 실제 헤더가 몇 번째 줄인지는 호출한 쪽이 알아서 찾는다.
   * 날짜 칸은 문자열이 아니라 JS Date 객체로 파싱해서 돌려준다.
   * @param {File} file
   * @returns {Promise<Array[]>}
   */
  function readFileAOA(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
          const firstSheetName = wb.SheetNames[0];
          const sheet = wb.Sheets[firstSheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  return { readFile, readFileAOA, downloadTemplate, download };
})();

window.ExcelIO = ExcelIO;
