# AGENTS.md

## 项目定位

原生 HTML/CSS/JS + Node CommonJS/Vercel Functions 的 A 股研究看板；无构建步骤、无 `package.json`。

## 运行与验证

- 本地运行：`node agent-server.js`，默认监听 `127.0.0.1:8787`；可用 `AGENT_PORT` 覆盖端口。
- 访问 `http://localhost:8787/`；`file://` 不是完整运行方式，不支持行情和站点代理。
- 验证：`node test-finance-parser.js`、`node test-agent-server.js`、`node test-stock-api.js`。
- `test-stock-api.js` 是真实第三方数据的联网集成测试。
- `test-agent-server.js` 包含 DNS 校验，也可能受网络环境影响。

## 技术栈与目录

- `index.html`：页面结构和脚本入口。
- `src/`：浏览器应用、样式、本地数据和 LLM 调用逻辑。
- `agent-server.js`：CommonJS 本地 HTTP 服务及共享 API 实现。
- `api/`：Vercel Functions 入口，转发到共享请求处理器。
- `test-*.js`：解析器、服务边界和真实股票 API 测试。

## 关键约定

- IndexedDB：数据库 `yancetai-local-data`，对象仓库 `records`，键为 `stocks`、`stockInsights`、`dailyBrief`。
- LLM 配置（含 API Key）位于 localStorage 键 `yancetai.llmConfig.v1`。
- LLM 仅有三种模式：`auto`、`direct`、`proxy`；本地 `proxy` 由当前 Node 服务承载。
- JSON 备份必须保持 `format: "yancetai-backup"`、`version: 1`，导出时必须清空 `llmConfig.apiKey`。
- 当前没有面向用户的 CSV 功能，不要恢复或文档化旧 CSV 入口。
- Vercel 的 `/api/health`、`/api/llm`、`/api/stock` 由 `api/*.js` 承载；`/health` 重写到 `/api/health`。

## 安全与当前状态

- 不要削弱 SSRF 防护、请求/响应体上限、超时、缓存或限流边界。
- `ALLOW_PRIVATE_LLM_HOSTS` 是允许私有网络 LLM 地址的高风险显式开关。
- 环境 API Key 当前只影响 health 的服务端配置状态；`/api/llm` 仍要求请求体提供 API Key。
- 真实第三方行情、财务、公告和新闻的数据可用性必须联网验证。
