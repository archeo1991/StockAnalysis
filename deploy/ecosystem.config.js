// pm2 进程配置：只在服务器上被 pm2 读取，本地不需要安装 pm2。
//
// 目录约定（由 deploy/bootstrap-server.sh 创建）：
//   /srv/apps/stockanalysis/releases/<release>/  每次发布一个完整版本
//   /srv/apps/stockanalysis/current -> releases/… 软链，发布时原子切换
//   /srv/apps/stockanalysis/shared/env.json      密钥等运行时配置，不进 git
//
// 密钥来源：shared/env.json（JSON）或 shared/.env（KEY=VALUE），任选其一；都不存在时
// agent-server.js 会退回内置默认值，站点仍可运行，只是没有服务端 API Key。
const fs = require("node:fs");
const path = require("node:path");

const APP_DIR = "/srv/apps/stockanalysis";
const SHARED_DIR = path.join(APP_DIR, "shared");
const CURRENT_DIR = path.join(APP_DIR, "current");

function toEnvObject(source) {
  const env = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === null || value === undefined || value === "") continue;
    // pm2 的环境变量必须是字符串，env.json 里写成数字也能用
    env[key] = String(value);
  }
  return env;
}

function loadSharedEnv() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, "env.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return toEnvObject(parsed);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.warn(`[pm2] shared/env.json 解析失败，已忽略：${error.message}`);
    }
  }

  try {
    const text = fs.readFileSync(path.join(SHARED_DIR, ".env"), "utf8");
    const env = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return toEnvObject(env);
  } catch {
    return {};
  }
}

module.exports = {
  apps: [
    {
      name: "stockanalysis",
      cwd: CURRENT_DIR,
      script: "agent-server.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      // 日志留在服务器上，排错用：pm2 logs stockanalysis
      error_file: path.join(APP_DIR, "shared", "error.log"),
      out_file: path.join(APP_DIR, "shared", "out.log"),
      env: Object.assign(
        {
          NODE_ENV: "production",
          // 只监听回环地址，外部一律经由 Nginx 进入
          AGENT_PORT: "8787",
          // PUBLIC_BASE_PATH="/" 会被归一化为空串，表示站点部署在域名根路径。
          // 如果改成 https://archeo.cn/StockAnalysis 这种子目录，这里要同步改成 /StockAnalysis。
          PUBLIC_BASE_PATH: "/"
        },
        loadSharedEnv()
      )
    }
  ]
};
