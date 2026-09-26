// iERP E2E 설정 — 앱 파일은 page.route로 디스크에서 직접 서빙하므로 별도 웹서버가 필요 없다.
// Firebase SDK는 mock-firebase.js(메모리 DB)로 바꿔치기하고, 실제 Firebase/Google
// 주소로 나가는 요청은 전부 차단·집계해서 1건이라도 있으면 테스트를 실패시킨다.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 20000,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { browserName: 'chromium', headless: true, acceptDownloads: true }
});
