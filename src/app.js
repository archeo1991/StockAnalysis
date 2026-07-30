const state = {
  stocks: [],
  thresholds: {
    move: 5,
    volume: 1.8,
    stop: 3
  },
  filter: "all",
  search: "",
  analysisSearch: "",
  selectedCode: null,
  lastUpdated: new Date()
};

const els = {
  dataBadge: document.getElementById("dataBadge"),
  helpButton: document.getElementById("helpButton"),
  helpDialog: document.getElementById("helpDialog"),
  helpCloseButton: document.getElementById("helpCloseButton"),
  helpDoneButton: document.getElementById("helpDoneButton"),
  moveThreshold: document.getElementById("moveThreshold"),
  volumeThreshold: document.getElementById("volumeThreshold"),
  stopThreshold: document.getElementById("stopThreshold"),
  moveThresholdValue: document.getElementById("moveThresholdValue"),
  volumeThresholdValue: document.getElementById("volumeThresholdValue"),
  stopThresholdValue: document.getElementById("stopThresholdValue"),
  signalFilter: document.getElementById("signalFilter"),
  stockCount: document.getElementById("stockCount"),
  alertCount: document.getElementById("alertCount"),
  strongCount: document.getElementById("strongCount"),
  riskCount: document.getElementById("riskCount"),
  lastUpdated: document.getElementById("lastUpdated"),
  alertList: document.getElementById("alertList"),
  stockTable: document.getElementById("stockTable"),
  stockTableCount: document.getElementById("stockTableCount"),
  dailyReport: document.getElementById("dailyReport"),
  searchInput: document.getElementById("searchInput"),
  analysisSearch: document.getElementById("analysisSearch"),
  stockPickerList: document.getElementById("stockPickerList"),
  analysisCard: document.getElementById("analysisCard"),
  addStockCode: document.getElementById("addStockCode"),
  addStockName: document.getElementById("addStockName"),
  addStockStyle: document.getElementById("addStockStyle"),
  addStockStopLoss: document.getElementById("addStockStopLoss"),
  addStockButton: document.getElementById("addStockButton"),
  refreshRealDataButton: document.getElementById("refreshRealDataButton"),
  addStockStatus: document.getElementById("addStockStatus"),
  editDialog: document.getElementById("editDialog"),
  editForm: document.getElementById("editForm"),
  editCode: document.getElementById("editCode"),
  editName: document.getElementById("editName"),
  editStyle: document.getElementById("editStyle"),
  editHoldingStatus: document.getElementById("editHoldingStatus"),
  editCostPrice: document.getElementById("editCostPrice"),
  editPositionPct: document.getElementById("editPositionPct"),
  editStopLoss: document.getElementById("editStopLoss"),
  editTargetPrice: document.getElementById("editTargetPrice"),
  editPlanDate: document.getElementById("editPlanDate"),
  editWatchReason: document.getElementById("editWatchReason"),
  editEvent: document.getElementById("editEvent"),
  editCancelButton: document.getElementById("editCancelButton"),
  copyReportButton: document.getElementById("copyReportButton"),
  reportLlmButton: document.getElementById("reportLlmButton"),
  reportLlmOutput: document.getElementById("reportLlmOutput"),
  reportLlmMeta: document.getElementById("reportLlmMeta"),
  downloadReportButton: document.getElementById("downloadReportButton"),
  exportButton: document.getElementById("exportButton"),
  backupImportInput: document.getElementById("backupImportInput"),
  resetButton: document.getElementById("resetButton"),
  refreshButton: document.getElementById("refreshButton"),
  globalTooltip: document.getElementById("globalTooltip")
};

function getAgentBaseUrl() {
  const firstPathSegment = window.location.pathname.split("/").filter(Boolean)[0];
  return firstPathSegment ? `/${firstPathSegment}` : "";
}

const AGENT_API_BASE_URL = getAgentBaseUrl();
let stockSaveQueue = Promise.resolve();
let operationGeneration = 0;
const activeRequestControllers = new Set();
const stockMembershipVersions = new Map();

function getStockMembershipVersion(code) {
  return stockMembershipVersions.get(code) || 0;
}

function bumpStockMembershipVersion(code) {
  stockMembershipVersions.set(code, getStockMembershipVersion(code) + 1);
}

function queueStockPersistence(task) {
  const operation = stockSaveQueue.then(task);
  stockSaveQueue = operation.catch(() => {});
  return operation;
}

function startOperationRequest() {
  const generation = operationGeneration;
  const controller = new AbortController();
  activeRequestControllers.add(controller);
  return {
    generation,
    signal: controller.signal,
    isCurrent: () => generation === operationGeneration,
    finish: () => activeRequestControllers.delete(controller)
  };
}

function invalidatePendingOperations() {
  operationGeneration += 1;
  activeRequestControllers.forEach((controller) => controller.abort());
  activeRequestControllers.clear();
}

window.yancetaiOperations = {
  startRequest: startOperationRequest,
  isCurrent: (generation) => generation === operationGeneration
};

function loadStocks() {
  const saved = localStorage.getItem("aStockAgentStocks");
  if (!saved) return [];

  try {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    if (isLegacySampleData(parsed)) {
      localStorage.removeItem("aStockAgentStocks");
      return [];
    }
    return parsed.map(normalizeStoredStock);
  } catch {
    return [];
  }
}

function saveStocks() {
  const snapshot = state.stocks.map((stock) => ({ ...stock }));
  return queueStockPersistence(() => LocalDataStore.saveStocks(snapshot));
}

async function initializeLocalStocks() {
  try {
    const indexedStocks = await LocalDataStore.loadStocks();
    if (Array.isArray(indexedStocks)) {
      state.stocks = indexedStocks.map(normalizeStoredStock);
      state.selectedCode = state.stocks[0]?.code || null;
      return;
    }
    const legacyStocks = loadStocks();
    state.stocks = legacyStocks;
    state.selectedCode = legacyStocks[0]?.code || null;
    await LocalDataStore.saveStocks(legacyStocks);
    localStorage.removeItem("aStockAgentStocks");
  } catch (error) {
    console.error("初始化浏览器本地数据失败：", error);
  }
}

function hasStableText(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !["待补充", "暂无", "未知", "未分类", "-"].includes(text);
}

function getUsefulEventText(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (["暂无", "待补充", "未知", "未分类", "-", "无", "无事件", "CSV导入"].includes(text)) return "";
  if (/^真实行情[:：]/.test(text)) return "";
  if (/^数据来源[:：]/.test(text)) return "";
  return text;
}

function getAutoEvents(stock) {
  return Array.isArray(stock?.autoEvents) ? stock.autoEvents.filter((event) => event && event.detail) : [];
}

function eventPriority(event) {
  return ["high", "medium", "low"].includes(event?.priority) ? event.priority : "low";
}

function hasEventRisk(stock) {
  const manualEvent = getUsefulEventText(stock.event);
  return Boolean(
    manualEvent.includes("减持") ||
    manualEvent.includes("问询") ||
    manualEvent.includes("不确定") ||
    getAutoEvents(stock).some((event) => ["high", "medium"].includes(eventPriority(event)))
  );
}

function mergeFetchedStock(existing = {}, fresh = {}) {
  const merged = { ...existing, ...fresh };
  const userFields = ["name", "style", "holdingStatus", "costPrice", "positionPct", "stopLoss", "targetPrice", "planDate", "watchReason"];
  userFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field];
  });
  const existingEvent = getUsefulEventText(existing.event);
  const freshEvent = getUsefulEventText(fresh.event);
  const existingAutoEvents = getAutoEvents(existing);
  const freshAutoEvents = getAutoEvents(fresh);
  if (hasStableText(existing.sector)) {
    merged.sector = existing.sector;
  } else if (hasStableText(fresh.sector)) {
    merged.sector = fresh.sector;
  } else {
    merged.sector = existing.sector || fresh.sector || "待补充";
  }
  merged.event = existingEvent || freshEvent || "";
  merged.autoEvents = Array.isArray(fresh.autoEvents) ? freshAutoEvents : existingAutoEvents;
  return merged;
}

function isLegacySampleData(stocks) {
  const generatedEvents = stocks.filter((stock) => stock.event && !String(stock.event).startsWith("真实行情：") && stock.event !== "CSV导入");
  return stocks.length >= 10 && generatedEvents.length >= 5;
}

function normalizeStoredStock(stock) {
  const next = { ...stock };
  next.code = normalizeStockCodeInput(next.code);
  next.name = next.name || next.code || "未命名";
  next.sector = next.sector || "待补充";
  next.style = next.style || "短线观察";
  next.holdingStatus = next.holdingStatus || "观察中";
  next.watchReason = next.watchReason || "";
  next.planDate = next.planDate || "";
  next.event = getUsefulEventText(next.event);
  next.autoEvents = getAutoEvents(next);
  const financeFields = ["roe", "revenueYoY", "profitYoY", "debtRatio"];
  const valuationFields = ["pe", "pb"];
  const historyFields = ["avgVolume20", "avgVolume60", "avgAmount20", "avgAmount60", "avgTurnover20", "avgTurnover60", "ma5", "ma10", "ma20", "ma60", "high20", "low20", "high60", "low60", "change5d", "change20d", "change60d", "volatility20", "volatility60", "maxDrawdown60"];
  const oldFinancePlaceholder = financeFields.every((field) => next[field] === 0 || next[field] === null || next[field] === undefined);

  if (next.dataStatus?.finance === "missing" || oldFinancePlaceholder) {
    financeFields.forEach((field) => {
      if (next[field] === 0) next[field] = null;
    });
    valuationFields.forEach((field) => {
      if (next[field] === 0) next[field] = null;
    });
  }

  if (next.dataStatus?.history === "missing") {
    historyFields.forEach((field) => {
      if (next[field] === 0) next[field] = null;
    });
  }

  return next;
}

function normalizeStockCodeInput(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
}

function setAddStockStatus(message, type = "info") {
  if (!els.addStockStatus) return;
  els.addStockStatus.textContent = message;
  els.addStockStatus.className = `inline-status ${type}`;
}

async function fetchRealStock(code, options = {}) {
  const params = new URLSearchParams({
    code: normalizeStockCodeInput(code),
    style: options.style || "短线观察",
    name: options.name || "",
    stopLoss: options.stopLoss || ""
  });
  const response = await fetch(`${AGENT_API_BASE_URL}/api/stock?${params.toString()}`, { signal: options.signal });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("真实行情服务返回了无法解析的数据。");
  }
  if (!response.ok) throw new Error(data.error || `真实行情请求失败：${response.status}`);
  return data.stock;
}

async function upsertStock(stock, options = {}) {
  const index = state.stocks.findIndex((item) => item.code === stock.code);
  if (index >= 0) {
    state.stocks[index] = options.fromFetch ? mergeFetchedStock(state.stocks[index], stock) : normalizeStoredStock(stock);
  } else {
    state.stocks.unshift(options.fromFetch ? mergeFetchedStock({}, stock) : normalizeStoredStock(stock));
  }
  state.selectedCode = stock.code;
  state.lastUpdated = new Date();
  render();
  await saveStocks();
}

async function addStockFromForm() {
  const code = normalizeStockCodeInput(els.addStockCode?.value);
  if (!/^\d{6}$/.test(code)) {
    setAddStockStatus("请输入6位A股代码，例如 600519。", "error");
    return;
  }
  const button = els.addStockButton;
  const previousText = button?.textContent || "添加/更新";
  if (button) {
    button.disabled = true;
    button.textContent = "获取中";
  }
  setAddStockStatus("正在获取真实行情，请稍等...", "info");
  const operation = startOperationRequest();
  try {
    const stock = await fetchRealStock(code, {
      name: els.addStockName?.value.trim() || "",
      style: els.addStockStyle?.value || "短线观察",
      stopLoss: els.addStockStopLoss?.value || "",
      signal: operation.signal
    });
    if (!operation.isCurrent()) return;
    bumpStockMembershipVersion(stock.code);
    await upsertStock(stock, { fromFetch: true });
    if (!operation.isCurrent()) return;
    if (els.addStockCode) els.addStockCode.value = "";
    if (els.addStockName) els.addStockName.value = "";
    if (els.addStockStopLoss) els.addStockStopLoss.value = "";
    setAddStockStatus(`已添加/更新 ${stock.code} ${stock.name}，数据来自真实行情接口。`, "success");
  } catch (error) {
    if (operation.isCurrent()) setAddStockStatus(`添加/更新失败：${formatFetchError(error)}。`, "error");
  } finally {
    operation.finish();
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

async function refreshSingleStock(code, button) {
  const stock = state.stocks.find((item) => item.code === code);
  if (!stock) return;
  const previousText = button?.textContent || "刷新";
  if (button) {
    button.disabled = true;
    button.textContent = "刷新中";
  }
  setAddStockStatus(`正在刷新 ${stock.code} ${stock.name}...`, "info");
  const operation = startOperationRequest();
  const membershipVersion = getStockMembershipVersion(code);
  try {
    const fresh = await fetchRealStock(stock.code, {
      style: stock.style,
      stopLoss: stock.stopLoss,
      signal: operation.signal
    });
    if (!operation.isCurrent() || getStockMembershipVersion(code) !== membershipVersion) return;
    const latest = state.stocks.find((item) => item.code === code);
    if (!latest) return;
    const merged = mergeFetchedStock(latest, fresh);
    state.stocks = state.stocks.map((item) => item.code === code ? normalizeStoredStock(merged) : item);
    state.lastUpdated = new Date();
    render();
    await saveStocks();
    if (operation.isCurrent()) setAddStockStatus(`已刷新 ${merged.code} ${merged.name}。`, "success");
  } catch (error) {
    if (operation.isCurrent()) setAddStockStatus(`刷新失败：${formatFetchError(error)}。`, "error");
  } finally {
    operation.finish();
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

async function deleteSingleStock(code) {
  const stock = state.stocks.find((item) => item.code === code);
  if (!stock) return;
  if (!confirm(`确认删除 ${stock.code} ${stock.name}？`)) return;
  bumpStockMembershipVersion(code);
  state.stocks = state.stocks.filter((item) => item.code !== code);
  if (state.selectedCode === code) state.selectedCode = state.stocks[0]?.code || null;
  state.lastUpdated = new Date();
  render();
  try {
    await saveStocks();
    setAddStockStatus(`已删除 ${stock.code} ${stock.name}。`, "success");
  } catch (error) {
    setAddStockStatus(`删除已更新到当前页面，但保存失败：${formatFetchError(error)}。`, "error");
  }
}

function openEditStockDialog(code) {
  const stock = state.stocks.find((item) => item.code === code);
  if (!stock) return;
  if (!els.editDialog || !els.editForm) return;
  els.editCode.value = stock.code;
  els.editName.value = stock.name || "";
  els.editStyle.value = stock.style || "短线观察";
  els.editHoldingStatus.value = stock.holdingStatus || "观察中";
  els.editCostPrice.value = hasNumber(stock.costPrice) ? stock.costPrice : "";
  els.editPositionPct.value = hasNumber(stock.positionPct) ? stock.positionPct : "";
  els.editStopLoss.value = hasNumber(stock.stopLoss) && stock.stopLoss > 0 ? stock.stopLoss : "";
  els.editTargetPrice.value = hasNumber(stock.targetPrice) ? stock.targetPrice : "";
  els.editPlanDate.value = stock.planDate || "";
  els.editWatchReason.value = stock.watchReason || "";
  els.editEvent.value = getUsefulEventText(stock.event);
  els.editDialog.showModal();
}

function handleStockRowAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, code } = button.dataset;
  if (!code) return;
  if (action === "refresh") refreshSingleStock(code, button);
  if (action === "edit") openEditStockDialog(code);
  if (action === "delete") deleteSingleStock(code);
}

async function saveEditForm(event) {
  event.preventDefault();
  const code = els.editCode?.value;
  const stock = state.stocks.find((item) => item.code === code);
  if (!stock) return;

  const next = {
    ...stock,
    name: els.editName.value.trim() || stock.name,
    style: els.editStyle.value || "短线观察",
    holdingStatus: els.editHoldingStatus.value || "观察中",
    costPrice: toNumber(els.editCostPrice.value),
    positionPct: toNumber(els.editPositionPct.value),
    stopLoss: toNumber(els.editStopLoss.value) || 0,
    targetPrice: toNumber(els.editTargetPrice.value),
    planDate: els.editPlanDate.value || "",
    watchReason: els.editWatchReason.value.trim(),
    event: els.editEvent.value.trim() || "暂无"
  };

  try {
    await upsertStock(next);
    els.editDialog.close();
    setAddStockStatus(`已更新 ${next.code} ${next.name} 的观察设置。`, "success");
  } catch (error) {
    setAddStockStatus(`观察设置保存失败：${formatFetchError(error)}。`, "error");
  }
}

async function refreshRealData(options = {}) {
  const button = options.button || els.refreshRealDataButton;
  const previousText = button?.textContent || options.defaultText || "刷新真实数据";
  let finalButtonText = "";
  if (button) {
    button.disabled = true;
    button.textContent = options.busyText || "刷新中";
  }
  setAddStockStatus(options.startMessage || "正在逐只刷新真实行情...", "info");
  let success = 0;
  const failed = [];
  try {
    if (!state.stocks.length) {
      state.lastUpdated = new Date();
      render();
      setAddStockStatus(options.emptyMessage || "列表为空，暂无可刷新股票。", "info");
      finalButtonText = options.doneText || "已完成";
      return;
    }
    const targets = state.stocks.map((stock) => ({ ...stock, membershipVersion: getStockMembershipVersion(stock.code) }));
    const operation = startOperationRequest();
    const fetchedByCode = new Map();
    try {
      for (const stock of targets) {
        if (!operation.isCurrent()) return;
        try {
          const fresh = await fetchRealStock(stock.code, {
            style: stock.style,
            stopLoss: stock.stopLoss,
            signal: operation.signal
          });
          fetchedByCode.set(stock.code, { fresh, membershipVersion: stock.membershipVersion });
          success += 1;
        } catch (error) {
          if (!operation.isCurrent()) return;
          failed.push(`${stock.code} ${stock.name || ""}：${formatFetchError(error)}`);
        }
      }
      if (!operation.isCurrent()) return;
      state.stocks = state.stocks.map((latest) => {
        const fetched = fetchedByCode.get(latest.code);
        if (!fetched || getStockMembershipVersion(latest.code) !== fetched.membershipVersion) return latest;
        return normalizeStoredStock(mergeFetchedStock(latest, fetched.fresh));
      });
      state.lastUpdated = new Date();
      render();
      await saveStocks();
      if (!operation.isCurrent()) return;
      const message = options.completeMessage
        ? options.completeMessage(success, targets.length, failed)
        : buildRefreshMessage(success, targets.length, failed, "刷新");
      setAddStockStatus(message, success ? "success" : "error");
      finalButtonText = success ? options.doneText || "已完成" : options.failText || "已重算";
    } finally {
      operation.finish();
    }
  } catch (error) {
    setAddStockStatus(`刷新失败：${formatFetchError(error)}。请检查网络连接，稍后重试。`, "error");
    finalButtonText = options.failText || "失败";
  } finally {
    if (button) {
      button.disabled = false;
      if (finalButtonText) {
        button.textContent = finalButtonText;
        setTimeout(() => {
          button.textContent = previousText;
        }, 1200);
      } else {
        button.textContent = previousText;
      }
    }
  }
}
function formatFetchError(error) {
  const message = error?.message || String(error || "未知错误");
  if (message === "Failed to fetch" || message === "fetch failed") {
    return "无法连接本地服务或行情源请求失败";
  }
  return message;
}

function buildRefreshMessage(success, total, failed, actionName) {
  if (!total) return "列表为空，暂无可分析股票。";
  if (!failed.length) return `已${actionName} ${success}/${total} 只股票。`;
  const sample = failed.slice(0, 2).join("；");
  const suffix = failed.length > 2 ? ` 等 ${failed.length} 只失败` : "";
  if (success) return `已${actionName} ${success}/${total} 只股票；${sample}${suffix}。`;
  return `已重新计算本地提醒，但真实行情刷新失败：${sample}${suffix}。`;
}

function isUsableNumber(value) {
  return hasNumber(value);
}

function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasHistoryMetrics(stock) {
  return [stock.ma5, stock.ma10, stock.ma20, stock.high20, stock.low20, stock.avgVolume20].every(hasNumber);
}

function displayNumber(value, fallback = "暂无") {
  return hasNumber(value) ? formatNumber(value) : fallback;
}

function displayPctValue(value, fallback = "暂无") {
  return hasNumber(value) ? formatPct(value, false) : fallback;
}

function displayRatio(value) {
  return hasNumber(value) ? `${value.toFixed(2)}x` : "暂无";
}

function displayOptionalNumber(value, fallback = "待补充") {
  return isUsableNumber(value) ? formatNumber(value) : fallback;
}

function displayOptionalPct(value, fallback = "待补充") {
  return isUsableNumber(value) ? formatPct(value, false) : fallback;
}

function displayMoney(value, fallback = "暂无") {
  return hasNumber(value) ? formatMoney(value) : fallback;
}

function displayShares(value, fallback = "暂无") {
  return hasNumber(value) ? formatShares(value) : fallback;
}

function renderSourceList(stock) {
  const source = stock.dataSource || {};
  const fetchedAt = source.fetchedAt ? formatDateTime(new Date(source.fetchedAt)) : "暂无";
  const financeUrls = Array.isArray(source.financeUrls) ? source.financeUrls : [];
  const eventUrls = Array.isArray(source.eventUrls) ? source.eventUrls : [];
  const rows = [
    {
      name: "实时行情",
      status: stock.dataStatus?.quote || "missing",
      source: source.quote || "待补充",
      url: source.quoteUrl || "",
      fields: "开高低收、昨收、涨跌、成交量额、换手、量比、PE/PB、市值股本",
      error: source.quoteError || ""
    },
    {
      name: "历史K线",
      status: stock.dataStatus?.history || "missing",
      source: source.history || "待补充",
      url: source.historyUrl || "",
      fields: "均线、20/60日区间、均量均额、区间涨跌、波动率、最大回撤",
      error: source.historyError || ""
    },
    {
      name: "财务摘要",
      status: stock.dataStatus?.finance || "missing",
      source: source.finance || "待补充",
      url: financeUrls.join("\n"),
      fields: "ROE、营收/净利同比、负债率、毛利率、净利率、EPS、营收、净利润",
      error: source.financeError || ""
    },
    {
      name: "公告事件",
      status: stock.dataStatus?.events || "missing",
      source: source.events || "待补充",
      url: eventUrls.join("\n"),
      fields: "减持、问询函、监管风险、财报异常、限售股解禁",
      error: source.eventsError || ""
    },
    {
      name: "本地计算",
      status: "ok",
      source: source.calculation || "本地规则根据行情和K线计算",
      url: "",
      fields: "量比、趋势、风险等级、质量标签、提醒队列"
    }
  ];

  return `<p class="source-time">最近取数：${escapeHtml(fetchedAt)}</p><div class="source-list">${rows.map(renderSourceRow).join("")}</div>`;
}

function renderSourceRow(row) {
  const statusText = row.status === "ok" ? "已获取" : row.status === "partial" ? "部分获取" : "待补充";
  const statusClass = row.status === "ok" ? "ok" : "missing";
  const urlText = row.url ? row.url.split("\n").map((item) => `<span>${escapeHtml(item)}</span>`).join("") : "<span>无</span>";
  const errorText = row.error ? `<p class="source-error">失败原因：${escapeHtml(row.error)}</p>` : "";
  return `<article class="source-row"><div><strong>${escapeHtml(row.name)}</strong><span class="source-pill ${statusClass}">${statusText}</span></div><p>来源：${escapeHtml(row.source)}</p><p>字段：${escapeHtml(row.fields)}</p><div class="source-url">${urlText}</div>${errorText}</article>`;
}

function pct(stock) {
  if (!hasNumber(stock.close) || !hasNumber(stock.prevClose) || stock.prevClose === 0) return null;
  return ((stock.close - stock.prevClose) / stock.prevClose) * 100;
}

function volumeRatio(stock) {
  if (!hasNumber(stock.volume) || !hasNumber(stock.avgVolume20) || stock.avgVolume20 === 0) return null;
  return stock.volume / stock.avgVolume20;
}

function distanceToStop(stock) {
  if (!stock.stopLoss) return Infinity;
  if (!hasNumber(stock.close) || stock.close === 0) return Infinity;
  return ((stock.close - stock.stopLoss) / stock.close) * 100;
}

function positionProfitPct(stock) {
  if (!hasNumber(stock.close) || !hasNumber(stock.costPrice) || stock.costPrice === 0) return null;
  return ((stock.close - stock.costPrice) / stock.costPrice) * 100;
}

function shortTrend(stock) {
  const price = stock.close;
  if (![price, stock.ma5, stock.ma10, stock.ma20].every(hasNumber)) return "unknown";
  if (price > stock.ma5 && stock.ma5 > stock.ma10 && stock.ma10 > stock.ma20) return "strong";
  if (price < stock.ma5 && stock.ma5 < stock.ma10 && stock.ma10 < stock.ma20) return "weak";
  return "neutral";
}

function qualityLevel(stock) {
  if (![stock.roe, stock.profitYoY, stock.revenueYoY, stock.debtRatio].some(hasNumber)) return "待补充";
  let score = 0;
  if (hasNumber(stock.roe) && stock.roe >= 18) score += 2;
  else if (hasNumber(stock.roe) && stock.roe >= 10) score += 1;

  if (hasNumber(stock.profitYoY) && stock.profitYoY >= 15) score += 2;
  else if (hasNumber(stock.profitYoY) && stock.profitYoY >= 0) score += 1;
  else if (hasNumber(stock.profitYoY)) score -= 1;

  if (hasNumber(stock.revenueYoY) && stock.revenueYoY >= 10) score += 1;
  if (hasNumber(stock.debtRatio) && stock.debtRatio <= 45) score += 1;
  if (hasNumber(stock.debtRatio) && stock.debtRatio >= 75) score -= 1;
  if (hasNumber(stock.pe) && stock.pe >= 60) score -= 1;

  if (score >= 4) return "较好";
  if (score >= 2) return "一般";
  return "需谨慎";
}

function riskLevel(stock) {
  let score = 0;
  const move = pct(stock);
  const vol = volumeRatio(stock);
  const stopGap = distanceToStop(stock);

  if (isUsableNumber(move) && move <= -state.thresholds.move) score += 2;
  if (isUsableNumber(vol) && isUsableNumber(move) && vol >= state.thresholds.volume && move < 0) score += 2;
  if (stopGap <= state.thresholds.stop) score += 2;
  if (shortTrend(stock) === "weak") score += 1;
  if (isUsableNumber(stock.profitYoY) && stock.profitYoY < 0) score += 1;
  if (hasNumber(stock.positionPct) && stock.positionPct >= 30 && stopGap <= state.thresholds.stop + 2) score += 1;
  if (hasEventRisk(stock)) score += 1;

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function buildAlerts(stock) {
  const alerts = [];
  const move = pct(stock);
  const vol = volumeRatio(stock);
  const trend = shortTrend(stock);
  const stopGap = distanceToStop(stock);

  if (isUsableNumber(move) && Math.abs(move) >= state.thresholds.move) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: Math.abs(move) >= state.thresholds.move + 2 ? "high" : "medium",
      title: move > 0 ? "涨幅触发提醒" : "跌幅触发提醒",
      detail: `${stock.name} 今日${formatPct(move)}，已超过你设置的 ${state.thresholds.move}% 阈值。`,
      reason: move > 0 ? "短线情绪较强，观察是否追高和是否放量有效。" : "价格快速回落，先确认是否跌破你的交易计划。"
    });
  }

  if (isUsableNumber(vol) && vol >= state.thresholds.volume) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: isUsableNumber(move) && move < 0 ? "high" : "medium",
      title: isUsableNumber(move) && move < 0 ? "放量下跌" : "放量提醒",
      detail: `${stock.name} 当前量比 ${vol.toFixed(2)}x，高于 ${state.thresholds.volume.toFixed(1)}x。`,
      reason: isUsableNumber(move) && move < 0 ? "放量下跌通常需要更谨慎，尤其要看是否靠近止损位。" : "量能明显变化，需要结合价格方向和板块热度继续观察。"
    });
  }

  if (isUsableNumber(stock.close) && isUsableNumber(stock.high20) && stock.close >= stock.high20) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: "medium",
      title: "突破20日高点",
      detail: `${stock.name} 收盘价 ${stock.close} 已不低于20日高点 ${stock.high20}。`,
      reason: "短线资金关注度提高，适合结合成交量与板块热度继续观察。"
    });
  }

  if (isUsableNumber(stock.close) && isUsableNumber(stock.low20) && stock.close <= stock.low20) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: "high",
      title: "跌至20日低位",
      detail: `${stock.name} 收盘价 ${stock.close} 已接近或低于20日低点 ${stock.low20}。`,
      reason: "短线结构偏弱，先确认基本面是否变化，以及是否需要降低仓位风险。"
    });
  }

  if (trend === "weak") {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: "medium",
      title: "均线结构转弱",
      detail: `${stock.name} 当前价格低于5/10/20日均线组合。`,
      reason: "短线趋势偏弱，适合等待企稳信号，避免只因便宜而加仓。"
    });
  }

  if (stopGap <= state.thresholds.stop) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: "high",
      title: "接近止损线",
      detail: `${stock.name} 距离止损价 ${stock.stopLoss} 约 ${stopGap.toFixed(1)}%。`,
      reason: "这是纪律提醒点，建议先回看最初买入理由是否仍成立。"
    });
  }

  const profit = positionProfitPct(stock);
  if ((stock.holdingStatus === "已持有" || stock.holdingStatus === "轻仓" || stock.holdingStatus === "重仓") && hasNumber(profit) && Math.abs(profit) >= state.thresholds.move) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: profit < 0 ? "medium" : "low",
      title: "持仓盈亏偏离",
      detail: `${stock.name} 相对成本价 ${formatNumber(stock.costPrice)} 约 ${formatPct(profit)}。`,
      reason: "这是计划一致性提醒，适合复查买入理由、止损线和仓位是否仍匹配。"
    });
  }

  const eventText = getUsefulEventText(stock.event);
  if (eventText) {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: eventText.includes("不确定") || eventText.includes("压力") ? "medium" : "low",
      title: "事件跟踪",
      detail: eventText,
      reason: "事件本身不等于买卖信号，需要结合价格、成交量和你的持仓周期判断。"
    });
  }

  getAutoEvents(stock).forEach((event) => {
    alerts.push({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      priority: eventPriority(event),
      title: event.title || event.type || "自动事件提醒",
      detail: event.detail,
      reason: event.reason || "该事件来自公开公告或公开数据，需要结合正文和价格承接继续确认。"
    });
  });

  return alerts;
}

function getAlerts() {
  const priorityWeight = { high: 3, medium: 2, low: 1 };
  return state.stocks
    .flatMap(buildAlerts)
    .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority]);
}

function getFilteredStocks() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.stocks;
  return state.stocks.filter((stock) => {
    return [stock.code, stock.name, stock.sector, stock.style]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

function getFilteredAnalysisStocks() {
  const q = state.analysisSearch.trim().toLowerCase();
  if (!q) return state.stocks;
  return state.stocks.filter((stock) => {
    return [stock.code, stock.name, stock.sector, stock.style]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

function render() {
  const alerts = getAlerts();
  const filteredAlerts = state.filter === "all" ? alerts : alerts.filter((alert) => alert.priority === state.filter);
  const strongStocks = state.stocks.filter((stock) => shortTrend(stock) === "strong");
  const riskStocks = state.stocks.filter((stock) => riskLevel(stock) !== "low");

  els.stockCount.textContent = state.stocks.length;
  if (els.stockTableCount) els.stockTableCount.textContent = `${state.stocks.length}只`;
  els.alertCount.textContent = alerts.length;
  els.strongCount.textContent = strongStocks.length;
  els.riskCount.textContent = riskStocks.length;
  els.lastUpdated.textContent = `最近分析：${formatDateTime(state.lastUpdated)}`;
  els.moveThresholdValue.textContent = `${state.thresholds.move}%`;
  els.volumeThresholdValue.textContent = `${state.thresholds.volume.toFixed(1)}x`;
  els.stopThresholdValue.textContent = `${state.thresholds.stop}%`;
  els.dataBadge.textContent = state.stocks.length ? "真实/本地数据" : "空列表";

  renderAlerts(filteredAlerts);
  renderStockTable(getFilteredStocks());
  renderReport(alerts);
  renderPicker(getFilteredAnalysisStocks());
  renderAnalysis();
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    els.alertList.innerHTML = `<div class="empty-state">当前筛选下没有提醒。可以调低阈值，或添加新的自选股。</div>`;
    return;
  }

  els.alertList.innerHTML = alerts
    .slice(0, 12)
    .map((alert) => {
      return `<article class="alert-item ${alert.priority}">
        <div class="stock-identity">
          <strong>${escapeHtml(alert.name)}</strong>
          <span>${escapeHtml(alert.code)} · ${escapeHtml(alert.sector)}</span>
        </div>
        <div>
          <strong>${escapeHtml(alert.title)}</strong>
          <p class="alert-detail">${escapeHtml(alert.detail)}</p>
          <p class="reason-list">${escapeHtml(alert.reason)}</p>
        </div>
        <span class="priority-pill ${alert.priority}">${priorityText(alert.priority)}</span>
      </article>`;
    })
    .join("");
}

function renderStockTable(stocks) {
  if (!stocks.length) {
    els.stockTable.innerHTML = `<tr><td colspan="10">没有匹配的股票。</td></tr>`;
    return;
  }

  els.stockTable.innerHTML = stocks
    .map((stock) => {
      const move = pct(stock);
      const trend = shortTrend(stock);
      const risk = riskLevel(stock);
      return `<tr>
        <td>
          <button class="stock-link" type="button" data-code="${stock.code}">
            ${escapeHtml(stock.name)}
            <span>${escapeHtml(stock.code)}</span>
          </button>
        </td>
        <td>${escapeHtml(stock.sector)}</td>
        <td>${escapeHtml(stock.style)}</td>
        <td>${displayNumber(stock.close)}</td>
        <td class="${moveClass(move)}">${displayPctValue(move)}</td>
        <td>${displayRatio(volumeRatio(stock))}</td>
        <td><span class="status-pill ${trend}">${trendText(trend)}</span></td>
        <td>${qualityLevel(stock)}</td>
        <td><span class="risk-pill ${risk}">${riskText(risk)}</span></td>
        <td>
          <div class="row-actions">
            <button class="mini-button" type="button" data-action="refresh" data-code="${stock.code}">刷新</button>
            <button class="mini-button" type="button" data-action="edit" data-code="${stock.code}">编辑</button>
            <button class="mini-button danger" type="button" data-action="delete" data-code="${stock.code}">删除</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  document.querySelectorAll(".stock-link").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCode = button.dataset.code;
      switchView("analysis");
      render();
    });
  });
}

function renderReport(alerts) {
  els.dailyReport.textContent = buildReport(alerts);
}

function renderPicker(stocks) {
  if (!state.selectedCode || !state.stocks.some((stock) => stock.code === state.selectedCode)) {
    state.selectedCode = state.stocks[0]?.code || null;
  }

  if (!stocks.length) {
    els.stockPickerList.innerHTML = `<div class="empty-state">没有匹配的股票。</div>`;
    return;
  }

  els.stockPickerList.innerHTML = stocks
    .map((stock) => {
      const active = stock.code === state.selectedCode ? " is-active" : "";
      return `<button class="stock-chip${active}" type="button" data-code="${stock.code}">
        <strong>${escapeHtml(stock.name)}</strong>
        <span>${escapeHtml(stock.code)} · ${escapeHtml(stock.sector)}</span>
      </button>`;
    })
    .join("");

  document.querySelectorAll(".stock-chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCode = button.dataset.code;
      render();
    });
  });
}

function renderAnalysis() {
  const stock = state.stocks.find((item) => item.code === state.selectedCode) || state.stocks[0];
  if (!stock) {
    els.analysisCard.innerHTML = `<div class="empty-state">还没有可分析的股票。</div>`;
    return;
  }

  const move = pct(stock);
  const trend = shortTrend(stock);
  const risk = riskLevel(stock);
  const scoreNotes = buildScoreNotes(stock);
  const alerts = buildAlerts(stock);
  const eventText = getUsefulEventText(stock.event);
  const autoEvents = getAutoEvents(stock);
  const autoEventItems = autoEvents.length
    ? autoEvents.slice(0, 4).map((event) => `<li>${escapeHtml(event.title || event.type || "事件提醒")}：${escapeHtml(event.detail)}</li>`).join("")
    : "";

  els.analysisCard.innerHTML = `<div class="analysis-header">
    <div>
      <h2>${escapeHtml(stock.name)}</h2>
      <p class="analysis-meta">${escapeHtml(stock.code)} · ${escapeHtml(stock.sector)} · ${escapeHtml(stock.style)}</p>
      <span class="status-pill ${trend}">${trendText(trend)}</span>
      <span class="risk-pill ${risk}">${riskText(risk)}</span>
      <span class="status-pill neutral">${escapeHtml(stock.holdingStatus || "观察中")}</span>
    </div>
    <div class="analysis-price">
      <strong>${formatNumber(stock.close)}</strong>
      <span class="${moveClass(move)}">${displayPctValue(move)}</span>
    </div>
  </div>

  <div class="analysis-grid">
    <section class="analysis-block">
      <h3>观察计划</h3>
      <ul>
        <li>风格/状态：${escapeHtml(stock.style || "短线观察")} / ${escapeHtml(stock.holdingStatus || "观察中")}</li>
        <li>成本价：${displayNumber(stock.costPrice)}，仓位：${displayOptionalPct(stock.positionPct, "未设置")}</li>
        <li>止损价：${stock.stopLoss ? formatNumber(stock.stopLoss) : "未设置"}，观察价：${displayNumber(stock.targetPrice, "未设置")}</li>
        <li>计划日期：${stock.planDate ? escapeHtml(stock.planDate) : "未设置"}</li>
        <li>观察理由：${escapeHtml(stock.watchReason || "未填写")}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>短线走势</h3>
      <ul>
        <li>5/10/20/60日均线：${displayNumber(stock.ma5)} / ${displayNumber(stock.ma10)} / ${displayNumber(stock.ma20)} / ${displayNumber(stock.ma60)}</li>
        <li>20日区间：${displayNumber(stock.low20)} - ${displayNumber(stock.high20)}</li>
        <li>60日区间：${displayNumber(stock.low60)} - ${displayNumber(stock.high60)}</li>
        <li>成交量：当前量比 ${displayRatio(volumeRatio(stock))}，接口量比 ${displayRatio(stock.quoteVolumeRatio)}</li>
        <li>${shortTrendText(stock)}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>实时行情</h3>
      <ul>
        <li>开/高/低/收：${displayNumber(stock.open)} / ${displayNumber(stock.high)} / ${displayNumber(stock.low)} / ${displayNumber(stock.close)}</li>
        <li>昨收：${displayNumber(stock.prevClose)}，涨跌额：${displayNumber(stock.changeAmount)}</li>
        <li>涨跌幅：${displayPctValue(stock.changePct ?? move)}，振幅：${displayOptionalPct(stock.amplitude, "暂无")}</li>
        <li>换手率：${displayOptionalPct(stock.turnoverRate, "暂无")}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>量价结构</h3>
      <ul>
        <li>成交量：${displayNumber(stock.volume)}，20日均量：${displayNumber(stock.avgVolume20)}</li>
        <li>60日均量：${displayNumber(stock.avgVolume60)}</li>
        <li>成交额：${displayMoney(stock.amount)}，20日均额：${displayMoney(stock.avgAmount20)}</li>
        <li>20/60日均换手：${displayOptionalPct(stock.avgTurnover20, "暂无")} / ${displayOptionalPct(stock.avgTurnover60, "暂无")}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>长期质量</h3>
      <ul>
        <li>ROE：${displayOptionalPct(stock.roe)}，净利同比：${displayOptionalPct(stock.profitYoY)}</li>
        <li>营收同比：${displayOptionalPct(stock.revenueYoY)}，负债率：${displayOptionalPct(stock.debtRatio)}</li>
        <li>毛利率/净利率：${displayOptionalPct(stock.grossMargin)} / ${displayOptionalPct(stock.netMargin)}</li>
        <li>PE/PB：${displayOptionalNumber(stock.pe)} / ${displayOptionalNumber(stock.pb)}</li>
        <li>财报日期：${stock.financeReportDate ? escapeHtml(stock.financeReportDate) : "待补充"}</li>
        <li>质量标签：${qualityLevel(stock)}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>区间表现</h3>
      <ul>
        <li>5/20/60日涨跌：${displayOptionalPct(stock.change5d, "暂无")} / ${displayOptionalPct(stock.change20d, "暂无")} / ${displayOptionalPct(stock.change60d, "暂无")}</li>
        <li>20/60日波动率：${displayOptionalPct(stock.volatility20, "暂无")} / ${displayOptionalPct(stock.volatility60, "暂无")}</li>
        <li>60日最大回撤：${displayOptionalPct(stock.maxDrawdown60, "暂无")}</li>
        <li>60日位置：${rangePositionText(stock.close, stock.low60, stock.high60)}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>估值规模</h3>
      <ul>
        <li>动态/静态PE：${displayOptionalNumber(stock.pe)} / ${displayOptionalNumber(stock.peStatic)}</li>
        <li>PB：${displayOptionalNumber(stock.pb)}</li>
        <li>总市值/流通市值：${displayMoney(stock.marketCap)} / ${displayMoney(stock.floatMarketCap)}</li>
        <li>总股本/流通股本：${displayShares(stock.totalShares)} / ${displayShares(stock.floatShares)}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>财务补充</h3>
      <ul>
        <li>EPS/每股净资产：${displayOptionalNumber(stock.eps)} / ${displayOptionalNumber(stock.bps)}</li>
        <li>每股经营现金流：${displayOptionalNumber(stock.cashFlowPerShare)}</li>
        <li>营收/净利润：${displayMoney(stock.revenue)} / ${displayMoney(stock.netProfit)}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>风险提醒</h3>
      <ul>
        <li>止损价：${stock.stopLoss ? formatNumber(stock.stopLoss) : "未设置"}</li>
        <li>距离止损：${Number.isFinite(distanceToStop(stock)) ? `${distanceToStop(stock).toFixed(1)}%` : "未设置"}</li>
        ${eventText ? `<li>事件：${escapeHtml(eventText)}</li>` : ""}
        ${autoEventItems}
        <li>${riskSuggestion(stock)}</li>
      </ul>
    </section>

    <section class="analysis-block">
      <h3>下一步问题</h3>
      <ul>
        ${scoreNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
      </ul>
    </section>

    <section class="analysis-block source-block">
      <h3>数据来源</h3>
      ${renderSourceList(stock)}
    </section>
  </div>

  <section class="analysis-block" style="margin-top: 12px;">
    <h3>当前触发信号</h3>
    <ul>
      ${(alerts.length ? alerts : [{ title: "暂无强提醒", reason: "继续观察价格、量能、事件和你的交易计划是否匹配。" }])
        .map((alert) => `<li><strong>${escapeHtml(alert.title)}</strong>：${escapeHtml(alert.reason)}</li>`)
        .join("")}
    </ul>
  </section>`;
}

function buildReport(alerts) {
  const high = alerts.filter((alert) => alert.priority === "high");
  const medium = alerts.filter((alert) => alert.priority === "medium");
  const strong = state.stocks.filter((stock) => shortTrend(stock) === "strong");
  const weak = state.stocks.filter((stock) => shortTrend(stock) === "weak");
  const sectorMap = new Map();

  state.stocks.forEach((stock) => {
    const item = sectorMap.get(stock.sector) || { count: 0, validCount: 0, totalMove: 0 };
    const move = pct(stock);
    item.count += 1;
    if (isUsableNumber(move)) {
      item.validCount += 1;
      item.totalMove += move;
    }
    sectorMap.set(stock.sector, item);
  });

  const sectors = Array.from(sectorMap.entries())
    .map(([sector, item]) => ({ sector, avg: item.validCount ? item.totalMove / item.validCount : null, count: item.count, validCount: item.validCount }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  const lines = [
    "研策台｜每日收盘简报",
    `生成时间：${formatDateTime(state.lastUpdated)}`,
    "",
    "一、今日重点提醒",
    ...(high.length ? high.slice(0, 6).map((alert, index) => `${index + 1}. 【高】${alert.name}：${alert.title}。${alert.detail}`) : ["暂无高优先级提醒。"]),
    ...(medium.length ? ["", "二、中优先级观察", ...medium.slice(0, 6).map((alert, index) => `${index + 1}. ${alert.name}：${alert.title}。${alert.reason}`)] : []),
    "",
    "三、短线结构",
    `强势结构：${strong.length ? strong.map((stock) => stock.name).join("、") : "暂无"}`,
    `弱势结构：${weak.length ? weak.map((stock) => stock.name).join("、") : "暂无"}`,
    "",
    "四、板块温度",
    ...sectors.map((item) => `- ${item.sector}：自选内${item.count}只，有效行情${item.validCount}只，平均涨跌幅 ${isUsableNumber(item.avg) ? formatPct(item.avg) : "待补充"}`),
    "",
    "五、复盘问题",
    "1. 今天想操作的股票，理由是价格信号、事件刺激，还是长期逻辑变化？",
    "2. 如果判断错了，止损价和仓位上限是否已经写清楚？",
    "3. 今天的冲动交易信号是什么，能否等到收盘后再确认？",
    "",
    "声明：本简报仅用于个人研究和交易纪律辅助，不构成投资建议。"
  ];

  return lines.join("\n");
}

function buildScoreNotes(stock) {
  const notes = [];
  const trend = shortTrend(stock);
  const move = pct(stock);

  if (trend === "unknown") notes.push("历史K线不足，短线均线、20日区间和量比暂不能作为判断依据。");
  if (qualityLevel(stock) === "待补充") notes.push("财务质量数据待补充，ROE、营收同比、净利同比和负债率暂不能下结论。");
  if (trend === "strong") notes.push("短线结构偏强，但要确认是不是板块共振，而不是孤立拉升。");
  if (trend === "weak") notes.push("短线结构偏弱，先问自己是否有明确的反转信号再行动。");
  if (isUsableNumber(move) && Math.abs(move) >= state.thresholds.move) notes.push("今日波动较大，不适合只凭情绪立刻提高仓位。");
  if (qualityLevel(stock) === "较好") notes.push("长期质量指标相对健康，可以继续跟踪估值和增长是否匹配。");
  if (qualityLevel(stock) === "需谨慎") notes.push("基本面质量或增长指标偏弱，长期持有前需要更严格的理由。");
  if (isUsableNumber(stock.pe) && stock.pe >= 50) notes.push("估值较高，后续业绩若不兑现，股价波动可能被放大。");
  if (distanceToStop(stock) <= state.thresholds.stop) notes.push("价格接近止损线，优先执行交易纪律，而不是临时改计划。");
  if (!stock.watchReason) notes.push("观察理由还没写，建议补一句你跟踪它的核心原因，避免后续只看涨跌。 ");
  if ((stock.holdingStatus === "已持有" || stock.holdingStatus === "重仓") && !hasNumber(stock.costPrice)) notes.push("已标记持有但未填写成本价，盈亏和纪律提醒会不完整。");

  return notes.slice(0, 4).length ? notes.slice(0, 4) : ["当前没有极端信号，按你的短线或长期计划继续观察。"];
}

function shortTrendText(stock) {
  const trend = shortTrend(stock);
  if (trend === "unknown") return "历史K线不足，暂无法判断均线结构。";
  if (trend === "strong") return "价格位于均线组合上方，短线结构偏强。";
  if (trend === "weak") return "价格低于均线组合，短线结构偏弱。";
  return "均线结构不够一致，短线方向仍需确认。";
}

function riskSuggestion(stock) {
  const risk = riskLevel(stock);
  if (!hasHistoryMetrics(stock)) return "历史K线不足，均线、量比和20日区间暂不能作为风险判断依据。";
  if (qualityLevel(stock) === "待补充") return "财务数据待补充，长期质量暂不能下结论。";
  if (risk === "high") return "建议优先检查止损、仓位和买入理由是否仍成立。";
  if (risk === "medium") return "建议继续观察成交量和关键价位，不急着放大仓位。";
  return "当前风险信号不强，但仍需按计划记录交易理由。";
}

function toNumber(value) {
  const text = String(value ?? "").replace(/%/g, "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function switchView(view) {
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("is-active", section.id === `${view}View`);
  });
}

function downloadFile(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatPct(value, showSign = true) {
  if (!hasNumber(value)) return "暂无";
  const prefix = showSign && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function formatNumber(value) {
  if (!hasNumber(value)) return "暂无";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMoney(value) {
  if (!hasNumber(value)) return "暂无";
  const abs = Math.abs(value);
  if (abs >= 100000000) return `${(value / 100000000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}亿`;
  if (abs >= 10000) return `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}万`;
  return formatNumber(value);
}

function formatShares(value) {
  if (!hasNumber(value)) return "暂无";
  const abs = Math.abs(value);
  if (abs >= 100000000) return `${(value / 100000000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}亿股`;
  if (abs >= 10000) return `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}万股`;
  return `${formatNumber(value)}股`;
}

function rangePositionText(close, low, high) {
  if (!hasNumber(close) || !hasNumber(low) || !hasNumber(high) || high === low) return "暂无";
  const position = ((close - low) / (high - low)) * 100;
  return `${Math.max(0, Math.min(100, position)).toFixed(1)}%`;
}

function moveClass(value) {
  if (!hasNumber(value)) return "flat";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

function trendText(trend) {
  return { strong: "强", neutral: "中性", weak: "弱", unknown: "暂无" }[trend];
}

function riskText(risk) {
  return { high: "高", medium: "中", low: "低" }[risk];
}

function priorityText(priority) {
  return { high: "高优先级", medium: "中优先级", low: "低优先级" }[priority];
}

function formatDateTime(date) {
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showGlobalTooltip(target) {
  const tooltip = els.globalTooltip;
  const text = target?.dataset.help || target?.getAttribute("title") || "";
  if (!tooltip || !target || !text) return;
  tooltip.textContent = text;
  tooltip.hidden = false;
  tooltip.classList.add("is-visible");

  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 12;
  let left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  let top = targetRect.bottom + 8;

  if (left < margin) left = margin;
  if (left + tooltipRect.width > window.innerWidth - margin) {
    left = window.innerWidth - tooltipRect.width - margin;
  }
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = Math.max(margin, targetRect.top - tooltipRect.height - 8);
  }

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideGlobalTooltip() {
  const tooltip = els.globalTooltip;
  if (!tooltip) return;
  tooltip.classList.remove("is-visible");
  tooltip.hidden = true;
}

function bindHelpTips() {
  document.querySelectorAll(".help-tip").forEach((tip) => {
    const text = tip.getAttribute("title") || tip.dataset.help || "";
    if (text) {
      tip.dataset.help = text;
      tip.setAttribute("aria-label", text);
      tip.removeAttribute("title");
    }
    tip.setAttribute("tabindex", "0");
    tip.addEventListener("mouseenter", () => showGlobalTooltip(tip));
    tip.addEventListener("focus", () => showGlobalTooltip(tip));
    tip.addEventListener("mouseleave", hideGlobalTooltip);
    tip.addEventListener("blur", hideGlobalTooltip);
  });
  window.addEventListener("scroll", hideGlobalTooltip, true);
  window.addEventListener("resize", hideGlobalTooltip);
}

function bindEvents() {
  bindHelpTips();

  const closeHelp = () => els.helpDialog?.close();
  els.helpButton?.addEventListener("click", () => els.helpDialog?.showModal());
  els.helpCloseButton?.addEventListener("click", closeHelp);
  els.helpDoneButton?.addEventListener("click", closeHelp);
  els.helpDialog?.addEventListener("click", (event) => {
    if (event.target === els.helpDialog) closeHelp();
  });

  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.moveThreshold.addEventListener("input", () => {
    state.thresholds.move = Number(els.moveThreshold.value);
    render();
  });

  els.volumeThreshold.addEventListener("input", () => {
    state.thresholds.volume = Number(els.volumeThreshold.value);
    render();
  });

  els.stopThreshold.addEventListener("input", () => {
    state.thresholds.stop = Number(els.stopThreshold.value);
    render();
  });

  els.signalFilter.addEventListener("change", () => {
    state.filter = els.signalFilter.value;
    render();
  });

  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value;
    renderStockTable(getFilteredStocks());
  });

  els.stockTable?.addEventListener("click", handleStockRowAction);

  els.editForm?.addEventListener("submit", saveEditForm);
  els.editCancelButton?.addEventListener("click", () => els.editDialog?.close());
  document.querySelector("[data-close-edit]")?.addEventListener("click", () => els.editDialog?.close());
  els.editDialog?.addEventListener("click", (event) => {
    if (event.target === els.editDialog) els.editDialog.close();
  });

  els.analysisSearch.addEventListener("input", () => {
    state.analysisSearch = els.analysisSearch.value;
    renderPicker(getFilteredAnalysisStocks());
  });

  els.refreshButton.addEventListener("click", () => {
    refreshRealData({
      button: els.refreshButton,
      busyText: "分析中",
      doneText: "已完成",
      failText: "已重算",
      startMessage: "正在刷新真实数据并重新分析提醒队列...",
      emptyMessage: "列表为空，暂无可分析股票。",
      completeMessage: (success, total, failed) => buildRefreshMessage(success, total, failed, "重新分析")
    });
  });

  els.addStockButton?.addEventListener("click", addStockFromForm);

  els.addStockCode?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addStockFromForm();
  });

  els.refreshRealDataButton?.addEventListener("click", refreshRealData);

  els.copyReportButton.addEventListener("click", async () => {
    const report = buildReport(getAlerts());
    try {
      await navigator.clipboard.writeText(report);
      els.copyReportButton.textContent = "已复制";
      setTimeout(() => {
        els.copyReportButton.textContent = "复制简报";
      }, 1200);
    } catch {
      alert("复制失败，可以在简报页手动选择文本复制。");
    }
  });

  els.downloadReportButton.addEventListener("click", () => {
    downloadFile("研策台-每日简报.txt", buildReport(getAlerts()));
  });

  els.exportButton.addEventListener("click", async () => {
    await stockSaveQueue;
    const backup = await LocalDataStore.createBackup({ llmConfig: window.getLocalLlmConfig?.() || null });
    downloadFile(`研策台-本地备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), "application/json");
  });

  els.backupImportInput?.addEventListener("change", async () => {
    const file = els.backupImportInput.files?.[0];
    if (!file) return;
    try {
      invalidatePendingOperations();
      await stockSaveQueue;
      const restored = await LocalDataStore.restoreBackup(JSON.parse(await file.text()));
      state.stocks = restored.stocks.map(normalizeStoredStock);
      state.selectedCode = state.stocks[0]?.code || null;
      state.lastUpdated = new Date();
      if (restored.llmConfig && window.restoreLocalLlmConfig) {
        window.restoreLocalLlmConfig(restored.llmConfig);
      }
      window.dispatchEvent(new CustomEvent("yancetai:backup-restored", { detail: restored }));
      render();
      alert(`已恢复 ${state.stocks.length} 只股票和本地 AI 报告。`);
    } catch (error) {
      alert(error.message || "导入本地备份失败。");
    } finally {
      els.backupImportInput.value = "";
    }
  });

  els.resetButton.addEventListener("click", async () => {
    try {
      invalidatePendingOperations();
      await stockSaveQueue;
      await LocalDataStore.clearAll();
      localStorage.removeItem("aStockAgentStocks");
      state.stocks = [];
      state.selectedCode = null;
      state.lastUpdated = new Date();
      window.dispatchEvent(new CustomEvent("yancetai:local-data-cleared"));
      render();
    } catch (error) {
      alert(error.message || "清空本地数据失败。");
    }
  });
}

async function initializeApplication() {
  await initializeLocalStocks();
  bindEvents();
  switchView("overview");
  render();
  window.dispatchEvent(new CustomEvent("yancetai:app-ready"));
}

initializeApplication();
