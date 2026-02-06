import { test, expect } from '@playwright/test';

const API_KEY = 'your-secret-token';
const BASE_URL = 'http://localhost:8787';
const ADMIN_UI = `${BASE_URL}/ui`;

test.describe('LLM Gateway Admin UI E2E Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    // 1. 访问页面 (触发域名初始化)
    await page.goto(ADMIN_UI, { timeout: 60000 });
    
    // 2. 直接注入 localStorage 绕过登录
    await page.evaluate((key) => {
        localStorage.setItem('llm_gate_key', key);
    }, API_KEY);
    
    // 3. 刷新页面应用 Token
    await page.reload();
    
    // 4. 等待主应用可见
    const logo = page.locator('.logo');
    await expect(logo).toBeVisible({ timeout: 15000 });
  });

  test('should display provider list', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible();
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
  });

  test('should rename a provider alias', async ({ page }) => {
    const row = page.locator('tr').filter({ hasText: './oauth_creds_1.json' });
    await expect(row).toBeVisible();
    
    await row.locator('text=✏️').click();
    await expect(page.locator('#renameModal')).toHaveClass(/show/);
    
    const newName = `Renamed_${Date.now()}`;
    await page.fill('#renameInput', newName);
    await page.click('#renameBtn');
    
    await expect(row.locator('.alias-text')).toContainText(newName, { timeout: 15000 });
    console.log(`Successfully verified rename to: ${newName}`);
  });
});