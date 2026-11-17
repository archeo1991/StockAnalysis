#!/usr/bin/env bash
# 首次初始化腾讯云服务器（只需要跑一次）。在服务器上以 root 执行：
#
#   scp deploy/bootstrap-server.sh archeo-stock:/root/bootstrap-server.sh
#   ssh archeo-stock "bash /root/bootstrap-server.sh"
#
# 它会做的事：装 Node + pm2、建目录、设置开机自启。
# Nginx 站点配置和证书不在这个脚本里，见 deploy/DEPLOY.md 第 3 步。
set -euo pipefail

APP_DIR=/srv/apps/stockanalysis
SERVICE_NAME=stockanalysis

[ "$(id -u)" -eq 0 ] || { echo "请用 root 执行" >&2; exit 1; }

echo "==> 1/5 系统包"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync nginx >/dev/null

echo "==> 2/5 Node.js"
NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
    echo "    已安装：$(node -v)"
else
    [ -z "$NODE_MAJOR" ] || echo "    当前 Node $(node -v)，升级到 Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    echo "    已安装：$(node -v)"
fi

echo "==> 3/5 pm2"
if command -v pm2 >/dev/null 2>&1; then
    echo "    已安装：$(pm2 -v)"
else
    npm install -g pm2 >/dev/null
    echo "    已安装：$(pm2 -v)"
fi

echo "==> 4/5 目录结构"
mkdir -p "$APP_DIR/releases" "$APP_DIR/shared"
# releases 里的文件由 root 解包，Nginx 以 www-data 读取；这里只保证父目录可遍历，
# 每个版本目录内的权限由发布脚本的 chmod -R a+rX 兜底。
chmod 755 "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/shared"
echo "    $APP_DIR/{releases,shared} 就绪"

echo "==> 5/5 pm2 开机自启"
if ! systemctl -q is-enabled pm2-root >/dev/null 2>&1; then
    pm2 startup systemd -u root --hp /root >/dev/null
    echo "    已写入 pm2-root.service"
fi
pm2 save >/dev/null 2>&1 || true

cat <<'TIPS'

初始化完成。接下来：
  1. 把 deploy/nginx-stock.archeo.cn.conf 放到 /etc/nginx/sites-available/ 并启用
  2. 在本机执行 deploy/deploy.ps1 发布第一个版本
  3. 站点 HTTP 能打开后，在服务器执行 certbot --nginx -d stock.archeo.cn
TIPS
