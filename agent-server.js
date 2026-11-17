const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const dns = require("node:dns/promises");
const net = require("node:net");

const PORT = Number(process.env.AGENT_PORT || 8787);
const PROVIDER = (process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY ? "openai" : "deepseek")).toLowerCase();

const PROVIDERS = {
  deepseek: {
    displayName: "DeepSeek",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    model: process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
    baseUrl: process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  },
  openai: {
    displayName: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
    model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
    baseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  }
};

const runtime = PROVIDERS[PROVIDER] || PROVIDERS.deepseek;
const MODEL = runtime.model || runtime.defaultModel;
const API_KEY = runtime.apiKey;
const LLM_BASE_URL = normalizeBaseUrl(runtime.baseUrl || runtime.defaultBaseUrl);
const PUBLIC_ROOT = __dirname;
const PUBLIC_BASE_PATH = normalizePublicBasePath(process.env.PUBLIC_BASE_PATH || "/StockAnalysis");
const BUILD_INFO = readBuildInfo();
const IS_VERCEL = Boolean(process.env.VERCEL);
const NEWS_TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS || (IS_VERCEL ? 3500 : 9000));
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || (IS_VERCEL ? 22000 : 45000));
const REMOTE_FETCH_TIMEOUT_MS = Number(process.env.REMOTE_FETCH_TIMEOUT_MS || (IS_VERCEL ? 4000 : 12000));
const SINGLE_FETCH_TIMEOUT_MS = Number(process.env.SINGLE_FETCH_TIMEOUT_MS || (IS_VERCEL ? 3500 : 8000));
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || (IS_VERCEL ? 1800 : 3200));
const REQUEST_BODY_MAX_BYTES = Number(process.env.REQUEST_BODY_MAX_BYTES || 1_000_000);
const REMOTE_RESPONSE_MAX_BYTES = Number(process.env.REMOTE_RESPONSE_MAX_BYTES || 5_000_000);
const LLM_RESPONSE_MAX_BYTES = Number(process.env.LLM_RESPONSE_MAX_BYTES || 2_000_000);
const STOCK_CACHE_TTL_MS = Number(process.env.STOCK_CACHE_TTL_MS || 15_000);
const STOCK_RATE_LIMIT_WINDOW_MS = Number(process.env.STOCK_RATE_LIMIT_WINDOW_MS || 60_000);
const STOCK_RATE_LIMIT_MAX = Number(process.env.STOCK_RATE_LIMIT_MAX || 30);
const BRIEF_CONTEXT_RATE_LIMIT_MAX = Number(process.env.BRIEF_CONTEXT_RATE_LIMIT_MAX || 6);
const LLM_RATE_LIMIT_MAX = Number(process.env.LLM_RATE_LIMIT_MAX || 20);
const ALLOW_PRIVATE_LLM_HOSTS = /^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_LLM_HOSTS || "");
const OFFICIAL_LLM_HOSTS = {
  deepseek: new Set(["api.deepseek.com"]),
  openai: new Set(["api.openai.com"])
};
const stockCache = new Map();
const stockInFlight = new Map();
const stockRateLimits = new Map();
const briefContextRateLimits = new Map();
const llmRateLimits = new Map();

class HttpError extends Error {
  constructor(statusCode, message, code = "") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createAgentServer() {
  return http.createServer(handleAgentRequest);
}

function normalizePublicBasePath(basePath) {
  const normalized = String(basePath || "").trim().replace(/^\/+|\/+$/g, "");
  return normalized ? `/${normalized}` : "";
}

// 发布信息由部署脚本写进构建目录根的 build-info.json，用来确认线上跑的是哪个 commit。
// 文件不存在时（本地运行、Vercel）返回空字段，健康接口本身照常可用。
function readBuildInfo() {
  try {
    const raw = require("node:fs").readFileSync(path.join(PUBLIC_ROOT, "build-info.json"), "utf8");
    const parsed = JSON.parse(raw);
    const pick = (value) => (typeof value === "string" ? value : "");
    return {
      commit: pick(parsed.commit).slice(0, 64),
      shortCommit: pick(parsed.shortCommit).slice(0, 40),
      release: pick(parsed.release).slice(0, 80),
      deployedAt: pick(parsed.deployedAt).slice(0, 40)
    };
  } catch {
    return { commit: "", shortCommit: "", release: "", deployedAt: "" };
  }
}

function normalizeRequestPath(url) {
  if (!PUBLIC_BASE_PATH || url.pathname === PUBLIC_BASE_PATH) return;
  if (url.pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    url.pathname = url.pathname.slice(PUBLIC_BASE_PATH.length) || "/";
  }
}

function isUpstreamFailure(error) {
  const message = String(error?.message || "");
  return error?.code === "UPSTREAM_FAILURE" || /真实行情获取失败|真实数据接口|真实行情接口|公开财务|历史K线|新闻抓取|公告获取|解禁获取|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED/i.test(message);
}

async function handleAgentRequest(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    normalizeRequestPath(url);

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
        sendJson(response, 200, {
          ok: true,
          browserConfigSupported: true,
          serverConfigured: Boolean(API_KEY),
          build: {
            commit: BUILD_INFO.commit,
            shortCommit: BUILD_INFO.shortCommit,
            release: BUILD_INFO.release,
            deployedAt: BUILD_INFO.deployedAt
          },
          defaults: {
            provider: PROVIDER,
            providerName: runtime.displayName,
            model: MODEL,
            baseUrl: LLM_BASE_URL,
            maxTokens: LLM_MAX_TOKENS
          }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/stock") {
        enforceStockRateLimit(request);
        const code = normalizeStockCode(url.searchParams.get("code") || "");
        const style = url.searchParams.get("style") || "短线观察";
        const stopLoss = Number(url.searchParams.get("stopLoss") || 0);
        const nameOverride = url.searchParams.get("name") || "";
        const stock = await getCachedStockData({ code, style, stopLoss, nameOverride });
        sendJson(response, 200, { stock });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/brief-context") {
        enforceBriefContextRateLimit(request);
        const body = await readJson(request);
        const externalContext = await buildDailyBriefContext(body.stocks);
        sendJson(response, 200, { externalContext });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/llm") {
        enforceLlmRateLimit(request);
        const body = await readJson(request);
        const { task, payload } = body;
        if (!isSupportedTask(task)) {
          throw new HttpError(400, `不支持的任务：${String(task || "")}`);
        }
        const llmConfig = await resolveLlmConfig(body.llmConfig);
        if (!llmConfig.apiKey) {
          throw new HttpError(400, "请先在页面的大模型配置中填写 API Key。");
        }

        const enrichedPayload = await enrichLlmPayload(task, payload);
        const messages = buildMessages(task, enrichedPayload);
        const completion = await callChatCompletions(messages, llmConfig, task);
        sendJson(response, 200, {
          text: completion.text,
          provider: llmConfig.displayName,
          model: llmConfig.model,
          latestNews: enrichedPayload?.latestNews || [],
          finishReason: completion.finishReason,
          usage: completion.usage
        });
        return;
      }

      if (await serveStaticRequest(request, response, url)) {
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : isUpstreamFailure(error) ? 502 : 500;
      sendJson(response, statusCode, { error: error.message || "服务处理失败。" });
    }
}

if (require.main === module) {
  const server = createAgentServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`研策台 Agent 服务已启动：http://localhost:${PORT}`);
    console.log("大模型配置：请在页面右上角配置，仅保存在当前浏览器。");
  });
}

module.exports = {
  createAgentServer,
  handleAgentRequest,
  buildMessages,
  _test: {
    extractFinanceFromResponse,
    buildEventSignals,
    classifyAnnouncementEvents,
    classifyFinanceEvents,
    classifyUnlockEvents,
    extractNewsRows,
    normalizeNewsRow,
    dedupeNewsItems,
    buildMessages,
    parseEastMoneyKlines,
    parseTencentKlines,
    historyBaselineBeforeQuote,
    isRelevantNewsItem,
    mergeQuote,
    mergeFinance,
    normalizeUnlockRow,
    quoteTimeValue,
    handsToShares,
    normalizeStockCode,
    normalizeBaseUrl,
    validateLlmBaseUrl,
    isBlockedIp,
    isSupportedTask
  }
};

const STOCK_ANALYSIS_STRATEGIES = {
  "短线观察": {
    focus: "以未来数个交易日至数周的量价结构、趋势延续性、波动和事件催化为核心，不用长期基本面掩盖短线风险。",
    sections: "策略结论、最新新闻/事件、趋势与量价、关键观察区间、短线风险、后续验证清单"
  },
  "长期观察": {
    focus: "以盈利质量、成长持续性、现金流、负债、估值背景和长期逻辑是否被证伪为核心，弱化单日涨跌的影响。",
    sections: "长期逻辑摘要、最新新闻/事件、经营质量与成长、财务与估值、长期风险与逻辑失效条件、后续跟踪清单"
  },
  "短线+长期": {
    focus: "分别评估短线交易结构与长期基本面，并明确两者一致、冲突或互不支持之处，不能混成一个结论。",
    sections: "双周期结论、最新新闻/事件、短线结构、长期质量、短长逻辑冲突、主要风险、分周期验证清单"
  },
  "风险观察": {
    focus: "风险优先，重点检查回撤、波动、止损距离、仓位暴露、趋势走弱、财务承压、公告事件和数据缺口。",
    sections: "风险结论、最新新闻/事件、市场与波动风险、持仓计划风险、财务与事件风险、风险升级条件、后续监测清单"
  },
  "等待确认": {
    focus: "不预设多空方向，重点列出已有证据、矛盾信号、缺失数据以及形成判断前必须确认的事实。",
    sections: "当前可确认状态、最新新闻/事件、支持因素、反向与矛盾因素、数据缺口、形成判断前的确认清单"
  }
};

function getStockAnalysisStrategy(payload) {
  const requested = payload?.analysisStrategy || payload?.stock?.style || "短线观察";
  return STOCK_ANALYSIS_STRATEGIES[requested] ? requested : "短线观察";
}

function buildMessages(task, payload) {
  const system = [
    "你是一个谨慎的A股研究辅助智能体。",
    "你只能做信息整理、风险提示、复盘追问和研究框架梳理。",
    "不要提供买入、卖出、目标价、仓位比例、收益承诺或确定性预测。",
    "遇到数据不足，要明确指出不足，不能编造公告、新闻、财报或实时行情。",
    "使用新闻时只引用输入上下文中给出的标题、日期、来源和摘要；不能把传闻当事实。",
    "输出用简体中文，结构清晰，适合个人收盘复盘。"
  ].join("\n");

  if (task === "config-test") {
    return [
      { role: "system", content: "你正在执行连接测试。" },
      { role: "user", content: "请只回复：配置验证成功" }
    ];
  }

  if (task === "stock-analysis") {
    const strategyName = getStockAnalysisStrategy(payload);
    const strategy = STOCK_ANALYSIS_STRATEGIES[strategyName];
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          `请基于下面这只A股的规则信号，生成一份“${strategyName}”策略个股分析报告。`,
          `策略重点：${strategy.focus}`,
          "要求：",
          `1. 严格按以下一级标题组织报告：${strategy.sections}。`,
          `2. 开头明确写“分析策略：${strategyName}”，所有结论必须符合该策略的观察周期和关注重点。`,
          "3. 每个判断尽量注明依据属于行情、技术指标、财务、新闻、公告、持仓计划或用户备注；证据不足时降级为待确认。",
          "4. 必须结合 latestNews 与 autoEvents；如果 latestNews 为空或抓取失败，要明确说‘未抓到可用最新新闻’，不能编造新闻。",
          "5. 引用新闻时写出日期、来源和标题，并说明它与当前策略有什么关系。",
          "6. 区分新闻、公告、财务摘要和本地行情规则，不要混为一谈。",
          "7. 不要给买卖建议，不要写目标价、建议仓位或收益预测；可以描述需要观察的客观价格区间和风险触发条件。",
          "8. 如果只是事件备注而非权威公告，要用‘备注显示’而不是断言事实。",
          "9. 结论应简洁、可复盘，避免通用套话。",
          "",
          JSON.stringify(payload, null, 2)
        ].join("\n")
      }
    ];
  }

  if (task === "daily-brief") {
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          "请基于下面的自选股规则简报，生成一份收盘复盘摘要。",
          "要求：",
          "1. 全文控制在1000字以内，优先输出关键信息，避免重复数据和套话。",
          "2. 先列最需要关注的风险，再列可继续观察的机会。",
          "3. 区分短线信号和长期逻辑。",
          "4. 必须结合 externalContext 中即时补充的外部行情、新闻、公告事件和财务摘要；引用时标明股票、日期和来源。",
          "5. externalContext 中缺失或获取失败的信息必须明确说明，不能编造或把用户备注当成正式公告。",
          "6. 最后给出3个复盘问题。",
          "7. 不要给买卖建议，不要写目标价。",
          "",
          JSON.stringify(payload)
        ].join("\n")
      }
    ];
  }

  throw new Error(`Unsupported task: ${task}`);
}

async function enrichLlmPayload(task, payload) {
  if (task !== "stock-analysis") return payload;
  const code = normalizeStockCode(payload?.stock?.code || payload?.code || "");
  const name = payload?.stock?.name || payload?.name || "";
  try {
    const latestNews = await withTimeout(
      (signal) => fetchLatestStockNewsWithFallback({ code, name }, signal),
      NEWS_TIMEOUT_MS,
      "最新新闻抓取超时"
    );
    return {
      ...payload,
      latestNews: latestNews.items,
      latestNewsMeta: {
        fetchedAt: latestNews.fetchedAt,
        status: latestNews.status,
        source: latestNews.source,
        sourceUrls: latestNews.sourceUrls,
        errors: latestNews.errors
      }
    };
  } catch (error) {
    return {
      ...payload,
      latestNews: [],
      latestNewsMeta: {
        fetchedAt: new Date().toISOString(),
        status: "missing",
        source: "",
        sourceUrls: [],
        errors: [error.message || "最新新闻抓取失败"]
      }
    };
  }
}

async function buildDailyBriefContext(inputStocks) {
  if (!Array.isArray(inputStocks) || inputStocks.length === 0) {
    throw new HttpError(400, "请至少提供一只股票。 ");
  }
  if (inputStocks.length > 8) {
    throw new HttpError(400, "每次最多补充8只股票。 ");
  }
  const stocks = inputStocks.map((stock) => ({
    code: normalizeStockCode(stock?.code || ""),
    name: String(stock?.name || "").trim().slice(0, 40),
    style: String(stock?.style || "短线观察").trim().slice(0, 20)
  }));
  const results = await mapWithConcurrency(stocks, 3, async (stock) => {
    const code = normalizeStockCode(stock.code || "");
    if (!code) return { code: stock.code || "", name: stock.name || "", status: "missing", error: "股票代码无效" };
    try {
      const [fresh, news] = await Promise.all([
        withTimeout(
          () => getCachedStockData({
            code,
            style: stock.style || "短线观察",
            stopLoss: Number(stock.stopLoss || 0),
            nameOverride: stock.name || ""
          }),
          Math.max(REMOTE_FETCH_TIMEOUT_MS, SINGLE_FETCH_TIMEOUT_MS) + 2500,
          `${code} 行情和财务补充超时`
        ),
        withTimeout(
          (signal) => fetchLatestStockNewsWithFallback({ code, name: stock.name || "" }, signal),
          NEWS_TIMEOUT_MS,
          `${code} 新闻和公告补充超时`
        ).catch((error) => ({ items: [], status: "missing", source: "", sourceUrls: [], errors: [error.message] }))
      ]);
      return {
        code: fresh.code,
        name: fresh.name,
        status: "ok",
        fetchedAt: fresh.dataSource?.fetchedAt || "",
        market: {
          price: fresh.close,
          changePct: fresh.changePct,
          volumeRatio: firstNumber(volumeRatioOf(fresh), fresh.quoteVolumeRatio, null),
          tradeTime: fresh.tradeTime,
          ma5: fresh.ma5,
          ma10: fresh.ma10,
          ma20: fresh.ma20,
          high20: fresh.high20,
          low20: fresh.low20,
          change20d: fresh.change20d,
          change60d: fresh.change60d,
          volatility20: fresh.volatility20,
          pe: fresh.pe,
          pb: fresh.pb,
          marketCap: fresh.marketCap
        },
        finance: {
          reportDate: fresh.financeReportDate,
          roe: fresh.roe,
          revenueYoY: fresh.revenueYoY,
          profitYoY: fresh.profitYoY,
          debtRatio: fresh.debtRatio,
          grossMargin: fresh.grossMargin,
          netMargin: fresh.netMargin,
          revenue: fresh.revenue,
          netProfit: fresh.netProfit
        },
        latestNewsAndAnnouncements: (news.items || []).slice(0, 3).map((item) => ({
          date: item.date || item.publishTime || "",
          source: item.source || "",
          title: item.title || ""
        })),
        newsStatus: news.status,
        announcementsAndEvents: (fresh.autoEvents || []).slice(0, 4),
        sourceStatus: fresh.dataStatus || {}
      };
    } catch (error) {
      return { code, name: stock.name || "", status: "missing", error: error.message || "外部信息获取失败" };
    }
  });

  return {
    fetchedAt: new Date().toISOString(),
    coverage: `${results.filter((item) => item.status === "ok").length}/${results.length}`,
    note: "以下为生成简报时即时补充的外部行情、公告事件和财务摘要；缺失项不得编造。",
    stocks: results
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function withTimeout(operation, ms, message, parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  return Promise.resolve()
    .then(() => typeof operation === "function" ? operation(controller.signal) : operation)
    .catch((error) => {
      if (controller.signal.aborted && !parentSignal?.aborted) throw new HttpError(504, message, "UPSTREAM_TIMEOUT");
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    });
}

function isSupportedTask(task) {
  return task === "config-test" || task === "stock-analysis" || task === "daily-brief";
}

async function resolveLlmConfig(input = {}) {
  const provider = String(input.provider || PROVIDER).trim().toLowerCase();
  const providerDefaults = PROVIDERS[provider] || runtime;
  const maxTokens = Number(input.maxTokens || LLM_MAX_TOKENS);
  const baseUrl = normalizeBaseUrl(input.baseUrl || providerDefaults.baseUrl || providerDefaults.defaultBaseUrl || LLM_BASE_URL);
  await validateLlmBaseUrl(baseUrl, provider);
  return {
    provider,
    displayName: String(input.providerName || providerDefaults.displayName || provider || "自定义模型").trim(),
    apiKey: String(input.apiKey || "").trim(),
    model: String(input.model || providerDefaults.model || providerDefaults.defaultModel || MODEL).trim(),
    baseUrl,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(Math.max(maxTokens, 256), 16000) : LLM_MAX_TOKENS
  };
}

async function callChatCompletions(messages, config, task = "") {
  const endpoint = new URL(`${config.baseUrl}/chat/completions`);
  const body = {
    model: config.model,
    messages,
    temperature: 0.3,
    max_tokens: config.maxTokens
  };
  // 连接测试只需要确认能否连通；DeepSeek 思考模式默认开启，会把 max_tokens 花在思维链上。
  if (task === "config-test" && config.provider === "deepseek") body.thinking = { type: "disabled" };
  const data = await fetchJsonWithPolicy(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, {
    timeoutMs: LLM_TIMEOUT_MS,
    maxBytes: LLM_RESPONSE_MAX_BYTES,
    validateUrl: (url) => validateLlmBaseUrl(url.origin, config.provider),
    timeoutMessage: `${config.displayName} 请求超时。`,
    failureMessage: `${config.displayName} 请求失败`
  });

  const choice = data.choices?.[0] || {};
  return {
    text: choice.message?.content?.trim() || "",
    finishReason: choice.finish_reason || "",
    usage: data.usage || null
  };
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "大模型 Base URL 无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "大模型 Base URL 仅支持 http 或 https。");
  }
  if (url.username || url.password) throw new HttpError(400, "大模型 Base URL 不允许包含用户凭据。");
  if (url.search || url.hash) throw new HttpError(400, "大模型 Base URL 不允许包含查询参数或片段。");
  return url.toString().replace(/\/+$/, "");
}

async function validateLlmBaseUrl(value, provider = "custom") {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new HttpError(400, "大模型 Base URL 无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "大模型 Base URL 仅支持 http 或 https。");
  }
  if (url.username || url.password) throw new HttpError(400, "大模型 Base URL 不允许包含用户凭据。");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new HttpError(400, "大模型 Base URL 缺少主机名。");
  if (OFFICIAL_LLM_HOSTS[provider]?.has(hostname)) return true;
  if (ALLOW_PRIVATE_LLM_HOSTS) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
    throw new HttpError(400, "大模型 Base URL 不允许指向本机、私网或云元数据地址。");
  }
  const literal = stripIpv6Brackets(hostname);
  if (net.isIP(literal)) {
    if (isBlockedIp(literal)) throw new HttpError(400, "大模型 Base URL 不允许指向本机、私网或云元数据地址。");
    return true;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(400, "大模型 Base URL 的主机名无法解析。");
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new HttpError(400, "大模型 Base URL 的 DNS 解析结果包含本机、私网或云元数据地址。");
  }
  return true;
}

function stripIpv6Brackets(value) {
  return String(value || "").replace(/^\[|\]$/g, "");
}

function isBlockedIp(address) {
  const value = stripIpv6Brackets(address).toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (!net.isIPv6(value)) return true;
  if (value === "::" || value === "::1") return true;
  const mapped = value.match(/^::ffff:(.+)$/);
  if (mapped) {
    if (net.isIPv4(mapped[1])) return isBlockedIp(mapped[1]);
    const parts = mapped[1].split(":").map((part) => parseInt(part, 16));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return isBlockedIp(`${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`);
    }
    return true;
  }
  if (value.startsWith("64:ff9b:") || value.startsWith("2001:db8:")) return true;
  const first = parseInt(value.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

async function fetchJsonWithPolicy(url, options = {}, policy = {}) {
  const text = await fetchTextWithPolicy(url, options, policy);
  try {
    return parseJsonText(text);
  } catch {
    throw new HttpError(502, `${policy.failureMessage || "上游接口"}返回了无法解析的数据。`, "UPSTREAM_FAILURE");
  }
}

async function fetchTextWithPolicy(url, options = {}, policy = {}, parentSignal) {
  const buffer = await fetchBufferWithPolicy(url, options, policy, parentSignal);
  return new TextDecoder().decode(buffer);
}

async function fetchBufferWithPolicy(url, options = {}, policy = {}, parentSignal) {
  const timeoutMs = Number(policy.timeoutMs || REMOTE_FETCH_TIMEOUT_MS);
  const maxBytes = Number(policy.maxBytes || REMOTE_RESPONSE_MAX_BYTES);
  return withTimeout(async (signal) => {
    let currentUrl = url instanceof URL ? new URL(url) : new URL(url);
    let requestOptions = { ...options };
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (policy.validateUrl) await policy.validateUrl(currentUrl);
      let response;
      try {
        response = await fetch(currentUrl, { ...requestOptions, redirect: "manual", signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new HttpError(502, `${policy.failureMessage || "上游接口"}调用失败：${error.message}`, "UPSTREAM_FAILURE");
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        if (redirects === 3) throw new HttpError(502, `${policy.failureMessage || "上游接口"}重定向次数过多。`, "UPSTREAM_FAILURE");
        currentUrl = new URL(response.headers.get("location"), currentUrl);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestOptions.method === "POST")) {
          requestOptions = { ...requestOptions, method: "GET", body: undefined };
        }
        continue;
      }
      const buffer = await readResponseBuffer(response, maxBytes, signal);
      if (!response.ok) {
        const text = new TextDecoder().decode(buffer);
        let detail = "";
        try {
          detail = parseJsonText(text).error?.message || "";
        } catch {
          // 上游返回的错误页多为 HTML，直接截取会把整段标签显示到“数据来源”面板里。
          detail = stripHtml(text).replace(/\s+/g, " ").trim().slice(0, 160);
        }
        throw new HttpError(502, detail || `${policy.failureMessage || "上游接口"}：HTTP ${response.status}`, "UPSTREAM_FAILURE");
      }
      return buffer;
    }
    throw new HttpError(502, `${policy.failureMessage || "上游接口"}重定向失败。`, "UPSTREAM_FAILURE");
  }, timeoutMs, policy.timeoutMessage || "上游接口请求超时", parentSignal);
}

async function readResponseBuffer(response, maxBytes, signal) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error("Aborted");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(502, "上游响应体过大。", "UPSTREAM_FAILURE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function getClientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket?.remoteAddress || "unknown";
}

function enforceRateLimit(request, store, maxRequests) {
  const now = Date.now();
  const ip = getClientIp(request);
  const current = store.get(ip);
  if (!current || now - current.startedAt >= STOCK_RATE_LIMIT_WINDOW_MS) {
    store.set(ip, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > maxRequests) throw new HttpError(429, "请求过于频繁，请稍后再试。");
  }
  if (store.size > 1000) {
    for (const [key, value] of store) {
      if (now - value.startedAt >= STOCK_RATE_LIMIT_WINDOW_MS) store.delete(key);
    }
  }
}

function enforceStockRateLimit(request) {
  enforceRateLimit(request, stockRateLimits, STOCK_RATE_LIMIT_MAX);
}

function enforceBriefContextRateLimit(request) {
  enforceRateLimit(request, briefContextRateLimits, BRIEF_CONTEXT_RATE_LIMIT_MAX);
}

function enforceLlmRateLimit(request) {
  enforceRateLimit(request, llmRateLimits, LLM_RATE_LIMIT_MAX);
}

function stockRequestKey({ code, style, stopLoss, nameOverride }) {
  return JSON.stringify([code, style || "短线观察", Number.isFinite(stopLoss) ? stopLoss : 0, String(nameOverride || "").trim()]);
}

async function getCachedStockData(input) {
  const key = stockRequestKey(input);
  const cached = stockCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) stockCache.delete(key);
  if (stockInFlight.has(key)) return stockInFlight.get(key);
  const pending = fetchRealStockData(input)
    .then((stock) => {
      stockCache.set(key, { value: stock, expiresAt: Date.now() + STOCK_CACHE_TTL_MS });
      return stock;
    })
    .finally(() => stockInFlight.delete(key));
  stockInFlight.set(key, pending);
  return pending;
}

async function fetchRealStockData({ code, style, stopLoss, nameOverride }) {
  const normalizedCode = normalizeStockCode(code);
  const secid = toEastMoneySecid(normalizedCode);
  const fetchedAt = new Date().toISOString();

  const [quote, historyResult, finance, disclosureEvents] = await Promise.all([
    fetchQuoteWithFallback(normalizedCode, secid),
    fetchHistoryWithFallback(normalizedCode, secid).catch((error) => ({
      items: [],
      source: `历史K线未获取：${error.message}`,
      sourceUrl: "",
      errors: [error.message]
    })),
    fetchFinanceWithFallback(normalizedCode).catch((error) => ({
      source: "",
      sourceUrls: [],
      errors: [error.message],
      error: error.message
    })),
    fetchDisclosureEventsWithFallback(normalizedCode).catch((error) => ({
      announcements: [],
      unlocks: [],
      source: "",
      sourceUrls: [],
      errors: [error.message],
      status: "missing"
    }))
  ]);

  const history = historyResult.items;
  const historySource = historyResult.source;
  const historySourceUrl = historyResult.sourceUrl || "";
  const historyError = Array.isArray(historyResult.errors) ? historyResult.errors.join("；") : "";
  const eventSignals = buildEventSignals(disclosureEvents, { ...finance, sector: quote.sector || finance.sector || "" });
  const hasFinance = hasAnyFinanceField(finance);
  const baselineHistory = historyBaselineBeforeQuote(history, quote.tradeTime);
  const recent = baselineHistory.slice(-20);
  const recent60 = baselineHistory.slice(-60);
  const closes = history.map((item) => item.close);
  const volumes = history.map((item) => item.volume);
  const amounts = history.map((item) => item.amount);
  const turnoverRates = history.map((item) => item.turnoverRate);
  const close = firstNumber(quote.close, closes.at(-1), null);
  const prevClose = firstNumber(quote.prevClose, history.at(-2)?.close, close);
  const volume = firstNumber(quote.volume, volumes.at(-1), null);
  const open = firstNumber(quote.open, history.at(-1)?.open, null);
  const high = firstNumber(quote.high, history.at(-1)?.high, null);
  const low = firstNumber(quote.low, history.at(-1)?.low, null);
  const amount = firstNumber(quote.amount, amounts.at(-1), null);
  const turnoverRate = firstNumber(quote.turnoverRate, turnoverRates.at(-1), null);
  const changeAmount = firstNumber(quote.changeAmount, priceChange(close, prevClose), history.at(-1)?.changeAmount, null);
  const changePct = firstNumber(quote.changePct, priceChangePct(close, prevClose), history.at(-1)?.changePct, null);
  const amplitude = firstNumber(quote.amplitude, history.at(-1)?.amplitude, null);
  const hasHistory = history.length >= 20;
  const hasHistory60 = history.length >= 60;
  const hasBaseline20 = baselineHistory.length >= 20;
  const hasBaseline60 = baselineHistory.length >= 60;
  const avgVolume20 = hasBaseline20 ? average(recent.map((item) => item.volume)) : null;
  const avgVolume60 = hasBaseline60 ? average(recent60.map((item) => item.volume)) : null;
  const avgAmount20 = hasBaseline20 ? average(recent.map((item) => item.amount)) : null;
  const avgAmount60 = hasBaseline60 ? average(recent60.map((item) => item.amount)) : null;
  const avgTurnover20 = hasBaseline20 ? average(recent.map((item) => item.turnoverRate)) : null;
  const avgTurnover60 = hasBaseline60 ? average(recent60.map((item) => item.turnoverRate)) : null;
  const ma5 = history.length >= 5 ? movingAverage(closes, 5) : null;
  const ma10 = history.length >= 10 ? movingAverage(closes, 10) : null;
  const ma20 = hasHistory ? movingAverage(closes, 20) : null;
  const ma60 = hasHistory60 ? movingAverage(closes, 60) : null;
  const high20 = hasBaseline20 ? Math.max(...recent.map((item) => item.high)) : null;
  const low20 = hasBaseline20 ? Math.min(...recent.map((item) => item.low)) : null;
  const high60 = hasBaseline60 ? Math.max(...recent60.map((item) => item.high)) : null;
  const low60 = hasBaseline60 ? Math.min(...recent60.map((item) => item.low)) : null;
  const change5d = periodChange(closes, 5);
  const change20d = periodChange(closes, 20);
  const change60d = periodChange(closes, 60);
  const volatility20 = volatility(closes, 20);
  const volatility60 = volatility(closes, 60);
  const maxDrawdown60 = maxDrawdown(closes.slice(-60));
  return {
    code: normalizedCode,
    name: nameOverride.trim() || quote.name || normalizedCode,
    sector: quote.sector || finance.sector || "待补充",
    style: style || "短线观察",
    open,
    high,
    low,
    close,
    prevClose,
    changeAmount,
    changePct,
    amplitude,
    tradeTime: quote.tradeTime || "",
    volume,
    amount,
    turnoverRate,
    quoteVolumeRatio: firstNumber(quote.volumeRatio, null),
    avgVolume20,
    avgVolume60,
    avgAmount20,
    avgAmount60,
    avgTurnover20,
    avgTurnover60,
    ma5,
    ma10,
    ma20,
    ma60,
    high20,
    low20,
    high60,
    low60,
    change5d,
    change20d,
    change60d,
    volatility20,
    volatility60,
    maxDrawdown60,
    pe: firstNumber(quote.pe, finance.pe, null),
    peStatic: firstNumber(quote.peStatic, finance.peStatic, null),
    pb: firstNumber(quote.pb, finance.pb, null),
    marketCap: firstNumber(quote.marketCap, null),
    floatMarketCap: firstNumber(quote.floatMarketCap, null),
    totalShares: firstNumber(quote.totalShares, null),
    floatShares: firstNumber(quote.floatShares, null),
    roe: firstNumber(finance.roe, null),
    revenueYoY: firstNumber(finance.revenueYoY, null),
    profitYoY: firstNumber(finance.profitYoY, null),
    debtRatio: firstNumber(finance.debtRatio, null),
    grossMargin: firstNumber(finance.grossMargin, null),
    netMargin: firstNumber(finance.netMargin, null),
    eps: firstNumber(finance.eps, null),
    bps: firstNumber(finance.bps, null),
    cashFlowPerShare: firstNumber(finance.cashFlowPerShare, null),
    revenue: firstNumber(finance.revenue, null),
    netProfit: firstNumber(finance.netProfit, null),
    financeReportDate: finance.reportDate || "",
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : 0,
    event: "",
    autoEvents: eventSignals.items,
    dataStatus: {
      quote: isFiniteNumber(close) && isFiniteNumber(prevClose) ? "ok" : isUsableQuote(quote) ? "partial" : "missing",
      history: hasHistory ? "ok" : "missing",
      finance: hasFinance ? "ok" : "missing",
      events: eventSignals.status
    },
    dataSource: {
      fetchedAt,
      quote: quote.source || "公开行情接口",
      quoteUrl: (quote.sourceUrls || [quote.sourceUrl]).filter(Boolean).join("\n"),
      quoteError: Array.isArray(quote.errors) ? quote.errors.join("；") : quote.error || "",
      history: hasHistory ? historySource : "",
      historyUrl: hasHistory ? historySourceUrl : "",
      historyError,
      finance: hasFinance ? finance.source : "",
      financeUrls: hasFinance ? finance.sourceUrls || [] : [],
      financeError: (finance.errors || []).join("；") || finance.error || "",
      events: eventSignals.source,
      eventUrls: eventSignals.sourceUrls,
      eventsError: eventSignals.error,
      calculation: "本地规则根据行情和K线计算",
      fieldGroups: {
        quote: ["open", "high", "low", "close", "prevClose", "changeAmount", "changePct", "amplitude", "volume", "amount", "turnoverRate", "quoteVolumeRatio", "pe", "peStatic", "pb", "marketCap", "floatMarketCap", "totalShares", "floatShares"],
        history: ["avgVolume20", "avgVolume60", "avgAmount20", "avgAmount60", "avgTurnover20", "avgTurnover60", "ma5", "ma10", "ma20", "ma60", "high20", "low20", "high60", "low60"],
        derived: ["change5d", "change20d", "change60d", "volatility20", "volatility60", "maxDrawdown60", "volumeRatio", "shortTrend", "riskLevel", "qualityLevel"],
        finance: ["roe", "revenueYoY", "profitYoY", "debtRatio", "grossMargin", "netMargin", "eps", "bps", "cashFlowPerShare", "revenue", "netProfit", "financeReportDate"],
        events: ["autoEvents"]
      }
    }
  };
}

function normalizeStockCode(code) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new HttpError(400, "请输入6位A股代码，例如 600519 或 300750。");
  }
  return normalized;
}

function toEastMoneySecid(code) {
  const market = code.startsWith("6") || code.startsWith("9") ? "1" : "0";
  return `${market}.${code}`;
}

function toEastMoneyFullCode(code) {
  return `${code.startsWith("6") || code.startsWith("9") ? "SH" : "SZ"}${code}`;
}

function toTencentSymbol(code) {
  return `${code.startsWith("6") || code.startsWith("9") ? "sh" : "sz"}${code}`;
}

function historyBaselineBeforeQuote(history, tradeTime) {
  if (!history.length) return history;
  const quoteDate = normalizeEventDate(tradeTime);
  const latestDate = normalizeEventDate(history.at(-1)?.date);
  if (quoteDate && latestDate === quoteDate) return history.slice(0, -1);
  return history;
}

async function fetchQuoteWithFallback(code, secid) {
  const attempts = [
    { name: "东方财富", fetcher: (signal) => fetchEastMoneyQuote(secid, signal) },
    { name: "腾讯", fetcher: (signal) => fetchTencentQuote(code, signal) },
    { name: "新浪", fetcher: (signal) => fetchSinaQuote(code, signal) }
  ];
  const errors = [];
  const results = await Promise.all(
    attempts.map((attempt) =>
      withTimeout((signal) => attempt.fetcher(signal), SINGLE_FETCH_TIMEOUT_MS, `${attempt.name}超时`)
        .catch((error) => {
          errors.push(`${attempt.name}：${error.message}`);
          return null;
        })
    )
  );

  let merged = {};
  for (const quote of results) {
    if (quote && isUsableQuote(quote)) {
      merged = mergeQuote(merged, quote);
    }
  }

  if (isUsableQuote(merged)) {
    return { ...merged, errors };
  }

  throw new Error(`真实行情获取失败。${errors.join("；")}`);
}

async function fetchTencentQuote(code, signal) {
  const symbol = toTencentSymbol(code);
  const url = `https://qt.gtimg.cn/q=${symbol}`;
  const text = await fetchTextRemote(url, {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://gu.qq.com/"
  }, "gb18030", signal);
  const match = text.match(/="(.*)"/);
  if (!match || !match[1]) throw new Error("没有查询到该股票的腾讯行情。");
  const cells = match[1].split("~");
  if (cells.length < 50 || !cells[1]) throw new Error("腾讯行情返回为空。");
  const volumeHands = toFiniteNumber(cells[6]);
  const amountWan = toFiniteNumber(cells[37]);
  const floatMarketCapYi = toFiniteNumber(cells[44]);
  const marketCapYi = toFiniteNumber(cells[45]);

  return {
    code,
    name: cells[1],
    close: toFiniteNumber(cells[3]),
    prevClose: toFiniteNumber(cells[4]),
    open: toFiniteNumber(cells[5]),
    volume: handsToShares(volumeHands),
    high: toFiniteNumber(cells[33]),
    low: toFiniteNumber(cells[34]),
    amount: isFiniteNumber(amountWan) ? amountWan * 10000 : null,
    turnoverRate: toFiniteNumber(cells[38]),
    pe: toFiniteNumber(cells[39]),
    pb: toFiniteNumber(cells[46]),
    changeAmount: toFiniteNumber(cells[31]),
    changePct: toFiniteNumber(cells[32]),
    marketCap: isFiniteNumber(marketCapYi) ? marketCapYi * 100000000 : null,
    floatMarketCap: isFiniteNumber(floatMarketCapYi) ? floatMarketCapYi * 100000000 : null,
    tradeTime: cells[30] || "",
    source: "腾讯证券实时行情",
    sourceUrl: url
  };
}

async function fetchEastMoneyQuote(secid, signal) {
  const fields = [
    "f43",
    "f44",
    "f45",
    "f46",
    "f47",
    "f48",
    "f50",
    "f57",
    "f58",
    "f60",
    "f100",
    "f127",
    "f128",
    "f84",
    "f85",
    "f116",
    "f117",
    "f162",
    "f163",
    "f167",
    "f169",
    "f170",
    "f171",
    "f168",
    "f86"
  ].join(",");
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${fields}`;
  const data = await fetchJsonRemote(url, {}, signal);
  const item = data.data;
  if (!item) throw new Error("没有查询到该股票的真实行情。请确认代码是否正确。");

  return {
    code: item.f57,
    name: item.f58,
    close: eastMoneyNumber(item.f43, 100),
    high: eastMoneyNumber(item.f44, 100),
    low: eastMoneyNumber(item.f45, 100),
    open: eastMoneyNumber(item.f46, 100),
    volume: handsToShares(eastMoneyNumber(item.f47, 1)),
    amount: eastMoneyNumber(item.f48, 1),
    volumeRatio: eastMoneyNumber(item.f50, 100),
    prevClose: eastMoneyNumber(item.f60, 100),
    changeAmount: eastMoneyNumber(item.f169, 100),
    changePct: eastMoneyNumber(item.f170, 100),
    amplitude: eastMoneyNumber(item.f171, 100),
    turnoverRate: eastMoneyNumber(item.f168, 100),
    pe: eastMoneyNumber(item.f162, 100),
    peStatic: eastMoneyNumber(item.f163, 100),
    pb: eastMoneyNumber(item.f167, 100),
    totalShares: eastMoneyNumber(item.f84, 1),
    floatShares: eastMoneyNumber(item.f85, 1),
    marketCap: eastMoneyNumber(item.f116, 1),
    floatMarketCap: eastMoneyNumber(item.f117, 1),
    sector: item.f100 || item.f127 || item.f128 || "待补充",
    tradeTime: formatEastMoneyTradeTime(item.f86),
    source: "东方财富实时行情",
    sourceUrl: url
  };
}

async function fetchHistoryWithFallback(code, secid) {
  const attempts = [
    { name: "东方财富", fetcher: (signal) => fetchEastMoneyHistory(secid, signal) },
    { name: "腾讯", fetcher: (signal) => fetchTencentHistory(code, signal) }
  ];
  const errors = [];
  const results = await Promise.all(
    attempts.map((attempt) =>
      withTimeout((signal) => attempt.fetcher(signal), SINGLE_FETCH_TIMEOUT_MS * 1.5, `${attempt.name}历史K线超时`)
        .catch((error) => {
          errors.push(`${attempt.name}：${error.message}`);
          return null;
        })
    )
  );

  let best = { items: [], source: "", sourceUrl: "" };
  for (const result of results) {
    if (!result) continue;
    const items = Array.isArray(result.items) ? result.items : [];
    if (isBetterHistoryResult(items, best.items)) best = { ...result, items };
    if (items.length < 60) errors.push(`${result.source}历史K线仅${items.length}条`);
  }

  if (best.items.length) return { ...best, errors };
  throw new Error(errors.join("；") || "历史K线为空");
}

/**
 * 腾讯K线不带成交额与换手率，只按条数挑来源会让“20日均额/均换手”永远为空。
 * 因此优先选择同时带成交额和换手率的结果（且至少 60 条），其次才比较条数。
 */
function historyRichness(items) {
  const hasAmount = items.some((item) => isFiniteNumber(item.amount));
  const hasTurnover = items.some((item) => isFiniteNumber(item.turnoverRate));
  return (hasAmount ? 1 : 0) + (hasTurnover ? 1 : 0);
}

function isBetterHistoryResult(candidateItems, bestItems) {
  const candidateRich = candidateItems.length >= 60 ? historyRichness(candidateItems) : -1;
  const bestRich = bestItems.length >= 60 ? historyRichness(bestItems) : -1;
  if (candidateRich !== bestRich) return candidateRich > bestRich;
  return candidateItems.length > bestItems.length;
}

async function fetchEastMoneyHistory(secid, signal) {
  const attempts = [
    { fqt: 1, label: "东方财富前复权历史K线" },
    { fqt: 0, label: "东方财富不复权历史K线" },
    { fqt: 2, label: "东方财富后复权历史K线" }
  ];
  const errors = [];
  let best = { items: [], source: "" };

  for (const attempt of attempts) {
    try {
      // 东方财富K线接口仅带 lmt 时会返回 rc:102 与空数据，必须同时给出 end 参数。
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=101&fqt=${attempt.fqt}&lmt=120&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
      const data = await fetchJsonRemote(url, {}, signal);
      const items = parseEastMoneyKlines(data.data?.klines || []);
      if (items.length > best.items.length) best = { items, source: attempt.label, sourceUrl: url };
      if (items.length >= 20) return { items, source: attempt.label, sourceUrl: url };
      errors.push(`${attempt.label}仅${items.length}条`);
    } catch (error) {
      errors.push(`${attempt.label}：${error.message}`);
    }
  }

  if (best.items.length) return best;
  throw new Error(errors.join("；") || "历史K线为空");
}

function parseEastMoneyKlines(klines) {
  return klines
    .map((line) => {
      const [date, open, close, high, low, volume, amount, amplitude, changePct, changeAmount, turnoverRate] = String(line).split(",");
      return {
        date,
        open: toFiniteNumber(open),
        close: toFiniteNumber(close),
        high: toFiniteNumber(high),
        low: toFiniteNumber(low),
        volume: handsToShares(toFiniteNumber(volume)),
        amount: toFiniteNumber(amount),
        amplitude: toFiniteNumber(amplitude),
        changePct: toFiniteNumber(changePct),
        changeAmount: toFiniteNumber(changeAmount),
        turnoverRate: toFiniteNumber(turnoverRate)
      };
    })
    .filter((item) => [item.open, item.close, item.high, item.low, item.volume].every(isFiniteNumber));
}

async function fetchTencentHistory(code, signal) {
  const symbol = toTencentSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,120,qfq`;
  const data = await fetchJsonRemote(url, { Referer: "https://gu.qq.com/" }, signal);
  const node = data.data?.[symbol] || data.data?.[code] || {};
  const rows = node.qfqday || node.day || node.hfqday || [];
  const items = parseTencentKlines(rows);
  if (!items.length) throw new Error("腾讯历史K线为空。");
  return { items, source: "腾讯证券历史K线", sourceUrl: url };
}

function parseTencentKlines(rows) {
  return rows
    .map((row) => {
      const cells = Array.isArray(row) ? row : String(row).split(",");
      const [date, open, close, high, low, volume, amount] = cells;
      return {
        date: String(date || ""),
        open: toFiniteNumber(open),
        close: toFiniteNumber(close),
        high: toFiniteNumber(high),
        low: toFiniteNumber(low),
        volume: handsToShares(toFiniteNumber(volume)),
        amount: toFiniteNumber(amount),
        amplitude: null,
        changePct: null,
        changeAmount: null,
        turnoverRate: null
      };
    })
    .filter((item) => [item.open, item.close, item.high, item.low, item.volume].every(isFiniteNumber));
}

async function fetchLatestStockNewsWithFallback({ code, name }, signal) {
  const errors = [];
  const sourceUrls = [];
  const sources = [];
  let items = [];
  const normalizedCode = normalizeStockCode(code);

  const attempts = [
    {
      name: "东方财富资讯搜索",
      fetcher: () => fetchEastMoneySearchNews(normalizedCode, name, signal)
    }
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt.fetcher();
      if (result.items.length) {
        items = items.concat(result.items);
        sources.push(result.source);
        sourceUrls.push(result.sourceUrl);
      } else {
        errors.push(`${attempt.name}：未返回可用新闻`);
      }
    } catch (error) {
      errors.push(`${attempt.name}：${error.message}`);
    }
  }

  try {
    const disclosure = await fetchDisclosureEventsWithFallback(normalizedCode, signal);
    const announcementNews = (disclosure.announcements || [])
      .map((item) => ({
        title: item.title,
        date: item.date,
        source: item.source || "东方财富公告",
        url: item.url || "",
        summary: "公开公告标题，需以公告正文为准。",
        relevanceTrusted: true
      }))
      .filter((item) => item.title)
      .slice(0, 8);
    if (announcementNews.length) {
      items = items.concat(announcementNews);
      sources.push(disclosure.source || "东方财富公告");
      sourceUrls.push(...(disclosure.sourceUrls || []));
    }
  } catch (error) {
    errors.push(`公告补充：${error.message}`);
  }

  const filtered = dedupeNewsItems(items)
    .filter((item) => isRelevantNewsItem(item, normalizedCode, name))
    .filter((item) => !isOldEventDate(item.date, 45))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 12);

  return {
    items: filtered,
    fetchedAt: new Date().toISOString(),
    status: filtered.length ? "ok" : "missing",
    source: [...new Set(sources.filter(Boolean))].join(" + "),
    sourceUrls: [...new Set(sourceUrls.filter(Boolean))],
    errors
  };
}

async function fetchEastMoneySearchNews(code, name, signal) {
  const keyword = name || code;
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery&param=${encodeURIComponent(JSON.stringify({
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "default", pageIndex: 1, pageSize: 20, preTag: "", postTag: "" } }
  }))}`;
  const data = await fetchJsonRemote(url, { Referer: "https://so.eastmoney.com/" }, signal);
  const items = extractNewsRows(data)
    .map((row) => normalizeNewsRow(row, { source: "东方财富资讯搜索", code, name }))
    .filter((item) => item.title);
  return { items, source: "东方财富资讯搜索", sourceUrl: url };
}

function extractNewsRows(data) {
  return pickRows(data, ["list", "data", "Data", "records", "items", "result", "cmsArticleWebOld"]);
}

function normalizeNewsRow(row, context = {}) {
  const title = stripHtml(pickString(row, ["title", "TITLE", "art_title", "ART_TITLE", "newsTitle", "NEWS_TITLE", "showTitle", "name"]));
  const date = normalizeEventDate(pickString(row, ["showTime", "SHOW_TIME", "publishTime", "PUBLISH_TIME", "time", "date", "DISPLAY_TIME", "updateTime", "sourceTime"]));
  const source = stripHtml(pickString(row, ["source", "SOURCE", "mediaName", "media", "sourceName"])) || context.source || "公开资讯";
  const summary = stripHtml(pickString(row, ["summary", "SUMMARY", "digest", "content", "abstract", "description"]));
  const url = pickString(row, ["url", "URL", "art_url", "ART_URL", "articleUrl", "ArticleUrl", "wapurl"]);
  return {
    title: normalizeWhitespace(title),
    date,
    source,
    url,
    summary: normalizeWhitespace(summary).slice(0, 180)
  };
}

function dedupeNewsItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const title = normalizeWhitespace(item.title);
    if (!title) return false;
    const key = `${title}|${item.date || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRelevantNewsItem(item, code, name) {
  if (item.relevanceTrusted) return true;
  const text = `${item.title || ""} ${item.summary || ""}`;
  const cleanName = String(name || "").trim();
  const aliases = [...new Set([cleanName, cleanName.replace(/^\*?ST/i, "").trim()].filter(Boolean))];
  if (text.includes(code)) return true;
  return aliases.some((alias) => text.includes(alias));
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function fetchDisclosureEventsWithFallback(code, signal) {
  const errors = [];
  const sourceUrls = [];
  const sources = [];

  const [announcementResult, unlockResult] = await Promise.all([
    withTimeout((childSignal) => fetchEastMoneyAnnouncements(code, childSignal), SINGLE_FETCH_TIMEOUT_MS, "公告获取超时", signal)
      .catch((error) => {
        errors.push(`东方财富公告：${error.message}`);
        return { items: [] };
      }),
    withTimeout((childSignal) => fetchEastMoneyUnlocks(code, childSignal), SINGLE_FETCH_TIMEOUT_MS, "解禁获取超时", signal)
      .catch((error) => {
        errors.push(`东方财富解禁：${error.message}`);
        return { items: [] };
      })
  ]);

  const announcements = announcementResult.items || [];
  const unlocks = unlockResult.items || [];

  if (announcements.length) {
    sources.push(announcementResult.source);
    sourceUrls.push(announcementResult.sourceUrl);
  }
  if (unlocks.length) {
    sources.push(unlockResult.source);
    sourceUrls.push(unlockResult.sourceUrl);
  }

  return {
    announcements,
    unlocks,
    source: sources.join(" + "),
    sourceUrls: sourceUrls.filter(Boolean),
    errors,
    status: sources.length ? "ok" : "missing"
  };
}

async function fetchEastMoneyAnnouncements(code, signal) {
  // 公告接口的 stock_list 只接受 6 位代码；写成 "600519.SH" 会返回 total_hits: 0。
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=50&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}&f_node=0&s_node=0`;
  const data = await fetchJsonRemote(url, { Referer: "https://data.eastmoney.com/notices/" }, signal);
  const items = extractAnnouncementRows(data)
    .map((row) => normalizeAnnouncementRow(row, code))
    .filter((item) => item.title)
    .slice(0, 50);
  return { items, source: "东方财富公告", sourceUrl: url };
}

async function fetchEastMoneyUnlocks(code, signal) {
  const filter = encodeURIComponent(`(SECURITY_CODE="${code}")`);
  // RPT_LIFT_STAGE 没有 LIFT_DATE 列，排序字段必须用 FREE_DATE；否则接口返回“排序字段不存在”而拿不到任何解禁数据。
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LIFT_STAGE&columns=ALL&filter=${filter}&pageNumber=1&pageSize=10&sortColumns=FREE_DATE&sortTypes=1`;
  const data = await fetchJsonRemote(url, { Referer: "https://data.eastmoney.com/dxf/" }, signal);
  const items = extractRows(data)
    .map(normalizeUnlockRow)
    .filter((item) => item.date || item.title)
    .slice(0, 10);
  return { items, source: "东方财富解禁日程", sourceUrl: url };
}

function buildEventSignals(disclosure = {}, finance = {}) {
  const announcementEvents = classifyAnnouncementEvents(disclosure.announcements || []);
  const unlockEvents = classifyUnlockEvents(disclosure.unlocks || []);
  const financeEvents = classifyFinanceEvents(finance);
  const items = dedupeEventSignals([...announcementEvents, ...unlockEvents, ...financeEvents])
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority) || String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 8);
  const sourceParts = [disclosure.source, financeEvents.length ? finance.source : ""].filter(Boolean);
  const sourceUrls = [...(disclosure.sourceUrls || []), ...(financeEvents.length ? finance.sourceUrls || [] : [])].filter(Boolean);

  return {
    items,
    status: disclosure.status === "ok" || items.length ? "ok" : "missing",
    source: sourceParts.join(" + "),
    sourceUrls: [...new Set(sourceUrls)],
    error: (disclosure.errors || []).join("；")
  };
}

function classifyAnnouncementEvents(announcements) {
  const events = [];
  announcements.forEach((announcement) => {
    const title = normalizeWhitespace(announcement.title);
    if (!title || isOldEventDate(announcement.date, 180)) return;
    const matched = classifyAnnouncementTitle(title);
    if (!matched) return;
    events.push({
      type: matched.type,
      title: matched.title,
      priority: matched.priority,
      date: announcement.date,
      detail: `${announcement.date ? `${announcement.date} ` : ""}${title}`,
      reason: matched.reason,
      source: announcement.source || "东方财富公告",
      url: announcement.url || ""
    });
  });
  return limitEventsByType(events, 2);
}

function classifyAnnouncementTitle(title) {
  if (hasAnyText(title, ["立案", "行政处罚", "监管措施", "纪律处分", "违规", "风险警示", "退市风险", "重大诉讼", "仲裁", "股份冻结"])) {
    return { type: "监管风险", title: "监管/诉讼风险", priority: "high", reason: "公告出现监管、处罚、诉讼或风险警示关键词，需要优先核对事实和影响范围。" };
  }
  if (hasAnyText(title, ["问询函", "监管函", "关注函", "问询", "回复问询函"])) {
    return { type: "问询函", title: "问询/监管函", priority: "medium", reason: "公告出现问询或监管函，说明交易所或监管层要求公司进一步说明事项。" };
  }
  if (title.includes("减持") && !hasAnyText(title, ["不减持", "未减持"])) {
    return { type: "减持", title: "减持相关公告", priority: title.includes("被动减持") ? "high" : "medium", reason: "公告出现减持相关信息，需要观察减持主体、规模、期间和市场承接。" };
  }
  if (hasAnyText(title, ["解除限售", "限售股上市流通", "解禁"])) {
    return { type: "解禁压力", title: "限售股流通", priority: "medium", reason: "公告出现限售股流通或解禁信息，需要观察时间窗口和流通规模。" };
  }
  if (hasAnyText(title, ["业绩预告", "业绩快报", "年度报告", "半年度报告", "季度报告", "业绩修正", "业绩预告修正"]) && hasAnyText(title, ["亏损", "预亏", "下降", "下滑", "减少", "由盈转亏", "大幅下降", "亏损扩大", "为负"])) {
    return { type: "财报异常", title: "业绩/财报异常", priority: "medium", reason: "公告标题显示业绩承压或修正，需要继续核对正文和财务指标。" };
  }
  return null;
}

function classifyUnlockEvents(unlocks) {
  return unlocks.map((item) => {
    const days = daysFromToday(item.date);
    if (Number.isFinite(days) && (days < -14 || days > 90)) return null;
    const ratio = firstNumber(item.ratio, null);
    const priority = (Number.isFinite(days) && days <= 7) || (isFiniteNumber(ratio) && ratio >= 5) ? "high" : "medium";
    const parts = [
      item.date ? `${item.date} 附近` : "近期",
      "存在限售股解禁窗口",
      isFiniteNumber(ratio) ? `解禁比例约 ${ratio.toFixed(2)}%` : "",
      isFiniteNumber(item.shares) ? `解禁数量约 ${formatDisclosureNumber(item.shares)}` : "",
      isFiniteNumber(item.marketCap) ? `参考市值约 ${formatDisclosureNumber(item.marketCap)}` : ""
    ].filter(Boolean);
    return {
      type: "解禁压力",
      title: "解禁压力",
      priority,
      date: item.date,
      detail: parts.join("，"),
      reason: "解禁不等于抛压，但临近窗口需要结合股东类型、规模和成交承接观察。",
      source: item.source || "东方财富解禁日程",
      url: item.url || ""
    };
  }).filter(Boolean);
}

// 只有同比明显下滑才算“承压”，避免 -0.2% 这类噪声触发提醒。
const FINANCE_DECLINE_EVENT_THRESHOLD = -5;
// 金融业靠杠杆经营，资产负债率与其他行业不可比，跳过负债率判断。
const FINANCIAL_SECTOR_PATTERN = /银行|保险|证券|金融/;

function classifyFinanceEvents(finance = {}) {
  const notes = [];
  const financialSector = FINANCIAL_SECTOR_PATTERN.test(String(finance.sector || ""));
  const profitDecline = isFiniteNumber(finance.profitYoY) && finance.profitYoY <= FINANCE_DECLINE_EVENT_THRESHOLD;
  const revenueDecline = isFiniteNumber(finance.revenueYoY) && finance.revenueYoY <= FINANCE_DECLINE_EVENT_THRESHOLD;
  const debtRisk = !financialSector && isFiniteNumber(finance.debtRatio) && finance.debtRatio >= 75;
  if (profitDecline) notes.push(`净利同比 ${finance.profitYoY.toFixed(2)}%`);
  if (revenueDecline) notes.push(`营收同比 ${finance.revenueYoY.toFixed(2)}%`);
  if (isFiniteNumber(finance.netProfit) && finance.netProfit < 0) notes.push("净利润为负");
  if (debtRisk) notes.push(`负债率 ${finance.debtRatio.toFixed(2)}%`);
  if (!notes.length) return [];
  const high = (profitDecline && finance.profitYoY <= -30) || (isFiniteNumber(finance.netProfit) && finance.netProfit < 0) || (!financialSector && isFiniteNumber(finance.debtRatio) && finance.debtRatio >= 85);
  return [{
    type: "财报异常",
    title: "财务指标承压",
    priority: high ? "high" : "medium",
    date: finance.reportDate || "",
    detail: `${finance.reportDate ? `${finance.reportDate} ` : ""}${notes.join("，")}`,
    reason: "财务摘要出现承压指标，需要结合财报正文、行业周期和一次性因素复核。 ",
    source: finance.source || "公开财务摘要",
    url: Array.isArray(finance.sourceUrls) ? finance.sourceUrls[0] || "" : ""
  }];
}

function extractAnnouncementRows(data) {
  return pickRows(data, ["list", "data", "Data", "records", "items"]);
}

function normalizeAnnouncementRow(row, code) {
  const title = pickString(row, ["title", "TITLE", "ANNOUNCEMENT_TITLE", "NOTICE_TITLE", "ANN_TITLE", "art_title", "ART_TITLE"]);
  const date = normalizeEventDate(pickString(row, ["display_time", "DISPLAY_TIME", "NOTICE_DATE", "ANNOUNCE_TIME", "EI_TIME", "eutime", "UPDATE_TIME"]));
  const artCode = pickString(row, ["art_code", "ART_CODE", "INFO_CODE", "NOTICE_ID", "ANN_ID"]);
  const rawUrl = pickString(row, ["url", "URL", "attach_url", "ATTACH_URL", "ANNOUNCEMENT_URL"]);
  const url = rawUrl || (artCode ? `https://data.eastmoney.com/notices/detail/${code}/${artCode}.html` : "");
  return { title, date, source: "东方财富公告", url }; 
}

function normalizeUnlockRow(row) {
  return {
    title: pickString(row, ["SECURITY_NAME_ABBR", "SECURITY_NAME", "股票简称"]),
    date: normalizeEventDate(pickString(row, ["LIFT_DATE", "FREE_DATE", "UNLOCK_DATE", "LISTING_DATE", "解禁日期", "上市流通日期"])), 
    // RPT_LIFT_STAGE 的 FREE_RATIO 是小数（0.3197 = 31.97%），换算成百分比。
    ratio: ratioToPercent(pickNumber(row, ["FREE_SHARES_RATIO", "LIFT_RATIO", "UNLOCK_RATIO", "LIFT_SHARES_RATIO", "FREE_RATIO", "解禁比例"])),
    // 该报表的股数单位是“万股”，市值单位是“万元”，统一换算成股和元。
    shares: wanToUnits(pickNumber(row, ["CURRENT_FREE_SHARES", "FREE_SHARES", "LIFT_NUM", "LIFT_SHARES", "UNLOCK_SHARES", "解禁数量"])),
    marketCap: wanToUnits(pickNumber(row, ["FREE_MARKET_CAP", "LIFT_MARKET_CAP", "UNLOCK_MARKET_CAP", "MARKET_CAP", "解禁市值"])),
    source: "东方财富解禁日程",
    url: "https://data.eastmoney.com/dxf/"
  };
}

function pickRows(data, keys) {
  if (Array.isArray(data)) return data;
  const direct = [data?.data?.list, data?.data?.data, data?.Data, data?.result?.data, data?.result?.list, data?.list, data?.records, data?.items];
  const found = direct.find(Array.isArray);
  if (found) return found;
  const queue = [{ value: data, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || depth > 4) continue;
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && Array.isArray(child)) return child;
      if (child && typeof child === "object" && !Array.isArray(child)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return [];
}

function dedupeEventSignals(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.type}|${event.date}|${event.title}|${event.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limitEventsByType(events, limit) {
  const counts = new Map();
  return events.filter((event) => {
    const count = counts.get(event.type) || 0;
    if (count >= limit) return false;
    counts.set(event.type, count + 1);
    return true;
  });
}

function priorityWeight(priority) {
  return { high: 3, medium: 2, low: 1 }[priority] || 0;
}

function hasAnyText(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEventDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const dashed = text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  if (dashed) {
    const [year, month, day] = dashed[0].replace(/\//g, "-").split("-");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const compact = text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return text.slice(0, 10);
}

function daysFromToday(dateText) {
  const date = parseEventDate(dateText);
  if (!date) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const dateUtc = Date.UTC(date.year, date.month - 1, date.day);
  return Math.round((dateUtc - todayUtc) / 86_400_000);
}

function isOldEventDate(dateText, maxAgeDays) {
  const days = daysFromToday(dateText);
  return Number.isFinite(days) && days < -maxAgeDays;
}

function parseEventDate(dateText) {
  const normalized = normalizeEventDate(dateText);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatDisclosureNumber(value) {
  if (!isFiniteNumber(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`; 
  if (abs >= 10_000) return `${(value / 10_000).toFixed(2)}万`; 
  return String(Number(value.toFixed(2)));
}

/** 解禁报表里的比例字段是小数，转换成百分比。 */
function ratioToPercent(value) {
  return isFiniteNumber(value) ? Number((value * 100).toFixed(4)) : null;
}

/** 解禁报表里的股数与市值单位是“万”，换算成股/元。 */
function wanToUnits(value) {
  return isFiniteNumber(value) ? Number((value * 10_000).toFixed(2)) : null;
}

async function fetchFinanceWithFallback(code) {
  const fullCode = toEastMoneyFullCode(code);
  const filter = encodeURIComponent(`(SECURITY_CODE="${code}")`);
  const endpoints = [
    {
      name: "东方财富F10主要指标",
      url: `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=1&code=${fullCode}`,
      referer: "https://emweb.securities.eastmoney.com/"
    },
    {
      name: "东方财富数据中心财务摘要",
      url: `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=${filter}&pageNumber=1&pageSize=8&sortColumns=REPORT_DATE&sortTypes=-1`,
      referer: "https://data.eastmoney.com/"
    }
  ];
  const errors = [];
  const results = await Promise.all(
    endpoints.map((endpoint) =>
      withTimeout(
        (signal) => fetchJsonRemote(endpoint.url, { Referer: endpoint.referer }, signal)
          .then((data) => {
            const finance = extractFinanceFromResponse(data, endpoint.name);
            if (hasAnyFinanceField(finance)) {
              return { finance, source: endpoint.name, url: endpoint.url };
            }
            errors.push(`${endpoint.name}未返回可用财务字段`);
            return null;
          }),
        SINGLE_FETCH_TIMEOUT_MS,
        `${endpoint.name}超时`
      )
        .catch((error) => {
          errors.push(`${endpoint.name}：${error.message}`);
          return null;
        })
    )
  ).then((items) => items.filter(Boolean));

  if (!results.length) {
    throw new Error(errors.join("；") || "公开财务摘要为空");
  }

  const reportDates = results.map((item) => item.finance.reportDate).filter(Boolean).sort().reverse();
  const selectedDate = reportDates[0] || "";
  const selectedResults = selectedDate ? results.filter((item) => item.finance.reportDate === selectedDate) : results;
  let merged = { source: "" };
  selectedResults.forEach((item) => {
    merged = mergeFinance(merged, item.finance);
    merged.sourceUrls = [...(merged.sourceUrls || []), item.url];
  });

  if (hasAnyFinanceField(merged)) {
    return { ...merged, source: selectedResults.map((item) => item.source).join(" + ") || merged.source, sourceUrls: merged.sourceUrls || [], errors };
  }

  throw new Error(errors.join("；") || "公开财务摘要为空");
}

function extractFinanceFromResponse(data, source) {
  const rows = extractRows(data);
  if (!rows.length) return { source };
  const row = rows.find((item) => item && (pickString(item, ["REPORT_DATE", "REPORTDATE", "DATE", "END_DATE", "ENDDATE"]))) || rows[0];

  return {
    source,
    sector: pickString(row, ["INDUSTRY_NAME", "INDUSTRY", "BK", "TRADE", "SECURITY_INDUSTRY_NAME", "BOARD_NAME"]),
    reportDate: normalizeReportDate(pickString(row, ["REPORT_DATE", "REPORTDATE", "REPORTDATE_NAME", "DATE", "END_DATE", "ENDDATE", "NOTICE_DATE"])), 
    roe: pickNumber(row, ["WEIGHTAVG_ROE", "WEIGHTED_ROE", "ROE_WEIGHT", "ROE_WEIGHT_AVG", "JQROE", "ROEJQ", "ROE", "NET_ROE", "DILUTED_ROE", "AVERAGE_ROE", "净资产收益率", "加权净资产收益率"]),
    revenueYoY: pickNumber(row, ["TOTAL_OPERATE_INCOME_YOY", "TOTAL_OPERATE_REVENUE_YOY", "TOTAL_REVENUE_YOY", "OPERATE_INCOME_YOY", "OPERATING_INCOME_YOY", "REVENUE_YOY", "YSTZ", "营业总收入同比增长率", "营业收入同比增长率", "营业收入同比增长", "营收同比", "OI_YOYRATIO_PK"]),
    profitYoY: pickNumber(row, ["PARENT_NETPROFIT_YOY", "PARENT_NETPROFIT_RATIO", "NETPROFIT_YOY", "NET_PROFIT_YOY", "NETPROFITRATIO", "NP_YOY", "SJLTZ", "归属母公司股东的净利润同比增长率", "归母净利润同比增长率", "净利润同比增长率", "归母净利润同比增长", "净利同比", "PARENTNETPROFITTZ"]),
    debtRatio: pickNumber(row, ["DEBT_ASSET_RATIO", "ASSET_LIABILITY_RATIO", "LIABILITY_ASSET_RATIO", "DEBT_TO_ASSET_RATIO", "ZCFZL", "资产负债率"]),
    grossMargin: pickNumber(row, ["GROSS_PROFIT_RATIO", "SALE_GROSS_PROFIT_RATIO", "GROSS_MARGIN", "XSMLL", "销售毛利率", "毛利率"]),
    netMargin: pickNumber(row, ["NETPROFIT_MARGIN", "NET_PROFIT_RATIO", "SALE_NETPROFIT_RATIO", "XSJLL", "销售净利率", "净利率"]),
    eps: pickNumber(row, ["BASIC_EPS", "EPS", "JBMG收益", "基本每股收益", "每股收益"]),
    bps: pickNumber(row, ["BPS", "BVPS", "NET_ASSET_PS", "MGJZC", "每股净资产"]),
    cashFlowPerShare: pickNumber(row, ["MGJYXJJE", "OCFPS", "CASHFLOWPS", "每股经营现金流", "每股现金流量净额"]),
    revenue: pickNumberStrict(row, ["TOTAL_OPERATE_INCOME", "TOTAL_OPERATE_REVENUE", "OPERATE_INCOME", "OPERATE_INCOME_PK", "OPERATING_INCOME", "营业总收入", "营业收入"]),
    netProfit: pickNumberStrict(row, ["PARENT_NETPROFIT", "PARENTNETPROFIT", "PARENT_NET_PROFIT", "NETPROFIT", "NET_PROFIT", "归属母公司股东的净利润", "归母净利润", "净利润"]),
    pe: pickNumber(row, ["PE", "PE_TTM", "PETTM", "市盈率"]),
    pb: pickNumber(row, ["PB", "PBMRQ", "市净率"])
  };
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.Data)) return data.Data;
  if (Array.isArray(data?.result?.data)) return data.result.data;
  if (Array.isArray(data?.result?.Data)) return data.result.Data;
  if (Array.isArray(data?.zyzb)) return data.zyzb;
  if (Array.isArray(data?.mainTarget)) return data.mainTarget;
  return [];
}

function pickNumber(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = toFiniteNumber(row[key]);
      if (isFiniteNumber(value)) return value;
    }
  }

  const entries = Object.entries(row || {});
  for (const key of keys) {
    const lowered = key.toLowerCase();
    const match = entries.find(([entryKey]) => {
      const normalizedEntry = entryKey.toLowerCase();
      return normalizedEntry === lowered || normalizedEntry.includes(lowered) || entryKey.includes(key);
    });
    if (match) {
      const value = toFiniteNumber(match[1]);
      if (isFiniteNumber(value)) return value;
    }
  }

  return null;
}

function pickNumberStrict(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = toFiniteNumber(row[key]);
      if (isFiniteNumber(value)) return value;
    }
  }

  const entries = Object.entries(row || {});
  for (const key of keys) {
    const lowered = key.toLowerCase();
    const match = entries.find(([entryKey]) => entryKey.toLowerCase() === lowered);
    if (match) {
      const value = toFiniteNumber(match[1]);
      if (isFiniteNumber(value)) return value;
    }
  }

  return null;
}

function pickString(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== "-") return String(value);
  }
  return "";
}

function isUsableQuote(quote) {
  return [quote?.close, quote?.open, quote?.high, quote?.low, quote?.prevClose, quote?.volume, quote?.amount].some(isFiniteNumber);
}

function quoteTimeValue(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const normalized = text.replace(/\//g, "-");
  const parsed = Date.parse(normalized.includes("T") ? normalized : normalized.replace(" ", "T"));
  if (Number.isFinite(parsed)) return parsed;
  // 腾讯行情时间是 20261117161443 这类紧凑格式。直接按数字比较会得到远超时间戳的巨大值，
  // 让腾讯永远被判定为“最新”；这里换算成同一量级的时间戳。
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/);
  if (compact) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = compact;
    const compactParsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
    if (Number.isFinite(compactParsed)) return compactParsed;
  }
  return 0;
}

function mergeQuote(base, extra) {
  // base 若是合并结果，base.source 已经是拼接后的字符串，直接并入会造成来源重复。
  const baseSources = base.sources || (base.source ? [base.source] : []);
  const sources = [...new Set([...baseSources, extra.source].filter(Boolean))];
  const sourceUrls = [...new Set([...(base.sourceUrls || []), base.sourceUrl, extra.sourceUrl].filter(Boolean))];
  const extraIsNewer = quoteTimeValue(extra.tradeTime) > quoteTimeValue(base.tradeTime);
  const primary = extraIsNewer ? extra : base;
  const secondary = extraIsNewer ? base : extra;
  return {
    code: primary.code || secondary.code || "",
    name: primary.name || secondary.name || "",
    close: firstNumber(primary.close, secondary.close, null),
    high: firstNumber(primary.high, secondary.high, null),
    low: firstNumber(primary.low, secondary.low, null),
    open: firstNumber(primary.open, secondary.open, null),
    volume: firstNumber(primary.volume, secondary.volume, null),
    amount: firstNumber(primary.amount, secondary.amount, null),
    volumeRatio: firstNumber(primary.volumeRatio, secondary.volumeRatio, null),
    prevClose: firstNumber(primary.prevClose, secondary.prevClose, null),
    changeAmount: firstNumber(primary.changeAmount, secondary.changeAmount, null),
    changePct: firstNumber(primary.changePct, secondary.changePct, null),
    amplitude: firstNumber(primary.amplitude, secondary.amplitude, null),
    turnoverRate: firstNumber(primary.turnoverRate, secondary.turnoverRate, null),
    pe: firstNumber(base.pe, extra.pe, null),
    peStatic: firstNumber(base.peStatic, extra.peStatic, null),
    pb: firstNumber(base.pb, extra.pb, null),
    totalShares: firstNumber(base.totalShares, extra.totalShares, null),
    floatShares: firstNumber(base.floatShares, extra.floatShares, null),
    marketCap: firstNumber(base.marketCap, extra.marketCap, null),
    floatMarketCap: firstNumber(base.floatMarketCap, extra.floatMarketCap, null),
    sector: base.sector && base.sector !== "待补充" ? base.sector : extra.sector || base.sector || "待补充",
    tradeTime: primary.tradeTime || secondary.tradeTime || "",
    sources,
    source: sources.join(" + "),
    sourceUrls,
    sourceUrl: sourceUrls[0] || ""
  };
}

function mergeFinance(base, extra) {
  return {
    source: extra.source || base.source || "",
    sector: base.sector || extra.sector || "",
    reportDate: base.reportDate || extra.reportDate || "",
    roe: firstNumber(base.roe, extra.roe, null),
    revenueYoY: firstNumber(base.revenueYoY, extra.revenueYoY, null),
    profitYoY: firstNumber(base.profitYoY, extra.profitYoY, null),
    debtRatio: firstNumber(base.debtRatio, extra.debtRatio, null),
    grossMargin: firstNumber(base.grossMargin, extra.grossMargin, null),
    netMargin: firstNumber(base.netMargin, extra.netMargin, null),
    eps: firstNumber(base.eps, extra.eps, null),
    bps: firstNumber(base.bps, extra.bps, null),
    cashFlowPerShare: firstNumber(base.cashFlowPerShare, extra.cashFlowPerShare, null),
    revenue: firstNumber(base.revenue, extra.revenue, null),
    netProfit: firstNumber(base.netProfit, extra.netProfit, null),
    pe: firstNumber(base.pe, extra.pe, null),
    pb: firstNumber(base.pb, extra.pb, null),
    sourceUrls: base.sourceUrls || []
  };
}

function hasAnyFinanceField(finance) {
  return [
    finance?.roe,
    finance?.revenueYoY,
    finance?.profitYoY,
    finance?.debtRatio,
    finance?.grossMargin,
    finance?.netMargin,
    finance?.eps,
    finance?.bps,
    finance?.cashFlowPerShare,
    finance?.revenue,
    finance?.netProfit,
    finance?.pe,
    finance?.pb
  ].some(isFiniteNumber);
}

async function fetchSinaQuote(code, signal) {
  const symbol = toSinaSymbol(code);
  const url = `https://hq.sinajs.cn/list=${symbol}`;
  const text = await fetchTextRemote(url, {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://finance.sina.com.cn/"
  }, "gb18030", signal);
  const match = text.match(/="(.*)"/);
  if (!match || !match[1]) throw new Error("没有查询到该股票的新浪行情。");
  const cells = match[1].split(",");
  if (cells.length < 32 || !cells[0]) throw new Error("新浪行情返回为空。");

  const open = toFiniteNumber(cells[1]);
  const prevClose = toFiniteNumber(cells[2]);
  const close = firstNumber(toFiniteNumber(cells[3]), prevClose, open, null);
  const high = firstNumber(toFiniteNumber(cells[4]), close, null);
  const low = firstNumber(toFiniteNumber(cells[5]), close, null);
  const volume = toFiniteNumber(cells[8]);
  const date = cells[30] || "";
  const time = cells[31] || "";

  return {
    code,
    name: cells[0],
    close,
    high,
    low,
    open,
    volume,
    prevClose,
    pe: null,
    pb: null,
    sector: "待补充",
    tradeTime: [date, time].filter(Boolean).join(" "),
    source: "新浪财经实时行情",
    sourceUrl: url
  };
}

function toSinaSymbol(code) {
  return `${code.startsWith("6") || code.startsWith("9") ? "sh" : "sz"}${code}`;
}

async function fetchJsonRemote(url, headers = {}, signal) {
  const text = await fetchTextWithPolicy(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*",
      "Referer": "https://quote.eastmoney.com/",
      ...headers
    }
  }, {
    timeoutMs: REMOTE_FETCH_TIMEOUT_MS,
    maxBytes: REMOTE_RESPONSE_MAX_BYTES,
    timeoutMessage: "真实数据接口请求超时",
    failureMessage: "真实数据接口"
  }, signal);
  try {
    return parseJsonText(text);
  } catch {
    throw new Error("真实数据接口返回了无法解析的数据。");
  }
}

async function fetchTextRemote(url, headers = {}, encoding = "utf-8", signal) {
  const buffer = await fetchBufferWithPolicy(url, { headers }, {
    timeoutMs: REMOTE_FETCH_TIMEOUT_MS,
    maxBytes: REMOTE_RESPONSE_MAX_BYTES,
    timeoutMessage: "真实行情接口请求超时",
    failureMessage: "真实行情接口"
  }, signal);
  return decodeText(buffer, encoding);
}

function parseJsonText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty json");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("invalid json");
  }
}

function decodeText(buffer, encoding) {
  const encodings = encoding === "gb18030" ? ["gb18030", "gbk", "utf-8"] : [encoding, "utf-8"];
  for (const item of encodings) {
    try {
      return new TextDecoder(item).decode(buffer);
    } catch {
      // Try next decoder.
    }
  }
  return Buffer.from(buffer).toString("utf8");
}

function eastMoneyNumber(value, scale) {
  const number = toFiniteNumber(value);
  if (!isFiniteNumber(number)) return null;
  return Number((number / scale).toFixed(4));
}

/**
 * 成交量统一按“股”保存。
 * 东方财富行情(f47)、东方财富K线(f56)、腾讯行情(cells[6])、腾讯K线的成交量单位都是“手”，
 * 网易行情/网易CSV、新浪行情的单位已经是“股”。若不做统一，量比（volume / avgVolume20）
 * 会因两个字段单位不同而相差 100 倍，产生错误的“放量”提醒。
 */
function handsToShares(value) {
  return isFiniteNumber(value) ? value * 100 : null;
}

/**
 * 东方财富 f177/f198 返回的不是时间（实测为 577、"BK1277"），行情时间来自 f86（Unix 秒）。
 * 统一换算成北京时间字符串，避免把无效值写进 tradeTime 并传给模型上下文。
 */
function formatEastMoneyTradeTime(value) {
  const seconds = toFiniteNumber(value);
  if (!isFiniteNumber(seconds) || seconds <= 0) return "";
  const date = new Date((seconds + 8 * 60 * 60) * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === "-" || value === "") return null;
  const number = Number(String(value).replace(/,/g, "").replace(/%/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function firstNumber(...values) {
  return values.find(isFiniteNumber) ?? null;
}

function normalizeReportDate(value) {
  if (!value) return "";
  const text = String(value);
  const match = text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  return match ? match[0].replace(/\//g, "-") : text.slice(0, 10);
}

function priceChange(close, prevClose) {
  if (!isFiniteNumber(close) || !isFiniteNumber(prevClose)) return null;
  return Number((close - prevClose).toFixed(4));
}

function priceChangePct(close, prevClose) {
  if (!isFiniteNumber(close) || !isFiniteNumber(prevClose) || prevClose === 0) return null;
  return Number((((close - prevClose) / prevClose) * 100).toFixed(4));
}

/** 本地量比：当日成交量 / 20日均量，与浏览器规则层口径一致。 */
function volumeRatioOf(stock) {
  if (!isFiniteNumber(stock?.volume) || !isFiniteNumber(stock?.avgVolume20) || stock.avgVolume20 === 0) return null;
  return Number((stock.volume / stock.avgVolume20).toFixed(4));
}

function periodChange(values, days) {
  if (values.length <= days) return null;
  const current = values.at(-1);
  const base = values.at(-(days + 1));
  return priceChangePct(current, base);
}

function volatility(values, days) {
  if (values.length <= days) return null;
  const window = values.slice(-(days + 1));
  const returns = [];
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1];
    const current = window[index];
    if (isFiniteNumber(previous) && isFiniteNumber(current) && previous !== 0) {
      returns.push(((current - previous) / previous) * 100);
    }
  }
  if (returns.length < 2) return null;
  const mean = average(returns);
  const variance = average(returns.map((item) => (item - mean) ** 2));
  return isFiniteNumber(variance) ? Number(Math.sqrt(variance).toFixed(4)) : null;
}

function maxDrawdown(values) {
  const clean = values.filter(isFiniteNumber);
  if (clean.length < 2) return null;
  let peak = clean[0];
  let drawdown = 0;
  clean.forEach((value) => {
    if (value > peak) peak = value;
    if (peak > 0) drawdown = Math.min(drawdown, ((value - peak) / peak) * 100);
  });
  return Number(drawdown.toFixed(4));
}

function movingAverage(values, days) {
  if (values.length < days) return null;
  const result = average(values.slice(-days));
  return isFiniteNumber(result) ? Number(result.toFixed(4)) : null;
}

function average(values) {
  const clean = values.filter(isFiniteNumber);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > REQUEST_BODY_MAX_BYTES) {
        fail(new HttpError(413, "请求体过大。"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks, size).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "请求体不是合法 JSON。"));
      }
    });
    request.on("error", (error) => fail(error));
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function serveStaticRequest(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (url.pathname.startsWith("/api/")) return false;

  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relativePath !== "index.html" && !relativePath.startsWith("src/")) return false;

  const filePath = path.resolve(PUBLIC_ROOT, relativePath);
  if (!filePath.startsWith(PUBLIC_ROOT)) return false;

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": getContentType(filePath) });
    if (request.method !== "HEAD") response.end(content);
    else response.end();
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
