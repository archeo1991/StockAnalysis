# 研策台 发布指引（腾讯云自托管）

这份文档替换旧《其他项目部署到腾讯云操作指引》里“更新项目”的部分。
旧指引面向“构建出 `dist/` 再 `scp` 覆盖 `/var/www`”的纯静态站，**本项目的流程不一样**，原因见文末对照表。

一条命令发布：

```powershell
.\deploy\deploy.ps1
```

---

## 目录

1. [为什么不能用旧的静态上传流程](#1-为什么不能用旧的静态上传流程)
2. [服务器上的目录结构](#2-服务器上的目录结构)
3. [一次性准备（只做一次）](#3-一次性准备只做一次)
4. [日常发布](#4-日常发布)
5. [回滚](#5-回滚)
6. [发布后校验](#6-发布后校验)
7. [排错](#7-排错)
8. [密钥与安全](#8-密钥与安全)
9. [附录：先把现有改动分批发上 GitHub](#9-附录先把现有改动分批发上-github)
10. [附录：旧流程 vs 新流程对照](#10-附录旧流程-vs-新流程对照)

---

## 1. 为什么不能用旧的静态上传流程

| | 旧指引假设 | 本项目实际 |
|---|---|---|
| 构建产物 | `npm run build` 产出 `dist/` | **没有 `package.json`，没有构建步骤**，`index.html` + `src/` 直接可用 |
| 服务端 | Nginx 直接托管静态文件 | `/api/stock`、`/api/llm`、`/api/brief-context`、`/api/health` **必须由 `agent-server.js` 常驻进程处理** |
| 上传方式 | 先 `rm -rf` 清空，再 `scp` 全量覆盖 | 有空白窗口、不能回滚、每次全量 |

如果照旧指引把文件丢进 `/var/www/xxx` 并且只配静态站点：

- `/api/*` 会 404，或被 `try_files ... /index.html` 重写成 HTML，前端 `JSON.parse` 直接报错；
- `js/css` 上的 `expires 30d; immutable` 会锁住旧 JS，发版后用户看到新旧混搭。

所以本项目的形态是：**Nginx 托管静态文件 + 反代 `/api/` 到 pm2 里的 Node 进程**。
配置见 `deploy/nginx-stock.archeo.cn.conf`。

---

## 2. 服务器上的目录结构

```text
/srv/apps/stockanalysis/
├── releases/
│   ├── release-20261117-204312-a1b2c3d/   ← 每个版本一个完整目录，内容 = 某个 commit
│   └── release-20261118-091500-e4f5a6b/
├── current -> releases/release-20261118-091500-e4f5a6b   ← 软链，发布时原子切换
└── shared/
    ├── env.json      ← 运行时配置/密钥，不进 git
    ├── out.log
    └── error.log
```

- **发布** = 新目录解包完，再 `ln -sfn` 切换 `current`，切换瞬间生效。
- **回滚** = 把 `current` 指回上一个目录，再 `pm2` 重载。
- 服务器上不存 `.git`，也不存 `node_modules`（本项目零依赖）。

---

## 3. 一次性准备（只做一次）

### 3.1 本机：换一把专用部署密钥

旧指引里的临时 key（`codex_temp_deploy_key_20260730*`）已经以明文路径写进文档，建议作废并换新的：

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\stockanalysis_deploy" -C "deploy@stockanalysis" -N '""'
```

把公钥加到服务器：

```powershell
type "$env:USERPROFILE\.ssh\stockanalysis_deploy.pub" | ssh root@106.54.229.135 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

撤销旧 key（在服务器上执行）：

```bash
sed -i '/codex-temp-deploy-20260730/d' ~/.ssh/authorized_keys
```

### 3.2 本机：配置 SSH 别名

把 `deploy/ssh-config.example` 的内容追加到 `~/.ssh/config`：

```powershell
Get-Content .\deploy\ssh-config.example | Add-Content "$env:USERPROFILE\.ssh\config"
ssh archeo-stock "hostname"     # 首次连接确认指纹
```

之后所有命令都是 `ssh archeo-stock ...` / `scp ... archeo-stock:...`，
不用再重复 `-i D:\... -o UserKnownHostsFile=D:\...` 那一长串。

### 3.3 服务器：装环境、建目录

```powershell
scp .\deploy\bootstrap-server.sh archeo-stock:/root/bootstrap-server.sh
ssh archeo-stock "bash /root/bootstrap-server.sh"
```

脚本会装 Node 22 + pm2、建 `releases/` 和 `shared/`、写入 pm2 开机自启。

### 3.4 DNS 与安全组

- 腾讯云 DNSPod 加一条 A 记录：`stock` → `106.54.229.135`
- 腾讯云安全组放行 80 / 443

```powershell
Resolve-DnsName stock.archeo.cn -Type A    # 应返回 106.54.229.135
```

### 3.5 Nginx 站点 + 证书

```powershell
scp .\deploy\nginx-stock.archeo.cn.conf archeo-stock:/etc/nginx/sites-available/stock.archeo.cn
ssh archeo-stock "ln -sfn /etc/nginx/sites-available/stock.archeo.cn /etc/nginx/sites-enabled/stock.archeo.cn && nginx -t && systemctl reload nginx"
```

先发布一次（见第 4 节），确认 `http://stock.archeo.cn` 能打开，再申请证书。
首次发布时 443 还不存在，用 HTTP 做版本校验：

```powershell
.\deploy\deploy.ps1 -HealthScheme http
```

```powershell
ssh archeo-stock "certbot --nginx -d stock.archeo.cn --non-interactive --agree-tos --register-unsafely-without-email --redirect"
```

> 证书要在站点已启用之后申请，否则 certbot 找不到对应的 server 块。

---

## 4. 日常发布

```powershell
git add <改动的文件>
git commit -m "feat(ui): 首页提醒卡片分组"
git push

.\deploy\deploy.ps1
```

`deploy.ps1` 依次做 8 件事，任何一步失败都会立刻停下：

| 步骤 | 做了什么 | 失败会怎样 |
|---|---|---|
| 1 检查工作区 | 有未提交改动就中止 | 避免发布“一半提交”的状态 |
| 2 对齐 GitHub | 要求 `HEAD == origin/main` | 避免服务器跑着没进 GitHub 的代码 |
| 3 本地校验 | `node --check`、`test-finance-parser.js`（联网测试需 `-WithNetworkTests`） | 语法/解析器坏了不上服务器 |
| 4 打包 | `git archive HEAD`，只含已提交内容 | — |
| 5 上传 | 解包到 `releases/<时间戳>-<sha>/` | 旧版本仍在服务，不受影响 |
| 6 切换 | 写 `build-info.json`、`ln -sfn current`、`pm2 startOrReload` | 旧版本仍在服务 |
| 7 校验 | 轮询 `/api/health` 的 `build.commit` 是否等于本次 sha | **自动回滚**到上一版本（首次发布没有旧版本时只告警，因为此时证书可能还没就绪） |
| 8 收尾 | 抽查 `/api/stock?code=600519`、只保留最近 5 个版本 | 只提示，不影响已发布版本 |

常用参数：

```powershell
.\deploy\deploy.ps1 -WhatIfOnly            # 只做本地检查，不上传
.\deploy\deploy.ps1 -WithNetworkTests      # 额外跑联网集成测试
.\deploy\deploy.ps1 -KeepReleases 10       # 多留几个版本
.\deploy\deploy.ps1 -HealthScheme http     # 首次发布、证书还没下来时用 HTTP 校验
.\deploy\deploy.ps1 -Domain stock.archeo.cn
```

如果 PowerShell 因为执行策略拒绝运行脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1
```

---

## 5. 回滚

自动回滚只在第 7 步校验失败时触发。手动回滚：

```powershell
# 看有哪些版本
ssh archeo-stock "ls -1t /srv/apps/stockanalysis/releases"

# 切回指定版本
ssh archeo-stock "ln -sfn /srv/apps/stockanalysis/releases/release-20261117-204312-a1b2c3d /srv/apps/stockanalysis/current && pm2 startOrReload /srv/apps/stockanalysis/current/deploy/ecosystem.config.js --update-env"

# 确认
Invoke-RestMethod https://stock.archeo.cn/api/health | Select-Object -ExpandProperty build
```

回滚只是切软链，不需要重新上传，几秒钟完成。

---

## 6. 发布后校验

```powershell
# 1. 线上跑的是哪个 commit
Invoke-RestMethod https://stock.archeo.cn/api/health | Select-Object -ExpandProperty build

# 2. 接口真的通（不只是首页 200）
Invoke-RestMethod "https://stock.archeo.cn/api/stock?code=600519" | Select-Object -ExpandProperty stock |
    Select-Object code, name, @{ n = "price"; e = { $_.market.price } }

# 3. 进程状态与日志
ssh archeo-stock "pm2 status; pm2 logs stockanalysis --lines 30 --nostream"
```

`/api/health` 返回的 `build` 字段由部署脚本写入：

```json
{
  "ok": true,
  "serverConfigured": false,
  "build": {
    "commit": "a1b2c3d4...",
    "shortCommit": "a1b2c3d",
    "release": "release-20261117-204312-a1b2c3d",
    "deployedAt": "2026-11-17T12:43:20Z"
  },
  "defaults": { "...": "..." }
}
```

> 只判断首页 HTTP 200 是不够的：静态站回退到 `index.html` 也会 200，旧版本也 200。
> 只有 `build.commit` 能证明“新代码真的在跑”。

---

## 7. 排错

| 现象 | 排查 |
|---|---|
| `ssh: Could not resolve hostname archeo-stock` | `~/.ssh/config` 没写好；或改用 `-SshHost root@106.54.229.135`（会绕过别名，不推荐长期用） |
| 卡住不动，提示 host key | 先在终端手动执行一次 `ssh archeo-stock` 确认指纹 |
| 第 7 步一直显示“等待新进程生效” | `ssh archeo-stock "pm2 logs stockanalysis --lines 50 --nostream"`；多半是启动时报错 |
| 第 7 步连不上 `/api/health` | Nginx 没配 `/api/` 反代，或 443 证书没下来；先用 `http://` 直连 80 试 |
| 页面能开但所有数据为空 | `/api/stock` 没转发到 Node；`curl -s http://127.0.0.1:8787/api/stock?code=600519` 在服务器上对照 |
| 行业一直“待补充” | 服务器出口 IP 被东方财富限流，属已知问题，见 README「云端常见问题」 |
| 提示“请求过于频繁” | Nginx 没用 `$remote_addr` **覆盖** `X-Forwarded-For`，导致所有人共享一个 IP 配额 |
| 发版后页面还是旧的 | `js/css` 被长缓存了；确认用的是 `deploy/nginx-stock.archeo.cn.conf` 里的 `no-cache` 规则 |
| `ln -sfn` 后仍是旧代码 | pm2 没重载：`pm2 describe stockanalysis` 看 `cwd` 指向哪个 release |

---

## 8. 密钥与安全

### 8.1 部署密钥

- 一把专用 ed25519，只用于这台服务器的部署。
- 想进一步收紧，可以在服务器的 `~/.ssh/authorized_keys` 给这把 key 加限制：

  ```text
  from="你的宽IP/32",no-pty,no-port-forwarding,no-agent-forwarding,command="/root/deploy-only.sh" ssh-ed25519 AAAA... deploy@stockanalysis
  ```

  加了 `command=` 之后这把 key 只能跑那一个脚本，不能开交互 shell。需要更细的按次授权时再加。

### 8.2 运行时配置 `shared/env.json`

只需要放**调参**，不放用户在页面上配置的模型 key：

```json
{
  "LLM_TIMEOUT_MS": "45000",
  "NEWS_TIMEOUT_MS": "9000",
  "STOCK_RATE_LIMIT_MAX": "30",
  "LLM_RATE_LIMIT_MAX": "20",
  "BRIEF_CONTEXT_RATE_LIMIT_MAX": "6"
}
```

> **注意**：按当前实现，环境里的 `LLM_API_KEY` / `DEEPSEEK_API_KEY` **只影响 `/api/health` 里
> `serverConfigured` 的显示状态**；`/api/llm` 仍然要求请求体自带 API Key。
> 也就是说用户还是在页面右上角「大模型配置」里填 key，密钥存在各自浏览器的 localStorage。
> 不要以为在服务器配了 key 用户就不用填了。

改完 `env.json` 后：

```powershell
ssh archeo-stock "pm2 startOrReload /srv/apps/stockanalysis/current/deploy/ecosystem.config.js --update-env"
```

### 8.3 不要提交的东西

`.gitignore` 已覆盖 `.env*`、`*.key`、`*.pem`、`.deepseek-key`、`.vercel`、`build-info.json`。
`deploy/` 里的脚本**不含**任何密钥——密钥路径都走 `~/.ssh/config`。

---

## 9. 附录：先把现有改动分批发上 GitHub

当前工作区有 12 个修改 + 2 个删除还没提交。建议按“能单独回滚”的粒度分组，而不是 `git add .` 一把梭：

```powershell
git config core.quotepath false      # 中文文件名不再显示成 \346\210...
git status --short
git diff --stat
```

按区域分三组提交（先 `git diff` 确认每组内容一致再提交）：

```powershell
# 1) 服务端：接口、限流、取数逻辑
git add agent-server.js api test-finance-parser.js test-agent-server.js
git commit -m "fix(api): 更新行情与简报接口实现"

# 2) 前端：页面、样式、本地存储、LLM 调用
git add index.html src
git commit -m "feat(ui): 更新看板交互与本地数据"

# 3) 配套：启动脚本、文档
git add StartAgent.bat 打开看板.bat README.md AGENTS.md vercel.json
git commit -m "chore: 更新启动脚本与说明文档"

git push
```

然后把本次发布相关的新增一起提交：

```powershell
git add deploy .gitignore .vercelignore test-agent-server.js agent-server.js
git commit -m "chore(deploy): 增加腾讯云一键发布脚本与版本校验"
git push
git tag -a v1.0.0 -m "首个自托管版本" && git push --tags
```

> 注意：`git status` 里 `OpenDashboard.bat` 和 `我的自选股看板-UI说明.md` 是删除，
> `打开看板.bat` 是新增——这属于同一次重命名，放进第 3 组一起提交即可。
> 中文文件名在 git 里容易产生转义噪音，以后新增的脚本/文档尽量用英文名。

---

## 10. 附录：旧流程 vs 新流程对照

| 环节 | 旧指引 | 现在 |
|---|---|---|
| 构建 | `npm run build` → `dist/` | 无构建，`git archive` 直接打包 HEAD |
| 上传 | `find ... -exec rm -rf {} +` 再 `scp -r dist/*` | `scp` 一个 tar 到新 release 目录再解包 |
| 停机 | 清空到上传完成之间页面是空的 | 无，软链切换瞬间生效 |
| 回滚 | 无（旧文件已删） | 切软链，秒级 |
| 一致性 | 服务器内容取决于本机目录有什么 | 服务器内容 = 某个 commit，可复现 |
| 校验 | 只看首页 `StatusCode` | 比对 `/api/health` 的 `build.commit` |
| 缓存 | `js/css` 30 天 `immutable` | 未加哈希的资源 `no-cache` 回源校验 |
| 接口 | 未涉及 | Nginx 反代 `/api/`，并覆盖 `X-Forwarded-For` |
| 密钥 | 明文写在文档里的 `-i` 路径 | `~/.ssh/config` 别名 + 专用 key |
| 命令长度 | 每条 150+ 字符 | `ssh archeo-stock "..."` / `.\deploy\deploy.ps1` |
