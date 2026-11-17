const { _test } = require("./agent-server");

function relativeDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const recentAnnouncementDate = relativeDate(-2);
const upcomingUnlockDate = relativeDate(6);

const finance = _test.extractFinanceFromResponse({
  result: {
    data: [
      {
        SECURITY_CODE: "600519",
        REPORT_DATE: "2025-12-31 00:00:00",
        WEIGHTAVG_ROE: "31.25",
        TOTAL_OPERATE_INCOME_YOY: "12.3",
        TOTAL_OPERATE_INCOME: "1648.7",
        PARENT_NETPROFIT_YOY: "15.6",
        PARENT_NETPROFIT: "856.3",
        DEBT_ASSET_RATIO: "18.9",
        PE_TTM: "28.5",
        PB: "8.1",
        INDUSTRY_NAME: "酿酒行业"
      }
    ]
  }
}, "mock");

const klines = _test.parseEastMoneyKlines([
  "2026-06-15,10,10.5,10.8,9.9,123456,0,0,0,0,0",
  "2026-06-16,10.5,10.7,10.9,10.2,222222,0,0,0,0,0"
]);

const tencentKlines = _test.parseTencentKlines([
  ["2026-06-15", "10", "10.5", "10.8", "9.9", "123456", "12345678"],
  ["2026-06-16", "10.5", "10.7", "10.9", "10.2", "222222", "23456789"]
]);

const mergedQuote = _test.mergeQuote(
  { code: "600519", name: "贵州茅台", close: 10, high: 10.5, tradeTime: "2026-06-16 14:30:00", source: "源A", sourceUrl: "https://a.example" },
  { close: 10.8, high: 11, low: 9, volume: 1000, tradeTime: "2026-06-16 15:00:00", source: "源B", sourceUrl: "https://b.example" }
);

const historyBaseline = _test.historyBaselineBeforeQuote([
  { date: "2026-06-15", close: 10 },
  { date: "2026-06-16", close: 10.8 }
], "2026-06-16 15:00:00");
const relevantSearchNews = _test.isRelevantNewsItem({ title: "贵州茅台发布经营公告", summary: "" }, "600519", "贵州茅台");
const irrelevantSearchNews = _test.isRelevantNewsItem({ title: "其他公司发布经营公告", summary: "" }, "600519", "贵州茅台");

const announcementEvents = _test.classifyAnnouncementEvents([
  { title: "关于持股5%以上股东减持股份计划的公告", date: recentAnnouncementDate, source: "mock", url: "https://example.com/a" },
  { title: "关于收到上海证券交易所问询函的公告", date: recentAnnouncementDate, source: "mock", url: "https://example.com/b" }
]);

const unlockEvents = _test.classifyUnlockEvents([
  { date: upcomingUnlockDate, ratio: 6.5, shares: 123456789, marketCap: 987654321, source: "mock" }
]);

const financeEvents = _test.classifyFinanceEvents({
  source: "mock-finance",
  sourceUrls: ["https://example.com/finance"],
  reportDate: "2026-03-31",
  profitYoY: -35.2,
  revenueYoY: -5.5,
  debtRatio: 82
});

const eventSignals = _test.buildEventSignals({
  announcements: [
    { title: "关于持股5%以上股东减持股份计划的公告", date: recentAnnouncementDate, source: "mock", url: "https://example.com/a" }
  ],
  unlocks: [{ date: upcomingUnlockDate, ratio: 6.5, shares: 123456789, marketCap: 987654321, source: "mock" }],
  source: "mock-disclosure",
  sourceUrls: ["https://example.com/disclosure"],
  status: "ok",
  errors: []
}, { source: "mock-finance", reportDate: "2026-03-31", profitYoY: -35.2, sourceUrls: ["https://example.com/finance"] });

const newsRow = _test.normalizeNewsRow({
  title: "<em>贵州茅台</em>发布最新经营动态",
  showTime: "2026-06-18 09:30:00",
  source: "东方财富网",
  summary: "公司披露经营相关信息，需结合公告正文确认。",
  url: "https://example.com/news"
}, { source: "mock-news", code: "600519", name: "贵州茅台" });

const dedupedNews = _test.dedupeNewsItems([
  newsRow,
  { ...newsRow },
  { ...newsRow, title: "贵州茅台另一条新闻" }
]);

if (finance.roe !== 31.25 || finance.revenueYoY !== 12.3 || finance.profitYoY !== 15.6 || finance.debtRatio !== 18.9) {
  throw new Error(`Unexpected finance parse: ${JSON.stringify(finance)}`);
}

if (finance.revenue !== 1648.7 || finance.netProfit !== 856.3) {
  throw new Error(`Unexpected finance amount parse: ${JSON.stringify(finance)}`);
}

if (finance.reportDate !== "2025-12-31" || finance.sector !== "酿酒行业") {
  throw new Error(`Unexpected finance metadata: ${JSON.stringify(finance)}`);
}

if (klines.length !== 2 || klines[0].close !== 10.5 || klines[1].volume !== 22222200) {
  throw new Error(`Unexpected kline parse: ${JSON.stringify(klines)}`);
}

if (tencentKlines.length !== 2 || tencentKlines[0].amount !== 12345678 || tencentKlines[1].high !== 10.9 || tencentKlines[0].volume !== 12345600) {
  throw new Error(`Unexpected Tencent kline parse: ${JSON.stringify(tencentKlines)}`);
}

if (mergedQuote.close !== 10.8 || mergedQuote.high !== 11 || mergedQuote.tradeTime !== "2026-06-16 15:00:00" || mergedQuote.source !== "源A + 源B" || mergedQuote.sourceUrls.length !== 2) {
  throw new Error(`Unexpected quote merge: ${JSON.stringify(mergedQuote)}`);
}

const threeWayQuote = _test.mergeQuote(mergedQuote, {
  close: 11,
  source: "源C",
  sourceUrl: "https://c.example",
  tradeTime: "2026-06-16 15:10:00"
});
if (threeWayQuote.sources.length !== 3 || threeWayQuote.source !== "源A + 源B + 源C") {
  throw new Error(`Unexpected multi-source quote merge: ${JSON.stringify(threeWayQuote.sources)}`);
}

if (_test.quoteTimeValue("20260616150000") <= _test.quoteTimeValue("2026-06-16 14:30:00")) {
  throw new Error("Unexpected quote time normalization");
}

const unlockRow = _test.normalizeUnlockRow({
  SECURITY_NAME_ABBR: "示例股份",
  FREE_DATE: "2026-06-22 00:00:00",
  CURRENT_FREE_SHARES: 1060.031,
  FREE_RATIO: 0.3197,
  LIFT_MARKET_CAP: 59700.94592
});
if (unlockRow.date !== "2026-06-22" || unlockRow.ratio !== 31.97 || unlockRow.shares !== 10600310 || unlockRow.marketCap !== 597009459.2) {
  throw new Error(`Unexpected unlock row normalization: ${JSON.stringify(unlockRow)}`);
}

if (historyBaseline.length !== 1 || historyBaseline[0].date !== "2026-06-15") {
  throw new Error(`Unexpected history baseline: ${JSON.stringify(historyBaseline)}`);
}

if (!relevantSearchNews || irrelevantSearchNews) {
  throw new Error("Unexpected news relevance filtering");
}

if (announcementEvents.length !== 2 || !announcementEvents.some((event) => event.type === "减持") || !announcementEvents.some((event) => event.type === "问询函")) {
  throw new Error(`Unexpected announcement events: ${JSON.stringify(announcementEvents)}`);
}

if (unlockEvents.length !== 1 || unlockEvents[0].type !== "解禁压力" || unlockEvents[0].priority !== "high") {
  throw new Error(`Unexpected unlock events: ${JSON.stringify(unlockEvents)}`);
}

if (financeEvents.length !== 1 || financeEvents[0].type !== "财报异常" || financeEvents[0].priority !== "high") {
  throw new Error(`Unexpected finance events: ${JSON.stringify(financeEvents)}`);
}

// 轻微同比下滑不该生成提醒；银行等高杠杆行业的负债率不参与判断。
const mildDeclineEvents = _test.classifyFinanceEvents({ reportDate: "2026-09-30", profitYoY: -0.25, revenueYoY: 1.9, debtRatio: 20 });
if (mildDeclineEvents.length !== 0) {
  throw new Error(`Unexpected mild decline events: ${JSON.stringify(mildDeclineEvents)}`);
}

const bankFinanceEvents = _test.classifyFinanceEvents({ sector: "银行Ⅱ", reportDate: "2026-09-30", profitYoY: 2.2, revenueYoY: 2.4, debtRatio: 91.5 });
if (bankFinanceEvents.length !== 0) {
  throw new Error(`Unexpected bank finance events: ${JSON.stringify(bankFinanceEvents)}`);
}

if (eventSignals.items.length < 3 || eventSignals.status !== "ok") {
  throw new Error(`Unexpected event signals: ${JSON.stringify(eventSignals)}`);
}

if (newsRow.title !== "贵州茅台发布最新经营动态" || newsRow.date !== "2026-06-18" || newsRow.source !== "东方财富网") {
  throw new Error(`Unexpected news row: ${JSON.stringify(newsRow)}`);
}

if (dedupedNews.length !== 2) {
  throw new Error(`Unexpected news dedupe: ${JSON.stringify(dedupedNews)}`);
}

console.log(JSON.stringify({ finance, klineCount: klines.length, tencentKlineCount: tencentKlines.length, eventSignalCount: eventSignals.items.length, newsCount: dedupedNews.length }));
