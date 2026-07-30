function getLlmAgentUrl() {
  const firstPathSegment = window.location.pathname.split("/").filter(Boolean)[0];
  return firstPathSegment ? `/${firstPathSegment}` : "";
}

const LLM_AGENT_URL = getLlmAgentUrl();
const LLM_CONFIG_STORAGE_KEY = "yancetai.llmConfig.v1";

const llmUi = {
  modeBadge: document.getElementById("llmModeBadge"),
  statusText: document.getElementById("llmStatusText"),
  reportButton: document.getElementById("reportLlmButton"),
  reportOutput: document.getElementById("reportLlmOutput"),
  reportMeta: document.getElementById("reportLlmMeta"),
  configButton: document.getElementById("modelConfigButton"),
  configDialog: document.getElementById("modelConfigDialog"),
  configForm: document.getElementById("modelConfigForm"),
  configCancelButton: document.getElementById("modelConfigCancelButton"),
  clearConfigButton: document.getElementById("clearModelConfigButton"),
  configStatus: document.getElementById("modelConfigStatus"),
  privacyNote: document.getElementById("modelPrivacyNote"),
  callMode: document.getElementById("modelCallMode"),
  saveConfigButton: document.getElementById("saveModelConfigButton"),
  provider: document.getElementById("modelProvider"),
  model: document.getElementById("modelName"),
  baseUrl: document.getElementById("modelBaseUrl"),
  apiKey: document.getElementById("modelApiKey"),
  maxTokens: document.getElementById("modelMaxTokens")
};

const llmState = {
  configured: false,
  model: "",
  config: loadLlmConfig(),
  stockInsights: new Map(),
  dataLoadVersion: 0,
  directUnavailable: false
};

const LLM_CALL_MODES = {
  auto: "自动",
  direct: "浏览器直连",
  proxy: "网站代理"
};

const LLM_PROVIDER_DEFAULTS = {
  deepseek: { providerName: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com" },
  openai: { providerName: "OpenAI", model: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" },
  custom: { providerName: "OpenAI兼容服务", model: "", baseUrl: "" }
};

function loadLlmConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(LLM_CONFIG_STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return null;
    if (saved.callMode === "local") {
      saved.callMode = "auto";
      delete saved.localAgentUrl;
      localStorage.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(saved));
    }
    return saved;
  } catch {
    return null;
  }
}

function saveLlmConfig(config) {
  localStorage.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(config));
  llmState.config = config;
}

function getEffectiveLlmConfig() {
  return llmState.config;
}

function llmConfigLabel(config) {
  if (!config) return "未配置";
  const providerName = config.providerName || LLM_PROVIDER_DEFAULTS[config.provider]?.providerName || config.provider;
  return [providerName, config.model, LLM_CALL_MODES[config.callMode || "auto"]].filter(Boolean).join(" · ");
}

function initializeLlmConfig() {
  llmState.configured = Boolean(llmState.config?.apiKey);
  llmState.model = llmConfigLabel(llmState.config);
  renderLlmStatus();
}

function renderLlmStatus() {
  if (!llmUi.modeBadge || !llmUi.statusText) return;

  if (llmState.configured) {
    llmUi.modeBadge.textContent = `AI已配置：${llmState.model}`;
    llmUi.statusText.textContent = llmState.model;
    llmUi.modeBadge.classList.remove("warning");
    llmUi.modeBadge.classList.add("ready");
    return;
  }

  llmUi.modeBadge.textContent = "AI未配置";
  llmUi.statusText.textContent = "点击右上角配置";
  llmUi.modeBadge.classList.remove("ready");
  llmUi.modeBadge.classList.add("warning");
}

function injectStockLlmPanel() {
  const stock = state.stocks.find((item) => item.code === state.selectedCode) || state.stocks[0];
  if (!stock || !els.analysisCard || document.getElementById("stockLlmOutput")) return;

  const strategy = normalizeAnalysisStrategy(stock.style);
  const modelName = llmState.configured ? llmConfigLabel(llmState.config) : "尚未配置模型";
  const saved = llmState.stockInsights.get(stockInsightKey(stock.code, strategy));
  const wrapper = document.createElement("section");
  wrapper.className = "llm-panel stock-llm-panel";
  wrapper.innerHTML = `<div class="llm-panel-header stock-llm-header">
    <div>
      <h3>AI策略研判</h3>
      <span>当前风格：${escapeHtml(strategy)} · ${escapeHtml(modelName)}</span>
    </div>
    <button class="ghost-button compact-button" id="stockLlmButton" type="button">生成策略报告</button>
  </div>
  <div class="llm-output markdown-output" id="stockLlmOutput"></div>`;
  els.analysisCard.appendChild(wrapper);
  setMarkdownOutput(document.getElementById("stockLlmOutput"), saved || `将按照个股风格“${strategy}”生成对应的分析报告。`);

  document.getElementById("stockLlmButton").addEventListener("click", () => generateStockInsight(stock));
}

const ANALYSIS_STRATEGIES = ["短线观察", "长期观察", "短线+长期", "风险观察", "等待确认"];

function normalizeAnalysisStrategy(strategy) {
  return ANALYSIS_STRATEGIES.includes(strategy) ? strategy : "短线观察";
}

function stockInsightKey(code, strategy) {
  return `${code}:${normalizeAnalysisStrategy(strategy)}`;
}

async function generateStockInsight(stock) {
  if (!stock) return;
  const strategy = normalizeAnalysisStrategy(stock.style);
  const button = document.getElementById("stockLlmButton");
  const output = document.getElementById("stockLlmOutput");
  if (!button || !output) return;

  if (!llmState.configured) {
    setMarkdownOutput(output, "浏览器尚未配置大模型。请点击页面右上角“大模型配置”。");
    return;
  }

  button.disabled = true;
  button.textContent = "生成中";
  setMarkdownOutput(output, `正在抓取最新新闻、公告事件和规则信号，然后按“${strategy}”策略生成报告...`);
  const operation = window.yancetaiOperations?.startRequest();

  try {
    const result = await invokeLlm("stock-analysis", buildStockLlmPayload(stock, strategy), null, operation?.signal);
    if (operation && !operation.isCurrent()) return;
    if (!state.stocks.some((item) => item.code === stock.code)) return;
    const text = appendCompletionNotice(result.text || "模型没有返回内容。", result);
    const insightKey = stockInsightKey(stock.code, strategy);
    await LocalDataStore.saveStockInsight(insightKey, text);
    if (operation && !operation.isCurrent()) return;
    llmState.stockInsights.set(insightKey, text);
    const currentStock = state.stocks.find((item) => item.code === state.selectedCode);
    if (currentStock?.code === stock.code && stockInsightKey(currentStock.code, currentStock.style) === insightKey) {
      const currentOutput = document.getElementById("stockLlmOutput");
      if (currentOutput) setMarkdownOutput(currentOutput, text);
    }
  } catch (error) {
    if (!operation || operation.isCurrent()) {
      const currentStock = state.stocks.find((item) => item.code === state.selectedCode);
      const currentOutput = currentStock?.code === stock.code && stockInsightKey(currentStock.code, currentStock.style) === stockInsightKey(stock.code, strategy)
        ? document.getElementById("stockLlmOutput")
        : null;
      if (currentOutput) setMarkdownOutput(currentOutput, `LLM调用失败：${error.message}`);
    }
  } finally {
    operation?.finish();
    const currentStock = state.stocks.find((item) => item.code === state.selectedCode);
    const currentButton = currentStock?.code === stock.code && stockInsightKey(currentStock.code, currentStock.style) === stockInsightKey(stock.code, strategy)
      ? document.getElementById("stockLlmButton")
      : null;
    if (currentButton) {
      currentButton.disabled = false;
      currentButton.textContent = "重新生成策略报告";
    }
  }
}

async function fetchDailyBriefContext(payload, signal) {
  const stocks = (payload?.stocks || []).slice(0, 8).map((stock) => ({
    code: stock.code,
    name: stock.name,
    style: stock.style
  }));
  return fetchJson(`${LLM_AGENT_URL}/api/brief-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stocks }),
    signal
  });
}

async function generateReportInsight() {
  if (!llmUi.reportButton || !llmUi.reportOutput || !llmUi.reportMeta) return;

  if (!llmState.configured) {
    setMarkdownOutput(llmUi.reportOutput, "浏览器尚未配置大模型。请点击页面右上角“大模型配置”。");
    return;
  }

  llmUi.reportButton.disabled = true;
  llmUi.reportButton.textContent = "生成中";
  llmUi.reportMeta.textContent = `模型：${llmState.model}`;
  setMarkdownOutput(llmUi.reportOutput, "AI正在生成收盘复盘摘要...");
  const operation = window.yancetaiOperations?.startRequest();

  try {
    const basePayload = buildReportLlmPayload();
    const contextResult = await fetchDailyBriefContext(basePayload, operation?.signal);
    if (operation && !operation.isCurrent()) return;
    const payload = { ...basePayload, externalContext: contextResult.externalContext };
    const result = await invokeLlm("daily-brief", payload, null, operation?.signal);
    if (operation && !operation.isCurrent()) return;
    const reportText = appendCompletionNotice(result.text || "模型没有返回内容。", result);
    await LocalDataStore.saveDailyBrief(reportText);
    if (operation && !operation.isCurrent()) return;
    setMarkdownOutput(llmUi.reportOutput, reportText);
    llmUi.reportMeta.textContent = `生成于 ${formatDateTime(new Date())}`;
  } catch (error) {
    if (!operation || operation.isCurrent()) {
      setMarkdownOutput(llmUi.reportOutput, `LLM调用失败：${error.message}`);
      llmUi.reportMeta.textContent = "生成失败";
    }
  } finally {
    operation?.finish();
    llmUi.reportButton.disabled = false;
    llmUi.reportButton.textContent = "重新生成";
  }
}

function setMarkdownOutput(element, text) {
  if (!element) return;
  element.classList.add("markdown-output");
  element.innerHTML = renderMarkdown(text || "");
}

function appendCompletionNotice(text, result) {
  const notices = [];
  if (result?.channelNotice) notices.push(result.channelNotice);
  if (result?.finishReason === "length") {
    notices.push("本次输出达到模型长度上限，内容可能被截断。可以在大模型配置中调高最大输出 Tokens 后重新生成。");
  }
  return notices.length ? `${text}\n\n---\n提示：${notices.join("\n\n")}` : text;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let inCodeBlock = false;
  let codeLines = [];

  const splitTableRow = (line) => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let current = "";
    let escaped = false;
    for (const char of trimmed) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "|") {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const isTableSeparator = (line) => {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  };

  const renderTable = (headerLine, separatorLine, bodyLines) => {
    const headers = splitTableRow(headerLine);
    const alignments = splitTableRow(separatorLine).map((cell) => {
      if (cell.startsWith(":") && cell.endsWith(":")) return "center";
      if (cell.endsWith(":")) return "right";
      return "left";
    });
    const renderCells = (cells, tag) => headers.map((_, index) => {
      const alignment = alignments[index] || "left";
      return `<${tag} style="text-align:${alignment}">${renderInlineMarkdown(cells[index] || "")}</${tag}>`;
    }).join("");
    return `<div class="markdown-table-scroll"><table><thead><tr>${renderCells(headers, "th")}</tr></thead><tbody>${bodyLines.map((line) => `<tr>${renderCells(splitTableRow(line), "td")}</tr>`).join("")}</tbody></table></div>`;
  };

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  };

  const consumedTableLines = new Set();

  lines.forEach((line, index) => {
    if (consumedTableLines.has(index)) return;

    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        closeParagraph();
        closeList();
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      return;
    }

    if (trimmed.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      closeParagraph();
      closeList();
      const bodyLines = [];
      let bodyIndex = index + 2;
      while (bodyIndex < lines.length) {
        const bodyLine = lines[bodyIndex].trim();
        if (!bodyLine || !bodyLine.includes("|")) break;
        bodyLines.push(lines[bodyIndex]);
        bodyIndex += 1;
      }
      html.push(renderTable(line, lines[index + 1], bodyLines));
      for (let consumedIndex = index + 1; consumedIndex < bodyIndex; consumedIndex += 1) {
        consumedTableLines.add(consumedIndex);
      }
      return;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      html.push("<hr>");
      return;
    }

    const quote = trimmed.match(/^>\s?(.+)$/);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      return;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      closeParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) closeList();
      if (!listType) {
        listType = nextType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${renderInlineMarkdown((unordered || ordered)[1])}</li>`);
      return;
    }

    closeList();
    paragraph.push(trimmed);
  });

  if (inCodeBlock) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  closeParagraph();
  closeList();
  return html.join("");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  const codeSpans = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE_${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  codeSpans.forEach((code, index) => {
    html = html.replace(`@@CODE_${index}@@`, code);
  });
  return html;
}

function buildStrategyContext(strategy) {
  const contexts = {
    "短线观察": {
      horizon: "数个交易日至数周",
      priorities: ["趋势与均线结构", "量价配合", "20/60日区间", "波动与回撤", "近期事件催化"],
      decisionStandard: "短线结构是否得到成交量和事件验证"
    },
    "长期观察": {
      horizon: "数个季度至数年",
      priorities: ["ROE与利润质量", "营收和净利增长", "现金流与负债", "估值背景", "长期逻辑失效条件"],
      decisionStandard: "经营质量和成长持续性是否足以支撑长期跟踪"
    },
    "短线+长期": {
      horizon: "短线与长期双周期",
      priorities: ["短线趋势", "长期基本面", "两个周期的一致性", "周期冲突", "分周期风险"],
      decisionStandard: "短线结构与长期逻辑是否互相支持或明显冲突"
    },
    "风险观察": {
      horizon: "当前至风险解除",
      priorities: ["回撤与波动", "止损距离", "仓位暴露", "趋势弱化", "财务与事件风险"],
      decisionStandard: "现有风险是否可量化、是否正在升级以及还缺哪些证据"
    },
    "等待确认": {
      horizon: "关键证据出现前",
      priorities: ["已确认事实", "矛盾信号", "缺失数据", "事件真实性", "形成判断的触发条件"],
      decisionStandard: "当前证据是否足以形成方向性判断"
    }
  };
  return contexts[strategy];
}

function buildStockLlmPayload(stock, analysisStrategy) {
  const strategy = normalizeAnalysisStrategy(analysisStrategy);
  return {
    analysisStrategy: strategy,
    originalWatchStyle: stock.style || "短线观察",
    strategyContext: buildStrategyContext(strategy),
    stock,
    metrics: {
      changePct: pct(stock),
      holdingStatus: stock.holdingStatus,
      costPrice: stock.costPrice,
      positionPct: stock.positionPct,
      targetPrice: stock.targetPrice,
      watchReason: stock.watchReason,
      volumeRatio: volumeRatio(stock),
      stopDistancePct: distanceToStop(stock),
      shortTrend: trendText(shortTrend(stock)),
      quality: qualityLevel(stock),
      risk: riskText(riskLevel(stock)),
      periodChange: {
        fiveDays: stock.change5d,
        twentyDays: stock.change20d,
        sixtyDays: stock.change60d
      },
      volatility: {
        twentyDays: stock.volatility20,
        sixtyDays: stock.volatility60,
        maxDrawdown60: stock.maxDrawdown60
      },
      valuation: {
        pe: stock.pe,
        peStatic: stock.peStatic,
        pb: stock.pb,
        marketCap: stock.marketCap,
        floatMarketCap: stock.floatMarketCap
      }
    },
    triggeredSignals: buildAlerts(stock),
    autoEvents: getAutoEvents(stock),
    ruleNotes: buildScoreNotes(stock),
    constraints: [
      "不要给出买入、卖出、目标价等直接交易指令。",
      "输出应帮助用户复盘逻辑、识别风险、明确下一步需要确认的信息。",
      "如果数据不足，明确说数据不足。"
    ]
  };
}

function buildReportLlmPayload() {
  const alerts = getAlerts();
  return {
    generatedAt: formatDateTime(state.lastUpdated),
    ruleReport: buildReport(alerts),
    alerts: alerts.slice(0, 20),
    stocks: state.stocks.map((stock) => ({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      style: stock.style,
      holdingStatus: stock.holdingStatus,
      positionPct: stock.positionPct,
      watchReason: stock.watchReason,
      changePct: pct(stock),
      volumeRatio: volumeRatio(stock),
      shortTrend: trendText(shortTrend(stock)),
      quality: qualityLevel(stock),
      risk: riskText(riskLevel(stock)),
      event: stock.event,
      autoEvents: getAutoEvents(stock),
      change20d: stock.change20d,
      change60d: stock.change60d,
      volatility20: stock.volatility20,
      pe: stock.pe,
      pb: stock.pb,
      marketCap: stock.marketCap
    })),
    externalDataRequest: "生成前补充各股票可获取的外部行情、新闻、公告事件和财务摘要，并标明来源与缺失项。",
    constraints: [
      "不要给出买入、卖出、目标价等直接交易指令。",
      "先总结最值得复盘的风险，再给观察清单。",
      "把短线和长期逻辑分开。",
      "外部信息获取失败时明确说明，不得编造。"
    ]
  };
}

function buildDirectMessages(task, payload) {
  if (task === "config-test") {
    return [
      { role: "system", content: "你正在执行连接测试。" },
      { role: "user", content: "请只回复：配置验证成功" }
    ];
  }
  const common = "你是研策台的A股研究辅助模型。只能根据输入数据分析；不得编造行情、新闻、公告或财务数据；数据不足时明确说明；不得给出直接买卖指令、目标价、建议仓位或收益承诺。使用中文Markdown输出。";
  if (task === "stock-analysis") {
    return [
      { role: "system", content: common },
      { role: "user", content: `请根据以下个股数据和观察风格生成结构化策略报告。重点区分已确认事实、推断、风险、数据缺口和后续验证条件。\n\n${JSON.stringify(payload, null, 2)}` }
    ];
  }
  return [
    { role: "system", content: common },
    { role: "user", content: `请将以下规则报告和股票数据整理为简洁的每日复盘摘要，控制在1000字以内。先总结风险，再列出值得跟踪的股票、相互矛盾的信号和下一步观察清单。必须结合 externalContext 中补充的外部行情、新闻、公告事件和财务摘要；引用时标明股票、日期和来源，缺失信息明确说明，不得编造。\n\n${JSON.stringify(payload)}` }
  ];
}

async function invokeLlmDirect(task, payload, config, signal) {
  const response = await fetch(`${String(config.baseUrl).replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: buildDirectMessages(task, payload),
      temperature: task === "config-test" ? 0 : 0.3,
      max_tokens: task === "config-test" ? 16 : config.maxTokens || 3200
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `模型直连失败：${response.status}`);
  const choice = data.choices?.[0] || {};
  return {
    text: choice.message?.content?.trim() || "",
    provider: config.providerName,
    model: config.model,
    finishReason: choice.finish_reason || "",
    usage: data.usage || null,
    channel: "direct"
  };
}

async function invokeLlmProxy(task, payload, config, baseUrl = LLM_AGENT_URL, signal) {
  try {
    return await fetchJson(`${String(baseUrl || "").replace(/\/+$/, "")}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, payload, llmConfig: config }),
      signal
    });
  } catch (error) {
    if (/请求超时|timeout/i.test(error.message || "")) {
      throw new Error("模型响应超时，请重试；若持续出现，请在大模型配置中选择响应更快的模型。 ");
    }
    throw error;
  }
}

async function invokeLlm(task, payload, configOverride = null, signal) {
  const sourceConfig = configOverride || getEffectiveLlmConfig();
  const taskMaxTokens = task === "config-test" ? 16 : task === "daily-brief" ? Math.min(sourceConfig.maxTokens || 3200, 1400) : sourceConfig.maxTokens;
  const config = { ...sourceConfig, maxTokens: taskMaxTokens };
  const mode = config?.callMode || "auto";
  if (mode === "direct") return invokeLlmDirect(task, payload, config, signal);
  if (mode === "proxy") return invokeLlmProxy(task, payload, config, LLM_AGENT_URL, signal);
  if (llmState.directUnavailable && task !== "config-test") {
    return invokeLlmProxy(task, payload, config, LLM_AGENT_URL, signal);
  }
  try {
    return await invokeLlmDirect(task, payload, config, signal);
  } catch (directError) {
    const transportError = directError instanceof TypeError || /failed to fetch|networkerror|load failed|cors/i.test(directError.message || "");
    if (!transportError) throw directError;
    llmState.directUnavailable = true;
    try {
      const result = await invokeLlmProxy(task, payload, config, LLM_AGENT_URL, signal);
      result.channelNotice = `浏览器直连受到跨域或网络限制，已自动改用网站无状态代理。`;
      return result;
    } catch (proxyError) {
      if (/请求超时|timeout/i.test(proxyError.message || "")) {
        throw new Error("模型响应超时，请重试；若持续出现，请在大模型配置中选择响应更快的模型。 ");
      }
      throw new Error(`网站代理调用失败：${proxyError.message}`);
    }
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || "服务返回了非JSON内容。 ");
  }

  if (!response.ok) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }

  return data;
}

function fillLlmConfigForm() {
  const config = llmState.config || {
    callMode: "auto",
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    maxTokens: 3200
  };
  llmUi.callMode.value = LLM_CALL_MODES[config.callMode] ? config.callMode : "auto";
  llmUi.provider.value = config.provider || "custom";
  llmUi.model.value = config.model || "";
  llmUi.baseUrl.value = config.baseUrl || "";
  llmUi.apiKey.value = config.apiKey || "";
  llmUi.maxTokens.value = config.maxTokens || 3200;
  updateCallModeUi();
  llmUi.configStatus.className = "inline-status";
  llmUi.configStatus.textContent = llmState.config ? `当前已保存：${llmConfigLabel(llmState.config)}。修改后请重新验证。` : "尚未保存配置，请填写后点击“验证并保存”。";
  llmUi.saveConfigButton.textContent = "验证并保存";
}

function updateCallModeUi() {
  const mode = llmUi.callMode.value;
  const notes = {
    auto: "自动模式优先由浏览器直接调用模型；如果被跨域策略阻止，会回退到当前网站的无状态代理。",
    direct: "API Key 和完整分析内容直接从浏览器发送给模型服务商；生成简报时，网站仅接收股票代码、名称和观察风格，用于补充公开信息。模型接口必须允许浏览器跨域请求。",
    proxy: "API Key 和分析内容会在本次请求中经过当前网站的无状态代理，但不会保存到云端数据库。"
  };
  llmUi.privacyNote.textContent = notes[mode] || notes.auto;
}

function applyProviderDefaults() {
  const defaults = LLM_PROVIDER_DEFAULTS[llmUi.provider.value];
  if (!defaults) return;
  llmUi.model.value = defaults.model;
  llmUi.baseUrl.value = defaults.baseUrl;
}

function openLlmConfigDialog() {
  fillLlmConfigForm();
  llmUi.configDialog.showModal();
}

function closeLlmConfigDialog() {
  llmUi.configDialog.close();
}

async function handleLlmConfigSubmit(event) {
  event.preventDefault();
  const provider = llmUi.provider.value;
  const defaults = LLM_PROVIDER_DEFAULTS[provider] || LLM_PROVIDER_DEFAULTS.custom;
  const config = {
    callMode: llmUi.callMode.value,
    provider,
    providerName: defaults.providerName,
    model: llmUi.model.value.trim(),
    baseUrl: llmUi.baseUrl.value.trim().replace(/\/+$/, ""),
    apiKey: llmUi.apiKey.value.trim(),
    maxTokens: Number(llmUi.maxTokens.value || 3200)
  };
  const previousConfig = getEffectiveLlmConfig();
  const connectionChanged = !previousConfig || ["callMode", "provider", "model", "baseUrl", "apiKey"]
    .some((key) => previousConfig[key] !== config[key]);
  if (connectionChanged) llmState.directUnavailable = false;
  if (!config.model || !config.baseUrl || !config.apiKey) {
    llmUi.configStatus.className = "inline-status error";
    llmUi.configStatus.textContent = "配置不完整，请填写模型名称、接口地址和 API Key。";
    return;
  }

  llmUi.saveConfigButton.disabled = true;
  llmUi.saveConfigButton.textContent = "正在验证";
  llmUi.configStatus.className = "inline-status";
  llmUi.configStatus.textContent = "正在连接模型服务并验证配置，请稍等...";
  try {
    const result = await invokeLlm("config-test", {}, config);
    if (!result?.text) throw new Error("模型没有返回测试结果。 ");
    saveLlmConfig(config);
    llmState.configured = true;
    llmState.model = llmConfigLabel(config);
    renderLlmStatus();
    renderAnalysis();
    llmUi.configStatus.className = "inline-status success";
    llmUi.configStatus.textContent = `配置验证成功：${llmState.model}，现在可以生成 AI 报告。`;
    llmUi.saveConfigButton.textContent = "验证成功";
    closeLlmConfigDialog();
  } catch (error) {
    llmUi.configStatus.className = "inline-status error";
    llmUi.configStatus.textContent = `配置验证失败：${error.message}`;
    llmUi.saveConfigButton.textContent = "重新验证";
  } finally {
    llmUi.saveConfigButton.disabled = false;
  }
}

window.getLocalLlmConfig = () => llmState.config ? { ...llmState.config } : null;
window.restoreLocalLlmConfig = (config) => {
  if (!config || typeof config !== "object") return;
  saveLlmConfig({ ...config, apiKey: "" });
  llmState.configured = false;
  llmState.model = llmConfigLabel(llmState.config);
  renderLlmStatus();
};

async function loadPersistedLlmData() {
  const loadVersion = ++llmState.dataLoadVersion;
  const [savedInsights, savedBrief] = await Promise.all([
    LocalDataStore.loadStockInsights(),
    LocalDataStore.loadDailyBrief()
  ]);
  if (loadVersion !== llmState.dataLoadVersion) return;
  llmState.stockInsights = new Map(Object.entries(savedInsights).map(([key, value]) => [key, typeof value === "string" ? value : value?.text || ""]));
  if (savedBrief?.text && llmUi.reportOutput) {
    setMarkdownOutput(llmUi.reportOutput, savedBrief.text);
    llmUi.reportMeta.textContent = savedBrief.updatedAt ? `上次生成于 ${formatDateTime(new Date(savedBrief.updatedAt))}` : "浏览器本地记录";
  } else if (llmUi.reportOutput && llmUi.reportMeta) {
    setMarkdownOutput(llmUi.reportOutput, "尚未生成 AI 收盘复盘摘要。");
    llmUi.reportMeta.textContent = "浏览器本地保存";
  }
}

function clearLlmConfig() {
  localStorage.removeItem(LLM_CONFIG_STORAGE_KEY);
  llmState.config = null;
  llmState.configured = false;
  llmState.model = "";
  fillLlmConfigForm();
  renderLlmStatus();
}

const originalRenderAnalysis = renderAnalysis;
renderAnalysis = function renderAnalysisWithLlm() {
  originalRenderAnalysis();
  injectStockLlmPanel();
};

if (llmUi.reportButton) {
  llmUi.reportButton.addEventListener("click", generateReportInsight);
}
if (llmUi.configButton) {
  llmUi.configButton.addEventListener("click", openLlmConfigDialog);
  llmUi.configForm.addEventListener("submit", handleLlmConfigSubmit);
  llmUi.callMode.addEventListener("change", updateCallModeUi);
  llmUi.provider.addEventListener("change", applyProviderDefaults);
  llmUi.configCancelButton.addEventListener("click", closeLlmConfigDialog);
  llmUi.clearConfigButton.addEventListener("click", clearLlmConfig);
  document.querySelector("[data-close-model-config]").addEventListener("click", closeLlmConfigDialog);
}

window.addEventListener("yancetai:backup-restored", (event) => {
  llmState.dataLoadVersion += 1;
  const restored = event.detail || {};
  llmState.stockInsights = new Map(Object.entries(restored.stockInsights || {}).map(([key, value]) => [key, typeof value === "string" ? value : value?.text || ""]));
  if (restored.dailyBrief?.text && llmUi.reportOutput) {
    setMarkdownOutput(llmUi.reportOutput, restored.dailyBrief.text);
    llmUi.reportMeta.textContent = restored.dailyBrief.updatedAt ? `上次生成于 ${formatDateTime(new Date(restored.dailyBrief.updatedAt))}` : "浏览器本地记录";
  } else if (llmUi.reportOutput && llmUi.reportMeta) {
    setMarkdownOutput(llmUi.reportOutput, "尚未生成 AI 收盘复盘摘要。");
    llmUi.reportMeta.textContent = "浏览器本地保存";
  }
  renderAnalysis();
});
window.addEventListener("yancetai:local-data-cleared", () => {
  llmState.dataLoadVersion += 1;
  llmState.stockInsights.clear();
  if (llmUi.reportOutput) setMarkdownOutput(llmUi.reportOutput, "尚未生成 AI 收盘复盘摘要。");
  if (llmUi.reportMeta) llmUi.reportMeta.textContent = "浏览器本地保存";
  renderAnalysis();
});

initializeLlmConfig();
loadPersistedLlmData().then(() => {
  renderAnalysis();
});
