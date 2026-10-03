// iERP 2.0 E2E — runs the real app files against an in-memory Firebase mock.
// Every request to real Firebase/Google endpoints is aborted and counted (must stay 0).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.IERP_DIR || path.join(__dirname, '..');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-firebase.js'), 'utf8');
const BASE = 'http://ierp.test/';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

let realFirebaseHits;

test.beforeEach(async ({ page }) => {
  realFirebaseHits = [];
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('gstatic.com/firebasejs/')) {
      return route.fulfill({ contentType: 'application/javascript', body: url.includes('app-compat') ? MOCK : '/* stub */' });
    }
    if (/googleapis\.com|firebaseio\.com|firebaseapp\.com|firebase\.google/.test(url)) {
      realFirebaseHits.push(url);
      return route.abort();
    }
    if (url.startsWith(BASE)) {
      const rel = decodeURIComponent(new URL(url).pathname.slice(1)) || 'index.html';
      const file = path.join(APP_DIR, rel);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      let body = fs.readFileSync(file);
      // Firebase SDK는 mock으로 바꿔치기하므로 그 스크립트의 SRI 속성만 뗀다
      // (xlsx·Chart.js는 실제 CDN 파일을 받아 SRI 검증을 그대로 거친다).
      if (rel === 'index.html') {
        body = body.toString('utf8').replace(/(firebasejs\/[^"]+")\s+integrity="[^"]+"\s+crossorigin="anonymous"/g, '$1');
      }
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body });
    }
    return route.continue(); // CDN libs (xlsx, chart.js)
  });
});

test.afterEach(() => {
  expect(realFirebaseHits, 'must never contact the real Firebase project').toEqual([]);
});

async function boot(page) {
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await (d.type() === 'prompt' ? d.dismiss() : d.accept()); });
  await page.goto(BASE);
  await expect(page.locator('#ls-login')).toBeVisible();
  await page.evaluate(async () => {
    await doRegister({ username: 'tester', password: 'secret123', company: '테스트상사' });
    await doLogout();
    LayoutShell.showLoginScreen();
  });
  await page.fill('#ls-login-id', 'tester');
  await page.fill('#ls-login-pw', 'secret123');
  await page.click('#ls-login-btn');
  await expect(page.locator('#ls-app')).toBeVisible();
  await expect(page.locator('#ls-sync-label')).toHaveText('실시간 동기화 중');
  return dialogs;
}
const nav = (page, id) => page.click(`.ls-menu-item[data-panel="${id}"]`);
const coPath = async (page, col) => page.evaluate((c) => `users/${getAuthState().currentUser.safeId}/companies/${curCompanyId()}/${c}`, col);
const dump = async (page, col) => page.evaluate((p) => window.__mockFb.dump(p), await coPath(page, col));

async function addCustomer(page, name) {
  await nav(page, 'customers');
  await page.click('#cu-add-btn');
  await page.fill('#cu-name', name);
  await page.click('#cu-save-btn');
  await expect(page.locator('#cu-panel-bg')).toBeHidden();
}
async function addProduct(page, { name, spec, price, init }) {
  await nav(page, 'products');
  await page.click('#pr-add-btn');
  await page.fill('#pr-name', name);
  await page.fill('#pr-spec', spec);
  await page.fill('#pr-price', String(price));
  await page.fill('#pr-initstock', String(init));
  await page.click('#pr-save-btn');
  await expect(page.locator('#pr-panel-bg')).toBeHidden();
}
async function fillTxRow(page, prefix, row, { item, qty, price, isReturn }) {
  const r = page.locator(`#${prefix}-items-container .sl-item-row`).nth(row);
  await r.locator('.ri-item').fill(item);
  await r.locator('.ri-item').dispatchEvent('change');
  await r.locator('.ri-qty').fill(String(qty));
  if (price !== undefined) { await r.locator('.ri-price').fill(String(price)); }
  if (isReturn) await r.locator('.ri-return').check();
}
async function addPurchase(page, { vendor, date, item, qty, price }) {
  await nav(page, 'purchase');
  await page.click('#pu-add-btn');
  await page.fill('#pu-date', date);
  await page.fill('#pu-vendor-name', vendor);
  await fillTxRow(page, 'pu', 0, { item, qty, price });
  await page.click('#pu-save-btn');
  await expect(page.locator('#pu-panel-bg')).toBeHidden();
}
async function addSale(page, { buyer, date, item, qty, price, isReturn }) {
  await nav(page, 'sales');
  await page.click('#sl-add-btn');
  await page.fill('#sl-date', date);
  await page.fill('#sl-buyer-name', buyer);
  await fillTxRow(page, 'sl', 0, { item, qty, price, isReturn });
  await page.click('#sl-save-btn');
  await expect(page.locator('#sl-panel-bg')).toBeHidden();
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ─────────────────────────────────────────────────────────────

test('로그인: 틀린 비밀번호 / 없는 아이디 / 정상 로그인', async ({ page }) => {
  await boot(page);
  await page.click('#ls-logout-btn');
  await expect(page.locator('#ls-login')).toBeVisible();

  await page.fill('#ls-login-id', 'tester');
  await page.fill('#ls-login-pw', 'wrongpw');
  await page.click('#ls-login-btn');
  await expect(page.locator('#ls-login-err')).toHaveText('비밀번호가 틀렸습니다');

  await page.fill('#ls-login-id', 'nobody');
  await page.fill('#ls-login-pw', 'whatever');
  await page.click('#ls-login-btn');
  await expect(page.locator('#ls-login-err')).toHaveText('아이디가 존재하지 않습니다');

  await page.fill('#ls-login-id', 'tester');
  await page.fill('#ls-login-pw', 'secret123');
  await page.click('#ls-login-btn');
  await expect(page.locator('#ls-app')).toBeVisible();
  await expect(page.locator('#ls-company-tabs')).toHaveText('테스트상사');
});

test('메뉴 9개 화면이 모두 열린다', async ({ page }) => {
  await boot(page);
  for (const id of ['dashboard', 'daily', 'sales', 'purchase', 'stock', 'customers', 'products', 'dataimport', 'settings']) {
    await nav(page, id);
    await expect(page.locator(`#panel-${id}`)).toBeVisible();
  }
});

test('거래처: 등록/수정/삭제 + XSS 이스케이프', async ({ page }) => {
  await boot(page);
  const xss = '<img src=x onerror="window.__xss=1">악성';
  await addCustomer(page, xss);
  await expect(page.locator('#cu-list-card tbody')).toContainText(xss);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  await page.locator('#cu-list-card button[data-act="edit"]').first().click();
  await page.fill('#cu-name', '(주)정상거래처');
  await page.click('#cu-save-btn');
  await expect(page.locator('#cu-list-card tbody')).toContainText('(주)정상거래처');

  await page.locator('#cu-list-card button[data-act="del"]').first().click();
  await expect(page.locator('#cu-list-card tbody')).toContainText('데이터가 없습니다');
});

test('매입 → 매출 FIFO 원가, 재고현황, 일별현황', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '공급사A');
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addPurchase(page, { vendor: '공급사A', date: today(), item: '센서 (S-100)', qty: 5, price: 1200 });

  const pur = await dump(page, 'purchases');
  expect(pur).toHaveLength(1);
  expect(pur[0]).toMatchObject({ qty: 5, unitPrice: 1200, subtotal: 6000, vat: 600, total: 6600, remainingQty: 5 });
  expect(pur[0].docNo).toMatch(/^P\d{8}-01$/);

  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 12, price: 2000 });
  const sales = await dump(page, 'sales');
  expect(sales).toHaveLength(1);
  expect(sales[0]).toMatchObject({ qty: 12, subtotal: 24000, vat: 2400, total: 26400, costOfGoods: 12400, costEstimated: false });

  await nav(page, 'stock');
  const row = page.locator('#stock-list-card tbody tr').first();
  await expect(row).toContainText('3');
  await expect(page.locator('#stock-kpis')).toContainText('₩3,600');

  await nav(page, 'daily');
  await expect(page.locator('#daily-kpis')).toContainText('₩26,400');
  await expect(page.locator('#daily-kpis')).toContainText('₩6,600');
  await expect(page.locator('#daily-kpis')).toContainText('₩11,600'); // 24000 - 12400
  await page.locator('#daily-list-card tbody tr', { hasText: '매출' }).first().click();
  await expect(page.locator('#daily-detail-panel')).toBeVisible();
});

test('[회귀] 매출 전표를 수정 없이 다시 저장해도 FIFO 재고가 이중 차감되면 안 된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 4, price: 2000 });
  let prod = (await dump(page, 'products'))[0];
  expect(prod.initStockRemaining).toBe(6);

  await nav(page, 'sales');
  await page.locator('#sl-list-card button[data-act="edit"]').first().click();
  await page.click('#sl-save-btn');
  await expect(page.locator('#sl-panel-bg')).toBeHidden();
  prod = (await dump(page, 'products'))[0];
  expect(prod.initStockRemaining, '재저장 후에도 남은 초기재고는 6이어야 함').toBe(6);
});

test('[회귀] 매출 삭제 시 FIFO 뱃치가 복원되어야 한다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 4, price: 2000 });
  await nav(page, 'sales');
  await page.locator('#sl-list-card button[data-act="del"]').first().click();
  await expect(page.locator('#sl-list-card tbody')).toContainText('데이터가 없습니다');
  await nav(page, 'stock');
  await expect(page.locator('#stock-kpis'), '재고금액은 10 x 1,000').toContainText('₩10,000');
});

test('매입 뱃치까지 걸친 매출: 재저장 시 유지, 선택삭제 시 초기재고·매입 모두 복원', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '공급사A');
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 2 });
  await addPurchase(page, { vendor: '공급사A', date: today(), item: '센서 (S-100)', qty: 5, price: 1200 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 4, price: 2000 });
  const check = async (init, rem) => {
    expect((await dump(page, 'products'))[0].initStockRemaining).toBe(init);
    expect((await dump(page, 'purchases'))[0].remainingQty).toBe(rem);
  };
  await check(0, 3);
  expect((await dump(page, 'sales'))[0].costOfGoods).toBe(4400);

  await nav(page, 'sales');
  await page.locator('#sl-list-card button[data-act="edit"]').first().click();
  await page.click('#sl-save-btn');
  await expect(page.locator('#sl-panel-bg')).toBeHidden();
  await check(0, 3);
  expect((await dump(page, 'sales'))[0].costOfGoods).toBe(4400);

  await page.locator('#sl-list-card .te-row-check').first().check();
  await page.click('#sl-list-card [data-role="bulk-delete"]');
  await expect(page.locator('#sl-list-card tbody')).toContainText('데이터가 없습니다');
  await check(2, 5);
  await nav(page, 'stock');
  await expect(page.locator('#stock-kpis')).toContainText('₩8,000'); // 2x1000 + 5x1200
});

test('[회귀] 반품(G 전표)을 일별현황에서 클릭하면 상세가 열려야 한다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 2, price: 2000, isReturn: true });
  const s = (await dump(page, 'sales'))[0];
  expect(s.docNo).toMatch(/^G/);
  expect(s.total).toBe(-4400);
  await nav(page, 'daily');
  await page.locator('#daily-list-card tbody tr').first().click();
  await expect(page.locator('#daily-detail-panel')).toBeVisible({ timeout: 2000 });
});

test('여러 품목 한 전표 + 명세서(인쇄 영역) 생성', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addProduct(page, { name: '모터', spec: 'M-1', price: 5000, init: 3 });
  await nav(page, 'sales');
  await page.click('#sl-add-btn');
  await page.fill('#sl-buyer-name', '고객B');
  await fillTxRow(page, 'sl', 0, { item: '센서 (S-100)', qty: 2 });
  await page.click('#sl-add-row-btn');
  await fillTxRow(page, 'sl', 1, { item: '모터 (M-1)', qty: 1 });
  await expect(page.locator('#sl-doc-totals')).toHaveText('공급가액 7,000 + 부가세(10%) 700 = 합계 7,700');
  await page.click('#sl-save-btn');
  await expect(page.locator('#sl-panel-bg')).toBeHidden();
  expect(await dump(page, 'sales')).toHaveLength(2);
  await expect(page.locator('#sl-list-card tbody tr')).toHaveCount(1); // grouped by docNo

  await page.locator('#sl-list-card button[data-act="invoice"]').first().click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('#invoice-print-area')).toContainText('거 래 명 세 서');
  await expect(page.locator('#invoice-print-area')).toContainText('7,700');
});

test('[회귀] 설정 화면에 로그인 아이디가 표시되어야 한다', async ({ page }) => {
  await boot(page);
  await nav(page, 'settings');
  await expect(page.locator('#st-uid')).toHaveValue('tester');
});

test('회사 추가/전환 시 데이터가 분리된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '첫회사거래처');
  await nav(page, 'settings');
  await page.fill('#st-new-co-name', '두번째회사');
  await page.click('#st-add-co');
  await page.click('#st-company-list button[data-act="switch"]');
  await expect(page.locator('#ls-company-tabs')).toHaveText('두번째회사');
  await nav(page, 'customers');
  await expect(page.locator('#cu-list-card tbody')).toContainText('데이터가 없습니다');
});

test('JSON 백업 내보내기 → 데이터 변경 → 복원', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 3, price: 2000 });

  await nav(page, 'settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#st-export-btn')]);
  const backupPath = await download.path();
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  expect(backup.customers).toHaveLength(1);
  expect(backup.sales).toHaveLength(1);

  await addCustomer(page, '나중에추가된거래처');
  expect(await dump(page, 'customers')).toHaveLength(2);

  await nav(page, 'settings');
  // 복원 직전에 현재 데이터(거래처 2개)가 자동으로 먼저 내려받아져야 한다
  const [autoBackup] = await Promise.all([page.waitForEvent('download'), page.setInputFiles('#st-restore-file', backupPath)]);
  expect(autoBackup.suggestedFilename()).toMatch(/^iERP_before_restore_.*\.json$/);
  const before = JSON.parse(fs.readFileSync(await autoBackup.path(), 'utf8'));
  expect(before.customers.map((c) => c.name).sort()).toEqual(['고객B', '나중에추가된거래처']);
  await expect(page.locator('#st-restore-btn')).toHaveText('JSON에서 복원');
  await expect.poll(async () => (await dump(page, 'customers')).length).toBe(1);
  expect(await dump(page, 'sales')).toHaveLength(1);
  await nav(page, 'customers');
  await expect(page.locator('#cu-list-card tbody tr')).toHaveCount(1);
  await expect(page.locator('#cu-list-card tbody')).toContainText('고객B');
});

test('다크모드 토글이 새로고침 후에도 유지된다(localStorage)', async ({ page }) => {
  await boot(page);
  await page.click('#ls-theme-toggle');
  expect(await page.evaluate(() => document.body.getAttribute('data-theme'))).toBe('dark');
  await page.reload();
  expect(await page.evaluate(() => document.body.getAttribute('data-theme'))).toBe('dark');
});

test('품목 엑셀 업로드(대량 등록) — createdAt 포함, 중복 건너뜀', async ({ page }) => {
  const dialogs = await boot(page);
  await nav(page, 'products');
  const xlsxB64 = await page.evaluate(() => {
    const ws = XLSX.utils.aoa_to_sheet([['코드', '품목명', '규격', '기준단가', '초기재고'], ['C1', '볼트', 'M3', 100, 50], ['C1', '볼트', 'M3', 100, 50], ['C2', '너트', 'M3', 50, 20], ['', '', '', '', '']]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  });
  await page.setInputFiles('#pr-upload-input', { name: 'p.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xlsxB64, 'base64') });
  await expect.poll(() => dialogs.find((d) => d.includes('엑셀 업로드 완료'))).toBeTruthy();
  expect(dialogs.find((d) => d.includes('엑셀 업로드 완료'))).toContain('새로 등록: 2건');
  await expect(page.locator('#pr-list-card tbody tr')).toHaveCount(2);
});

test('[회귀] 검색·기간이 바뀌면 선택 삭제용 체크가 해제된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addCustomer(page, '고객C');
  await addSale(page, { buyer: '고객B', date: today(), item: '자유품목', qty: 1, price: 100 });
  await addSale(page, { buyer: '고객C', date: today(), item: '자유품목', qty: 1, price: 100 });
  await nav(page, 'sales');
  const bulk = page.locator('#sl-list-card [data-role="bulk-delete"]');
  await page.locator('#sl-list-card tbody .te-row-check').first().check();
  await expect(bulk).toBeVisible();
  await page.fill('#sl-list-card [data-role="search"]', '고객C');
  await expect(bulk).toBeHidden();
  await page.fill('#sl-list-card [data-role="search"]', '');
  await expect(page.locator('#sl-list-card tbody .te-row-check:checked')).toHaveCount(0);

  await page.locator('#sl-list-card tbody .te-row-check').first().check();
  await page.click('#sl-list-card [data-role="query"]');
  await expect(bulk).toBeHidden();
  expect(await dump(page, 'sales')).toHaveLength(2);
});

test('[회귀] 부가세 필드가 없는 옛 매출도 명세서 합계가 NaN이 아니다', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.print = () => {}; });
  await addCustomer(page, '고객B');
  await expect.poll(() => page.evaluate(() => CustomersModule.getCache().length)).toBe(1);
  const p = await coPath(page, 'sales');
  await page.evaluate(async ([p, date]) => {
    const buyer = CustomersModule.getCache()[0];
    await setDoc(p, 'legacy1', { docNo: 'S20200101-01', date, buyerId: buyer.id, buyer: buyer.name, item: '옛품목', qty: 1, unitPrice: 100, subtotal: 100, total: 110 });
  }, [p, today()]);
  await nav(page, 'sales');
  await page.locator('#sl-list-card button[data-act="invoice"]').first().click();
  const area = page.locator('#invoice-print-area');
  await expect(area).toContainText('합계: 110');
  await expect(area).not.toContainText('NaN');
});

test('[회귀] 로그아웃하면 이전 계정 데이터가 화면·캐시에서 지워진다', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.print = () => {}; });
  await addCustomer(page, '비밀거래처');
  await addSale(page, { buyer: '비밀거래처', date: today(), item: '자유품목', qty: 1, price: 100 });
  await nav(page, 'sales');
  await page.locator('#sl-list-card tbody tr').first().click();
  await expect(page.locator('#sl-detail-panel')).toBeVisible();
  await page.locator('#sl-list-card button[data-act="invoice"]').first().click();

  await page.click('#ls-logout-btn');
  await expect(page.locator('#ls-login')).toBeVisible();
  const state = await page.evaluate(() => ({
    cu: CustomersModule.getCache().length, sl: SalesModule.getCache().length,
    html: document.getElementById('ls-content').innerHTML + (document.getElementById('invoice-print-area')?.innerHTML || '')
  }));
  expect(state.cu).toBe(0);
  expect(state.sl).toBe(0);
  expect(state.html).not.toContain('비밀거래처');
  await expect(page.locator('#sl-detail-panel')).toBeHidden();

  // 다른 계정으로 로그인해도 이전 계정 데이터는 보이지 않는다
  await page.evaluate(async () => { await doRegister({ username: 'other', password: 'secret123', company: '다른회사' }); await doLogout(); });
  await page.fill('#ls-login-id', 'other');
  await page.fill('#ls-login-pw', 'secret123');
  await page.click('#ls-login-btn');
  await expect(page.locator('#ls-company-tabs')).toHaveText('다른회사');
  expect(await page.evaluate(() => document.getElementById('ls-content').innerHTML)).not.toContain('비밀거래처');
});

// ───────────── 2차 개선 회귀 테스트 ─────────────

test('반품은 가장 최근 출고분 원가로 재고에 복귀하고, 반품 삭제 시 다시 빠진다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '공급사A');
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addPurchase(page, { vendor: '공급사A', date: today(), item: '센서 (S-100)', qty: 5, price: 1200 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 12, price: 2000 });
  expect((await dump(page, 'purchases'))[0].remainingQty).toBe(3);

  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 2, price: 2000, isReturn: true });
  const ret = (await dump(page, 'sales')).find((s) => s.qty < 0);
  expect(ret.docNo).toMatch(/^G/);
  expect(ret.costOfGoods).toBe(-2400);
  expect((await dump(page, 'purchases'))[0].remainingQty).toBe(5);
  await nav(page, 'stock');
  await expect(page.locator('#stock-kpis')).toContainText('₩6,000');

  await nav(page, 'sales');
  await page.locator('#sl-list-card tbody tr', { hasText: '-4,400' }).locator('button[data-act="del"]').click();
  await expect.poll(async () => (await dump(page, 'purchases'))[0].remainingQty).toBe(3);
  await nav(page, 'stock');
  await expect(page.locator('#stock-kpis')).toContainText('₩3,600');
});

test('매입 단가를 수정하면 그 매입을 쓴 매출원가·재고금액이 자동 재계산된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '공급사A');
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 0, init: 0 });
  await addPurchase(page, { vendor: '공급사A', date: today(), item: '센서 (S-100)', qty: 5, price: 1000 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 3, price: 2000 });
  expect((await dump(page, 'sales'))[0].costOfGoods).toBe(3000);

  await nav(page, 'purchase');
  await page.locator('#pu-list-card button[data-act="edit"]').first().click();
  await page.locator('#pu-items-container .ri-price').first().fill('1500');
  await page.click('#pu-save-btn');
  await expect(page.locator('#pu-panel-bg')).toBeHidden();
  await expect.poll(async () => (await dump(page, 'sales'))[0].costOfGoods).toBe(4500);
  const pur = await dump(page, 'purchases');
  expect(pur).toHaveLength(1);
  expect(pur[0].remainingQty).toBe(2);
  await nav(page, 'stock');
  await expect(page.locator('#stock-kpis')).toContainText('₩3,000');
});

test('이미 출고된 매입을 삭제하면 경고 후 매출원가가 추정치로 재계산된다', async ({ page }) => {
  const dialogs = await boot(page);
  await addCustomer(page, '공급사A');
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 0, init: 0 });
  await addPurchase(page, { vendor: '공급사A', date: today(), item: '센서 (S-100)', qty: 5, price: 1000 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 3, price: 2000 });
  await nav(page, 'purchase');
  await page.locator('#pu-list-card button[data-act="del"]').first().click();
  await expect.poll(() => dialogs.some((d) => d.includes('3개가 이미 매출로 출고'))).toBe(true);
  await expect.poll(async () => (await dump(page, 'sales'))[0].costEstimated).toBe(true);
  expect(await dump(page, 'purchases')).toEqual([]);
});

test('FIFO 재계산은 값이 달라진 문서만 저장한다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  for (let i = 0; i < 3; i++) await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 1, price: 2000 });
  await expect.poll(async () => (await dump(page, 'sales')).length).toBe(3);
  const before = await page.evaluate(() => window.__mockFb.writes);
  const res = await page.evaluate(() => FifoEngine.recalcProduct(ProductsModule.getCache()[0].id, { silent: true }));
  expect(res).toEqual({ sales: 3, changedSales: 0, changedLots: 0 });
  expect(await page.evaluate(() => window.__mockFb.writes)).toBe(before);
});

test('전표번호 100번 이상도 99번 뒤에 정렬된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await expect.poll(() => page.evaluate(() => CustomersModule.getCache().length)).toBe(1);
  const p = await coPath(page, 'sales');
  await page.evaluate(async ([p, date]) => {
    const b = CustomersModule.getCache()[0];
    for (const n of ['100', '99', '101']) {
      await setDoc(p, 'd' + n, { docNo: `S20260926-${n}`, date, buyerId: b.id, buyer: b.name, item: 'x', qty: 1, unitPrice: 1, subtotal: 1, vat: 0, total: 1 });
    }
  }, [p, today()]);
  await nav(page, 'sales');
  await expect(page.locator('#sl-list-card tbody tr')).toHaveCount(3);
  const order = await page.locator('#sl-list-card tbody .sl-docno-link').allTextContents();
  expect(order).toEqual(['S20260926-99', 'S20260926-100', 'S20260926-101']);
});

test('대시보드는 회계연도 매출·매입과 매출총이익을 보여준다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 2, price: 3000 });
  const lastYear = `${new Date().getFullYear() - 1}-06-01`;
  await addSale(page, { buyer: '고객B', date: lastYear, item: '센서 (S-100)', qty: 1, price: 50000 });
  await nav(page, 'dashboard');
  const kpis = page.locator('#dash-kpis');
  await expect(kpis).toContainText('₩6,600');      // 올해 매출합계만 (6000 + VAT)
  await expect(kpis).not.toContainText('₩61,600');
  await expect(kpis).toContainText('매출총이익');
  await expect(kpis).toContainText('₩4,000');      // 6000 - 2x1000
  await expect(page.locator('#dash-fy-label')).toContainText(`${new Date().getFullYear()} 회계연도`);
});

test('숫자 칸에 문자열/HTML이 들어와도 실행되지 않고 이스케이프된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await expect.poll(() => page.evaluate(() => CustomersModule.getCache().length)).toBe(1);
  const p = await coPath(page, 'sales');
  await page.evaluate(async ([p, date]) => {
    const b = CustomersModule.getCache()[0];
    const evil = '<img src=x onerror="window.__xss2=1">';
    await setDoc(p, 'evil', { docNo: 'S20260926-01', date, buyerId: b.id, buyer: b.name, item: 'x', qty: 1, unitPrice: evil, subtotal: evil, vat: 0, total: 1 });
  }, [p, today()]);
  await nav(page, 'sales');
  await expect(page.locator('#sl-list-card tbody')).toContainText('<img src=x');
  await page.locator('#sl-list-card tbody tr').first().click(); // 전표 상세도 렌더
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__xss2)).toBeUndefined();
});

test('인터넷이 끊겨 캐시만 보이면 "오프라인", 다시 연결되면 "실시간 동기화 중"', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await page.evaluate(() => window.__mockFb.setOffline(true));
  await expect(page.locator('#ls-sync-label')).toHaveText('오프라인');
  await expect(page.locator('#cu-list-card tbody')).toContainText('고객B'); // 메타데이터 변화로 목록이 사라지지 않음
  await page.evaluate(() => window.__mockFb.setOffline(false));
  await expect(page.locator('#ls-sync-label')).toHaveText('실시간 동기화 중');
});

test('회사를 삭제하면 전표번호 기록(counters)도 함께 지워진다', async ({ page }) => {
  await boot(page);
  await nav(page, 'settings');
  await page.fill('#st-new-co-name', '지울회사');
  await page.click('#st-add-co');
  await page.click('#st-company-list button[data-act="switch"]');
  await expect(page.locator('#ls-company-tabs')).toHaveText('지울회사');
  await addCustomer(page, '고객B');
  await addSale(page, { buyer: '고객B', date: today(), item: '자유품목', qty: 1, price: 100 });
  const counters = await coPath(page, 'counters');
  expect((await page.evaluate((p) => window.__mockFb.dump(p), counters)).length).toBe(1);
  await nav(page, 'settings');
  await page.locator('.st-co-row', { hasText: '지울회사' }).locator('button[data-act="delete"]').click();
  await expect(page.locator('#ls-company-tabs')).toHaveText('테스트상사');
  await expect.poll(() => page.evaluate((p) => window.__mockFb.dump(p).length, counters)).toBe(0);
});

test('index.html의 CDN SRI 해시가 실제 CDN 파일과 일치한다', async () => {
  const crypto = require('crypto');
  const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script src="(https:[^"]+)" integrity="(sha384-[^"]+)"/g)];
  expect(tags.length).toBe(5);
  for (const [, url, integrity] of tags) {
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(`sha384-${crypto.createHash('sha384').update(buf).digest('base64')}`, url).toBe(integrity);
  }
});

test('일별현황은 기본으로 이번 달 1일~오늘만 보여준다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  const d = new Date();
  const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const prev = new Date(d.getFullYear(), d.getMonth(), 0); // 지난달 말일
  const prevStr = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
  await addSale(page, { buyer: '고객B', date: today(), item: '이번달품목', qty: 1, price: 1000 });
  await addSale(page, { buyer: '고객B', date: prevStr, item: '지난달품목', qty: 1, price: 50000 });

  await nav(page, 'daily');
  await expect(page.locator('#daily-list-card [data-role="date-from"]')).toHaveValue(monthStart);
  await expect(page.locator('#daily-list-card [data-role="date-to"]')).toHaveValue(today());
  await expect(page.locator('#daily-list-card tbody')).toContainText('이번달품목');
  await expect(page.locator('#daily-list-card tbody')).not.toContainText('지난달품목');
  await expect(page.locator('#daily-kpis')).toContainText('₩1,100');

  // 연도 선택으로 넓혀 보면 지난달 데이터도 나온다
  await page.selectOption('#daily-list-card [data-role="year"]', '__all__');
  await expect(page.locator('#daily-list-card tbody')).toContainText('지난달품목');
});

test('[회귀] 저장이 느릴 때 저장 버튼을 연달아 눌러도 매출이 한 번만 저장된다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객C');
  // 네트워크 지연 흉내: 트랜잭션(전표번호 채번·매출 저장)을 1.5초씩 늦춘다
  await page.evaluate(() => {
    const fs = firebase.firestore();
    const origTx = fs.runTransaction.bind(fs);
    fs.runTransaction = async (fn) => { await new Promise((r) => setTimeout(r, 1500)); return origTx(fn); };
  });
  await nav(page, 'sales');
  await page.click('#sl-add-btn');
  await page.fill('#sl-date', today());
  await page.fill('#sl-buyer-name', '고객C');
  await fillTxRow(page, 'sl', 0, { item: '중복방지품목', qty: 1, price: 1000 });
  await page.evaluate(() => { const b = document.getElementById('sl-save-btn'); b.click(); b.click(); b.click(); });
  await expect(page.locator('#sl-save-btn')).toBeDisabled();
  await expect(page.locator('#sl-save-btn')).toHaveText('저장 중…');
  await expect(page.locator('#sl-panel-bg')).toBeHidden();
  await expect(page.locator('#sl-save-btn')).toBeEnabled();
  const sales = await dump(page, 'sales');
  expect(sales.filter((s) => s.item === '중복방지품목')).toHaveLength(1);
});

test('[회귀] 다른 기기가 같은 재고를 먼저 팔면, 서버 최신 수량으로 다시 계산해 이중 차감하지 않는다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  // 이 기기가 저장을 커밋하기 직전에, 다른 기기가 같은 초기재고에서 3개를 팔았다고 흉내낸다
  await page.evaluate((p) => {
    window.__mockFb.beforeTxCommit = async (keys) => {
      if (!keys.some((k) => k.startsWith(p + '/'))) return false; // 전표번호 채번 트랜잭션은 건너뜀
      const id = window.__mockFb.dump(p)[0].id;
      await firebase.firestore().collection(p).doc(id).set({ initStockRemaining: 7 }, { merge: true });
    };
  }, await coPath(page, 'products'));
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 4, price: 2000 });
  expect(await page.evaluate(() => window.__mockFb.txRetries)).toBeGreaterThan(0);
  expect((await dump(page, 'products'))[0].initStockRemaining, '10 - 3(다른 기기) - 4(이 기기)').toBe(3);
  expect((await dump(page, 'sales'))[0]).toMatchObject({ costOfGoods: 4000, costEstimated: false });
});

test('[회귀] 다른 기기가 이미 지운 매출을 또 지워도 재고가 이중 복원되지 않는다', async ({ page }) => {
  await boot(page);
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });
  await addSale(page, { buyer: '고객B', date: today(), item: '센서 (S-100)', qty: 4, price: 2000 });
  expect((await dump(page, 'products'))[0].initStockRemaining).toBe(6);
  // 삭제를 커밋하기 직전: 다른 기기가 이 매출을 지워 4개를 되돌린 뒤(10) 5개를 새로 팔았다(5)
  await page.evaluate(([sp, pp]) => {
    window.__mockFb.beforeTxCommit = async () => {
      const fs = firebase.firestore();
      await fs.collection(sp).doc(window.__mockFb.dump(sp)[0].id).delete();
      await fs.collection(pp).doc(window.__mockFb.dump(pp)[0].id).set({ initStockRemaining: 5 }, { merge: true });
    };
  }, [await coPath(page, 'sales'), await coPath(page, 'products')]);
  await nav(page, 'sales');
  await page.locator('#sl-list-card button[data-act="del"]').first().click();
  await expect(page.locator('#sl-list-card tbody')).toContainText('데이터가 없습니다');
  expect((await dump(page, 'products'))[0].initStockRemaining, '이미 복원된 4개를 또 더하면 9가 됨').toBe(5);
});

test('하루 첫 접속 시 백업 파일을 자동으로 받고, 같은 날 다시 접속하면 받지 않는다', async ({ page }) => {
  await boot(page); // 빈 회사로 로그인 — 백업할 데이터가 없으니 자동 백업도 없어야 함
  await addCustomer(page, '고객B');
  await addProduct(page, { name: '센서', spec: 'S-100', price: 1000, init: 10 });

  // 다시 접속한 것처럼 자동 백업을 예약한다
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.evaluate(() => SettingsModule.scheduleAutoBackup())
  ]);
  expect(download.suggestedFilename()).toBe(`iERP_auto_테스트상사_${today()}.json`);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(backup.customers.map((c) => c.name)).toEqual(['고객B']);
  expect(backup.products).toHaveLength(1);
  await nav(page, 'settings');
  await expect(page.locator('#st-auto-backup-info')).toContainText(today());

  // 같은 날 또 접속하면 받지 않는다
  let again = false;
  page.on('download', () => { again = true; });
  await page.evaluate(() => SettingsModule.scheduleAutoBackup());
  await page.waitForTimeout(5000);
  expect(again).toBe(false);

  // 설정에서 끄면 다음 날이 되어도 받지 않는다
  await page.locator('#st-auto-backup').uncheck();
  await page.evaluate(() => { Object.keys(localStorage).filter((k) => k.startsWith('iERP_autoBackup_')).forEach((k) => localStorage.removeItem(k)); });
  await page.evaluate(() => SettingsModule.scheduleAutoBackup());
  await page.waitForTimeout(5000);
  expect(again).toBe(false);
});
