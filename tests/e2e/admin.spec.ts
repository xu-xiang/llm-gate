import { test, expect } from '@playwright/test';

const API_KEY = 'your-secret-token';
const BASE_URL = 'http://localhost:8787';
const ADMIN_UI = `${BASE_URL}/${API_KEY}/ui`;

test.describe('LLM Gateway Admin UI E2E Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto(ADMIN_UI, { timeout: 60000 });
    await page.waitForSelector('text=LLM Gateway', { timeout: 15000 });
  });

  test('should display provider list', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible();
    const rows = page.locator('table tbody tr');
    // 等待数据实际渲染（非 Loading 状态）
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
  });

  test('should rename a provider alias', async ({ page }) => {
    // 1. 找到特定账号所在的行
    const row = page.locator('tr').filter({ hasText: './oauth_creds_1.json' });
    await expect(row).toBeVisible();
    
    // 2. 点击该行内的编辑图标
    await row.locator('text=✏️').click();
    
    // 3. 等待重命名弹窗展示并输入新名字
    await expect(page.locator('#renameModal')).toHaveClass(/show/);
    const newName = `Renamed_${Date.now()}`;
    await page.fill('#renameInput', newName);
    
    // 4. 点击保存
    await page.click('#renameBtn');
    
    // 5. 验证 UI 更新 (等待直到该行的 alias-text 包含新名字)
    await expect(row.locator('.alias-text')).toContainText(newName, { timeout: 15000 });
    console.log(`Successfully verified rename to: ${newName}`);
  });

  test('should trigger delete confirmation', async ({ page }) => {
    const row = page.locator('tr').filter({ hasText: './oauth_creds_1.json' });
    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('Delete?');
      await dialog.dismiss();
    });
    await row.locator('text=Del').click();
  });
});
