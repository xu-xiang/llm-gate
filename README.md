# LLM Gateway (llm-gate)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xu-xiang/llm-gate)

这是一个专为 Cloudflare Workers 优化的 LLM 协议网关。本项目旨在通过 Serverless 架构，实现多账号负载均衡、自动 Token 刷新、以及极简的 Web 可视化管理。

> **技术初衷**：本项目仅用于技术探讨、接口协议兼容性验证及可观测性研究。使用前请确保您的行为符合相关服务商的开发者规范及法律法规。

---

## 🌟 核心特性

- **🚀 深度适配 Cloudflare Workers**：基于 Hono 框架，全量适配 Web API，无缝运行在 Cloudflare 全球边缘节点。
- **🏊‍♂️ 多账号池化 (Account Pooling)**：支持同时绑定多个 Qwen 账号，通过智能轮询实现配额扩容与故障自动转移。
- **🔐 分布式并发控制**：引入 KV 分布式锁机制，完美解决 Serverless 环境下多实例并发刷新 Token 的 Race Condition 问题。
- **📺 极简 Web 控制台**：
  - **路径隐藏**：管理后台隐藏在 `/<API_KEY>/ui` 路径下，确保安全。
  - **动态管理**：无需修改代码，直接在网页端添加、删除、重命名账号。
  - **实时监控**：可视化展示各账号状态、延迟、每日配额 (Daily) 及每分钟请求数 (RPM)。
- **🛠️ 流式传输优化**：内置 SSE Transformer，自动处理 Qwen API 偶尔产生的重复字符（SSE De-duplication），确保终端显示平滑。
- **🔍 智能路由与配额感应**：在发起请求前预检本地配额，自动绕过已满额的账号，零延迟切换。

---

## 🚀 快速部署

### 方式一：一键部署 (推荐)
点击顶部的 **[Deploy to Cloudflare Workers]** 蓝色按钮，按指引完成 KV 创建与环境变量配置即可。

### 方式二：手动部署
1.  **创建 KV 空间**：
    ```bash
    npx wrangler kv:namespace create AUTH_STORE
    ```
2.  **修改配置**：将生成的 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]]` 部分。
3.  **部署**：
    ```bash
    npm run deploy
    ```

---

## ⚙️ 环境变量配置

在部署页面或 Cloudflare Dashboard 设置以下变量：

| 变量名 | 是否必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **`API_KEY`** | **是** | 无 | **访问密码**。决定了 API 调用权限及管理面路径 `/<API_KEY>/ui`。 |
| **`LOG_LEVEL`** | 否 | `INFO` | 日志详细程度: `DEBUG`, `INFO`, `WARN`, `ERROR`。 |
| **`CHAT_DAILY_LIMIT`**| 否 | `2000` | 每个账号默认每日聊天额度。 |
| **`CHAT_RPM_LIMIT`** | 否 | `60` | 每个账号默认每分钟请求频率。 |
| **`MODEL_MAPPINGS`** | 否 | `{"research-model-v1": "coder-model"}` | 模型名称映射 (JSON 格式)。 |
| **`QWEN_CREDS_JSON`** | 否 | 无 | **自动播种**。可填入 `oauth_creds.json` 内容，首次启动自动写入 KV。 |

---

## 🖥️ 使用指引

1.  **管理后台**：访问 `https://<your-domain>/<API_KEY>/ui`。
2.  **添加账号**：在后台点击 `Add Account`，按提示扫码或登录授权即可。
3.  **API 调用**：
    - **Base URL**: `https://<your-domain>/v1`
    - **Headers**: `Authorization: Bearer <API_KEY>`
    - **Models**: `coder-model`, `vision-model` 或通过映射使用的自定义名。

---

## 🧪 开发与测试

```bash
# 安装依赖
npm install

# 本地模拟运行 (需要已配置好的 API_KEY)
npm run dev

# 运行全链路 E2E 测试 (Playwright)
npm run test:e2e
```

---

## 📂 目录结构说明

- `src/core/`: 核心逻辑 (KV存储、分布式锁、流处理器)。
- `src/providers/`: 模型适配器 (Qwen 认证与请求封装)。
- `src/routes/`: 路由模块 (Admin UI, Chat API, Tools)。
- `tests/e2e/`: 基于 Playwright 的自动化测试用例。