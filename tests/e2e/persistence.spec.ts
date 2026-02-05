import { test, expect } from '@playwright/test';

const API_KEY = 'your-secret-token';
const BASE_URL = 'http://localhost:8787';
const ADMIN_UI = `${BASE_URL}/${API_KEY}/ui`;

test.describe('LLM Gateway Admin UI Persistence Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto(ADMIN_UI, { timeout: 60000 });
    await page.waitForSelector('text=LLM Gateway', { timeout: 10000 });
  });

  test('deleted provider should not reappear after other actions', async ({ page }) => {
    // 1. 确保至少有两个账号
    const rows = page.locator('table tbody tr');
    const initialCount = await rows.count();
    console.log(`Initial providers: ${initialCount}`);

    // 2. 删除第一个账号 (假设是 ./oauth_creds_1.json)
    const firstId = await rows.first().locator('div[style*="font-family:monospace"]').innerText();
    console.log(`Deleting: ${firstId}`);
    
    page.on('dialog', d => d.accept());
    await rows.first().locator('text=Del').click();
    
    // 等待消失
    await expect(page.locator(`text=${firstId}`)).not.toBeVisible();

    // 3. 触发一次“重命名”操作，强制后端重新扫描
    const remainingRow = page.locator('table tbody tr').first();
    const otherId = await remainingRow.locator('div[style*="font-family:monospace"]').innerText();
    await remainingRow.locator('text=✏️').click();
    await page.fill('#renameInput', 'PersistenceCheck');
    await page.click('#renameBtn');
    
    // 等待重命名成功
    await expect(page.locator('text=PersistenceCheck')).toBeVisible();

    // 4. 关键验证：被删除的 firstId 是否依然不存在
    await expect(page.locator(`text=${firstId}`)).not.toBeVisible();
    console.log(`Verified: ${firstId} stayed deleted after rescan.`);
  });
});
