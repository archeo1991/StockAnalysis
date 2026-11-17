#Requires -Version 5.1
<#
.SYNOPSIS
    研策台 一键发布到腾讯云。

.DESCRIPTION
    流程：检查工作区 → 确认 HEAD 等于 origin/main → 本地校验 → git archive 打包 →
    上传到 releases/<时间戳>-<sha>/ → 切换 current 软链 → pm2 重载 → 校验 /api/health 的
    commit → 失败自动回滚 → 清理旧版本。

    为什么用 git archive：服务器上解开的正好是某个 commit 的内容，和 GitHub 一一对应，
    不会再出现“服务器上跑着没进 commit 的改动”这种漂移。

    为什么用 releases + 软链：切换是原子的，没有“先清空再上传”的空白窗口，
    回滚只需要把软链指回上一个目录。

.PARAMETER SshHost
    本机 ~/.ssh/config 里的主机别名（见 deploy/ssh-config.example），默认 archeo-stock。

.PARAMETER AppDir
    服务器上的应用目录，默认 /srv/apps/stockanalysis。

.PARAMETER Domain
    用来做发布后校验的域名，默认 stock.archeo.cn。

.PARAMETER KeepReleases
    保留最近几个版本用于回滚，默认 5，传 0 表示不清理。

.EXAMPLE
    .\deploy\deploy.ps1

.EXAMPLE
    # 只做本地检查，不上传
    .\deploy\deploy.ps1 -WhatIfOnly

.EXAMPLE
    .\deploy\deploy.ps1 -WithNetworkTests
#>
[CmdletBinding()]
param(
    [string]$SshHost = "archeo-stock",
    [string]$AppDir = "/srv/apps/stockanalysis",
    [string]$Domain = "stock.archeo.cn",
    [ValidateSet("https", "http")][string]$HealthScheme = "https",
    [int]$KeepReleases = 5,
    [switch]$WhatIfOnly,
    [switch]$WithNetworkTests,
    [switch]$AllowDirty,
    [switch]$SkipRemoteValidation
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "    ..  $Text" -ForegroundColor DarkGray }
function Fail { param([string]$Text) throw "发布中止：$Text" }

# 执行外部命令，非 0 退出码立即中止
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$ArgList
    )
    & $Exe @ArgList
    if ($LASTEXITCODE -ne 0) {
        Fail "命令失败（exit $LASTEXITCODE）：$Exe $($ArgList -join ' ')"
    }
}

$tarPath = $null
$jsonPath = $null
$prevRelease = ""
$pushed = $false

try {
    # ---------------------------------------------------------------- 1/8
    Write-Step "1/8 检查工作区"
    $repoRoot = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0) { Fail "当前目录不是 git 仓库" }
    $repoRoot = $repoRoot.Trim()
    Push-Location $repoRoot
    $pushed = $true

    $porcelain = @(& git status --porcelain)
    if ($porcelain.Count -gt 0) {
        & git status --short | Out-Host
        if (-not $AllowDirty) {
            Fail "工作区有未提交改动。先分批提交（见 deploy/DEPLOY.md 附录），或加 -AllowDirty 只发布已提交的 HEAD。"
        }
        Write-Note "已允许脏工作区，但只会发布 HEAD 里已提交的内容"
    }
    else {
        Write-Ok "工作区干净"
    }

    # ---------------------------------------------------------------- 2/8
    Write-Step "2/8 确认 HEAD 与 GitHub 一致"
    Invoke-Native git @("fetch", "origin", "main", "--quiet")
    $sha = (& git rev-parse HEAD).Trim()
    $short = (& git rev-parse --short HEAD).Trim()
    $remoteSha = (& git rev-parse --verify "origin/main" 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $remoteSha) {
        Fail "找不到 origin/main，先执行 git push -u origin main"
    }
    $remoteSha = $remoteSha.Trim()
    if ($sha -ne $remoteSha) {
        Fail "本地 HEAD ($short) 与 origin/main ($($remoteSha.Substring(0, 7))) 不一致，先 git push，保证服务器上跑的就是 GitHub 上的代码"
    }
    Write-Ok "HEAD $short 等于 origin/main"

    # ---------------------------------------------------------------- 3/8
    Write-Step "3/8 本地校验"
    Invoke-Native node @("--check", "agent-server.js")
    Invoke-Native node @("test-finance-parser.js")
    if ($WithNetworkTests) {
        Invoke-Native node @("test-agent-server.js")
        Invoke-Native node @("test-stock-api.js")
    }
    else {
        Write-Note "跳过联网集成测试（加 -WithNetworkTests 执行）"
    }
    Write-Ok "校验通过"

    # ---------------------------------------------------------------- 4/8
    Write-Step "4/8 打包 HEAD"
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $releaseName = "release-$stamp-$short"
    $remoteRelease = "$AppDir/releases/$releaseName"
    $tarPath = Join-Path $env:TEMP "stockanalysis-$sha.tar"
    $jsonPath = Join-Path $env:TEMP "stockanalysis-$sha.build-info.json"

    Invoke-Native git @("archive", "--format=tar", "-o", $tarPath, "HEAD")

    $buildInfo = [ordered]@{
        commit      = $sha
        shortCommit = $short
        release     = $releaseName
        deployedAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($jsonPath, ($buildInfo | ConvertTo-Json -Compress), $utf8NoBom)

    $sizeKb = [math]::Round((Get-Item $tarPath).Length / 1KB, 1)
    Write-Ok "已打包 $sizeKb KB -> $releaseName"

    if ($WhatIfOnly) {
        Write-Step "仅检查模式：跳过上传"
        return
    }

    # ---------------------------------------------------------------- 5/8
    Write-Step "5/8 上传到 $SshHost"
    Invoke-Native ssh @($SshHost, "mkdir -p '$remoteRelease'")
    Invoke-Native scp @("-q", $tarPath, "${SshHost}:$remoteRelease.tar")
    Invoke-Native scp @("-q", $jsonPath, "${SshHost}:$remoteRelease/build-info.json")
    Invoke-Native ssh @($SshHost, "tar -xf '$remoteRelease.tar' -C '$remoteRelease' && rm -f '$remoteRelease.tar' && chmod -R a+rX '$remoteRelease'")
    Write-Ok "已解包 $remoteRelease"

    # ---------------------------------------------------------------- 6/8
    Write-Step "6/8 切换 current 并重载 pm2"
    $prevRelease = (& ssh $SshHost "if [ -L '$AppDir/current' ]; then readlink -f '$AppDir/current'; fi" | Out-String).Trim()
    if ($prevRelease) { Write-Note "上一个版本：$($prevRelease.Split('/')[-1])" }
    else { Write-Note "首次发布，没有可回滚的旧版本" }

    Invoke-Native ssh @($SshHost, "ln -sfn '$remoteRelease' '$AppDir/current'")
    Invoke-Native ssh @($SshHost, "pm2 startOrReload '$AppDir/current/deploy/ecosystem.config.js' --update-env --silent")
    Write-Ok "pm2 已重载"

    # ---------------------------------------------------------------- 7/8
    Write-Step "7/8 校验线上版本"
    if ($SkipRemoteValidation) {
        Write-Note "已按参数跳过域名健康校验；请从服务器本机或有 DNS 的环境核验 build.commit"
    }
    else {
        $healthUrl = "${HealthScheme}://$Domain/api/health"
        $deadline = (Get-Date).AddSeconds(45)
        $liveCommit = ""
        while ((Get-Date) -lt $deadline) {
            try {
                $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
                $liveCommit = [string]$health.build.commit
                if ($liveCommit -eq $sha) { break }
                Write-Note "等待新进程生效（线上 commit=$liveCommit）"
            }
            catch {
                Write-Note "健康检查失败：$($_.Exception.Message)"
            }
            Start-Sleep -Seconds 3
        }

        if ($liveCommit -ne $sha) {
            if ($prevRelease) {
                Write-Host "`n    线上 commit 是 '$liveCommit'，期望 $short" -ForegroundColor Red
                Write-Note "开始回滚到 $($prevRelease.Split('/')[-1])"
                & ssh $SshHost "ln -sfn '$prevRelease' '$AppDir/current'" | Out-Host
                & ssh $SshHost "pm2 startOrReload '$AppDir/current/deploy/ecosystem.config.js' --update-env --silent" | Out-Host
                Fail "发布校验失败，已回滚到上一版本"
            }
            # 首次发布没有可回滚的版本，而且域名/证书可能还没就绪，这里不判失败。
            Write-Host "`n    !! 未能通过 $healthUrl 确认版本（多为首次发布、或域名与证书还没配好）" -ForegroundColor Yellow
            Write-Note "代码已经切换并重启，请手动核对：Invoke-RestMethod $healthUrl | Select-Object -ExpandProperty build"
            Write-Note "首次发布请先用 -HealthScheme http 或直接访问 http://$Domain 验证，再申请证书"
        }
        else {
            Write-Ok "线上 commit=$short"
        }
    }

    # ---------------------------------------------------------------- 8/8
    Write-Step "8/8 抽查行情接口并清理旧版本"
    try {
        $stock = Invoke-RestMethod -Uri "${HealthScheme}://$Domain/api/stock?code=600519" -TimeoutSec 40
        $price = $stock.stock.market.price
        if ($null -eq $price -or "$price" -eq "") {
            Write-Note "行情为空：可能是非交易时段，或服务器出口 IP 被上游限流（见 README「云端常见问题」）"
        }
        else {
            Write-Ok "600519 现价 $price"
        }
    }
    catch {
        Write-Note "行情抽查失败：$($_.Exception.Message)（不影响代码发布，但要排查第三方数据可达性）"
    }

    if ($KeepReleases -gt 0) {
        # tail -n +6 表示从第 6 个开始删除，即保留最近 5 个版本目录（含当前版本）
        $from = $KeepReleases + 1
        Invoke-Native ssh @($SshHost, "cd '$AppDir/releases' && ls -1dt release-*/ 2>/dev/null | tail -n +$from | xargs -r rm -rf")
        Write-Note "仅保留最近 $KeepReleases 个版本"
    }

    Write-Host "`n发布完成：${HealthScheme}://$Domain  （commit $short）" -ForegroundColor Green
}
finally {
    if ($tarPath -and (Test-Path -LiteralPath $tarPath)) { Remove-Item -LiteralPath $tarPath -Force -ErrorAction SilentlyContinue }
    if ($jsonPath -and (Test-Path -LiteralPath $jsonPath)) { Remove-Item -LiteralPath $jsonPath -Force -ErrorAction SilentlyContinue }
    if ($pushed) { Pop-Location -ErrorAction SilentlyContinue }
}
