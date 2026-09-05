// Run against the admin dev server with Playwright available in NODE_PATH:
// node apps/admin/test/mobile-logout.cjs
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const type of ['ordinary', 'organization']) {
      for (const width of [390, 652]) {
        const context = await browser.newContext({ viewport: { width, height: 698 }, hasTouch: true, isMobile: true });
        const page = await context.newPage();
        let logoutRequests = 0;
        await page.route('**/api/**', async route => {
          const path = new URL(route.request().url()).pathname;
          let payload = { rows: [] };
          if (path === '/api/auth/me') payload = {
            user: { id: 'TEST', type, name: '测试用户', phone: '13800000001', mustChangePassword: false },
            organizations: type === 'organization' ? [{ id: 'O1', ownerUserId: 'TEST', name: '测试组织', status: 'active', reviewStatus: 'approved' }] : []
          };
          if (path === '/api/public/event') payload = { event: { name: '测试赛事' }, projects: [], grades: [] };
          if (path === '/api/auth/logout') logoutRequests++;
          await route.fulfill({ json: payload });
        });
        await page.goto(process.env.ADMIN_TEST_URL || 'http://127.0.0.1:5174/admin/');
        await page.locator('.user-sidebar-mobile-trigger').tap();
        const button = page.locator('.user-logout-button');
        // Move into the sidebar, as the compatibility mouse events on touch do.
        // The bottom-aligned logout hit target must not move when :hover starts.
        await page.waitForFunction(() => Math.abs(document.querySelector('#user-sidebar').getBoundingClientRect().x) < 1);
        const before = await button.boundingBox();
        await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
        const after = await button.boundingBox();
        console.log(JSON.stringify({ type, width, beforeY: before.y, afterY: after.y }));
        assert.ok(Math.abs(before.y - after.y) < 1, 'Logout must keep its hit target on first hover');
        await button.focus();
        const focused = await button.boundingBox();
        assert.ok(Math.abs(before.y - focused.y) < 1, 'Logout must keep its hit target on focus');
        await page.touchscreen.tap(before.x + before.width / 2, before.y + before.height / 2);
        await page.locator('.auth-shell').waitFor();
        assert.equal(logoutRequests, 1, 'One tap must send exactly one logout request');
        assert.equal(await page.locator('.user-shell').count(), 0);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
