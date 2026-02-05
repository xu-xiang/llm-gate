# LLM Gateway Test Suite

本项目采用 Playwright 进行端到端 (E2E) 测试，确保网关管理面与核心逻辑的稳定性。

## 测试目录结构
- `tests/e2e/`: UI 交互与全链路 API 测试。
- `tests/unit/`: 核心算法与存储逻辑单元测试。

## 核心测试场景 (E2E)
1. **Console Accessibility**: 验证管理面在 `/:apiKey/ui` 下的访问权限。
2. **Provider Management**:
   - **Loading**: 验证 Provider 列表加载。
   - **Rename**: 验证账号别名修改及后端热重载（Hot Reload）。
   - **Delete**: 验证账号数据从 KV 中移除及其对路由池的影响。
3. **Authentication Flow**:
   - **New Account**: 验证 OAuth 启动与 Device Code 展示。
   - **Repair Login**: 验证针对失效账号的原位修复逻辑。

## 运行测试
运行所有 E2E 测试（会自动启动本地模拟服务器）：
```bash
npm run test:e2e
```

## 注意事项
- 测试运行在 `8888` 端口，以避免与 `dev` 端口冲突。
- 依赖本地 KV 播种，请确保运行前 `oauth_creds_1.json` 存在。
