const LocalDataStore = (() => {
  const DB_NAME = "yancetai-local-data";
  const DB_VERSION = 1;
  const STORE_NAME = "records";
  const STOCKS_KEY = "stocks";
  const INSIGHTS_KEY = "stockInsights";
  const DAILY_BRIEF_KEY = "dailyBrief";
  let mutationQueue = Promise.resolve();

  function queueMutation(task) {
    const operation = mutationQueue.then(task);
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开浏览器本地数据库。"));
    });
  }

  async function read(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => {
        db.close();
        reject(request.error || new Error("读取浏览器本地数据失败。"));
      };
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => db.close();
      transaction.onabort = () => db.close();
    });
  }

  async function write(key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(value, key);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      const fail = () => {
        db.close();
        reject(transaction.error || new Error("保存浏览器本地数据失败。"));
      };
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  }

  async function loadStocks() {
    const stocks = await read(STOCKS_KEY);
    return Array.isArray(stocks) ? stocks : null;
  }

  async function saveStocks(stocks) {
    await write(STOCKS_KEY, Array.isArray(stocks) ? stocks : []);
  }

  async function loadStockInsights() {
    const insights = await read(INSIGHTS_KEY);
    return insights && typeof insights === "object" ? insights : {};
  }

  function saveStockInsight(key, text) {
    return queueMutation(async () => {
      const insights = await loadStockInsights();
      insights[key] = {
        text: String(text || ""),
        updatedAt: new Date().toISOString()
      };
      await write(INSIGHTS_KEY, insights);
    });
  }

  function replaceStockInsights(insights) {
    return queueMutation(() => write(INSIGHTS_KEY, insights && typeof insights === "object" ? insights : {}));
  }

  async function loadDailyBrief() {
    const brief = await read(DAILY_BRIEF_KEY);
    return brief && typeof brief === "object" ? brief : null;
  }

  function saveDailyBrief(text) {
    return queueMutation(() => write(DAILY_BRIEF_KEY, { text: String(text || ""), updatedAt: new Date().toISOString() }));
  }

  function replaceCoreData({ stocks, stockInsights, dailyBrief }) {
    return queueMutation(async () => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.put(Array.isArray(stocks) ? stocks : [], STOCKS_KEY);
        store.put(stockInsights && typeof stockInsights === "object" ? stockInsights : {}, INSIGHTS_KEY);
        if (dailyBrief?.text) store.put(dailyBrief, DAILY_BRIEF_KEY);
        else store.delete(DAILY_BRIEF_KEY);
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error || new Error("替换浏览器本地数据失败。"));
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error || new Error("替换浏览器本地数据失败。"));
        };
      });
    });
  }

  function clearAll() {
    return replaceCoreData({ stocks: [], stockInsights: {}, dailyBrief: null });
  }

  async function createBackup({ llmConfig = null } = {}) {
    return {
      format: "yancetai-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      stocks: (await loadStocks()) || [],
      stockInsights: await loadStockInsights(),
      dailyBrief: await loadDailyBrief(),
      llmConfig: llmConfig ? { ...llmConfig, apiKey: "" } : null
    };
  }

  async function restoreBackup(backup) {
    if (!backup || backup.format !== "yancetai-backup" || backup.version !== 1) {
      throw new Error("不是有效的研策台备份文件。" );
    }
    if (!Array.isArray(backup.stocks)) {
      throw new Error("备份文件缺少股票数据。" );
    }
    await replaceCoreData({
      stocks: backup.stocks,
      stockInsights: backup.stockInsights || {},
      dailyBrief: backup.dailyBrief || null
    });
    return {
      stocks: backup.stocks,
      stockInsights: backup.stockInsights || {},
      dailyBrief: backup.dailyBrief || null,
      llmConfig: backup.llmConfig || null
    };
  }

  return {
    loadStocks,
    saveStocks,
    loadStockInsights,
    saveStockInsight,
    replaceStockInsights,
    loadDailyBrief,
    saveDailyBrief,
    clearAll,
    createBackup,
    restoreBackup
  };
})();

window.LocalDataStore = LocalDataStore;
