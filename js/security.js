// ══════════════════════════════════════════════════════════════
// security.js — XSS 방지 및 입력 검증 공통 함수
// iERP 2.0 / 1단계 모듈
//
// 의존성: 없음 (제일 먼저 로드되어야 함 — 다른 모든 모듈이 이 파일의
// 함수를 사용합니다)
//
// 설계 원칙 (iERP 1.0에서 배운 것):
//   - 사용자 입력값(거래처명·품목명·메모 등)을 innerHTML로 화면에
//     넣는 모든 지점은 예외 없이 escapeHtml()을 거쳐야 한다.
//   - 목록 화면뿐 아니라 인쇄용 문서(거래명세서), 자동완성 옵션,
//     input의 value 속성까지 전부 대상이다. (1.0에서 이 중 몇 곳을
//     누락해서 뒤늦게 발견한 적이 여러 번 있었음)
// ══════════════════════════════════════════════════════════════

/**
 * HTML 특수문자를 이스케이프하여 XSS(악성 스크립트 삽입)를 방지합니다.
 * 사용자가 입력한 값을 화면에 표시할 때는 예외 없이 이 함수를 거칩니다.
 *
 * @param {*} value - 이스케이프할 값 (문자열이 아니어도 문자열로 변환 후 처리)
 * @returns {string} 이스케이프된 안전한 문자열
 *
 * @example
 * el.innerHTML = `<div>${escapeHtml(customer.name)}</div>`;
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

/**
 * 콤마·공백이 섞인 숫자 문자열을 안전한 숫자로 변환합니다.
 * 값이 없거나 숫자로 변환할 수 없으면 0을 반환합니다 (NaN이 계산식에
 * 섞여 화면에 "NaN"이 표시되는 사고를 방지).
 *
 * @param {*} value
 * @returns {number}
 */
function rawNum(value) {
  const n = parseFloat(String(value ?? '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/**
 * 대략적인 이메일 형식 검증. 서버 측 검증(Firebase Auth 자체 검증)을
 * 대체하지 않으며, 사용자에게 즉각적인 입력 피드백을 주는 용도입니다.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/**
 * "품목명 (규격)"처럼 괄호로 결합되어 표시된 자동완성 값을,
 * 실제 저장에 쓸 이름/부가정보로 분리합니다.
 * 괄호 형식이 아니면 { name: 원본, hint: '' }를 반환합니다.
 *
 * (배경: 자동완성 목록에는 "이름 (규격)"처럼 사람이 구분하기 좋은
 * 형태로 보여주되, 실제로 선택했을 때는 이름과 규격을 각 입력칸에
 * 정확히 나눠 넣어야 한다 — iERP 1.0에서 이 분리 로직이 없어서
 * 선택해도 단가 자동입력이 안 되던 버그가 있었음)
 *
 * @param {string} raw
 * @returns {{name: string, hint: string}}
 */
function splitNameAndHint(raw) {
  const text = String(raw || '');
  const match = text.match(/^(.*)\s\(([^()]*)\)$/);
  if (match) return { name: match[1].trim(), hint: match[2].trim() };
  return { name: text.trim(), hint: '' };
}

/**
 * 오늘 날짜를 "브라우저의 로컬(현지) 시간" 기준 YYYY-MM-DD로 반환합니다.
 * `new Date().toISOString()`은 UTC(세계표준시) 기준이라, 한국(UTC+9)
 * 새벽 0시~9시 사이에는 UTC로 아직 전날이라서 날짜 입력창 기본값·
 * 거래명세서 발행일·전표번호 채번 날짜가 전부 하루 전으로 잘못
 * 채워지는 사고가 있었다. 반드시 이 함수로 통일해서 그 문제를 막는다.
 * @returns {string} 예: '2026-08-22'
 */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 다른 모듈에서 전역으로 사용할 수 있도록 window에 등록
window.escapeHtml = escapeHtml;
window.rawNum = rawNum;
window.isValidEmail = isValidEmail;
window.splitNameAndHint = splitNameAndHint;
window.todayStr = todayStr;
