import { test, expect } from '@playwright/test';

const API_KEY = 'your-secret-token';
const BASE_URL = 'http://localhost:8787';
const ADMIN_UI = `${BASE_URL}/${API_KEY}/ui`;

test.describe('LLM Gateway Admin UI E2E Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto(ADMIN_UI, { timeout: 60000 });
    await page.waitForSelector('text=LLM GATEWAY', { timeout: 10000 });
  });

  test('should display provider list', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible();
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
  });

  test('should rename a provider alias', async ({ page }) => {
    // 1. 找到包含 ./oauth_creds_1.json 的那一行
    const row = page.locator('tr:has-text("./oauth_creds_1.json")');
    await expect(row).toBeVisible();
    
    // 2. 点击编辑图标
    await row.locator('text=✏️').click();
    
    // 3. 输入新名字
    const newName = `Playwright_${Date.now()}`;
    await page.fill('#renameInput', newName);
    await page.click('#renameBtn');
    
    // 4. 验证名字更新
    await expect(page.locator(`.alias-text:has-text("${newName}")`)).toBeVisible({ timeout: 10000 });
    console.log(`Verified rename to: ${newName}`);
  });

  test('should trigger delete confirmation', async ({ page }) => {
    const row = page.locator('tr:has-text("./oauth_creds_1.json")');
    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('Delete?');
      await dialog.dismiss();
    });
    await row.locator('text=Del').click();
  });
});