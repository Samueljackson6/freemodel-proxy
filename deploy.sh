#!/bin/bash

# FreeModel Proxy 部署脚本
# 用于生产环境部署

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="freemodel-proxy"

echo "=========================================="
echo "FreeModel Proxy 部署脚本"
echo "=========================================="

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
   echo "需要 root 权限，请使用 sudo 运行此脚本"
   exit 1
fi

# 检查 .env 文件
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    echo "错误: .env 文件不存在"
    echo "请复制 .env.example 为 .env 并配置 FREEMODEL_KEY"
    exit 1
fi

# 检查 FREEMODEL_KEY
set -a
source "$SCRIPT_DIR/.env"
set +a
if [[ -z "$FREEMODEL_KEY" ]]; then
    echo "ERROR: FREEMODEL_KEY is not set"
    exit 1
fi
if [[ "${REQUIRE_PROXY_AUTH:-true}" != "false" && -z "$PROXY_API_KEY" && -z "$PROXY_API_KEYS" ]]; then
    echo "ERROR: proxy auth is enabled but PROXY_API_KEY/PROXY_API_KEYS is not set"
    exit 1
fi
chmod 600 "$SCRIPT_DIR/.env"

echo ""
echo ">>> 安装依赖..."
cd "$SCRIPT_DIR"
npm install --production

# 复制 service 文件
echo ""
echo ">>> 安装 systemd 服务..."
cp "$SCRIPT_DIR/freemodel-proxy.service" /etc/systemd/system/

# 创建配置覆盖
mkdir -p /etc/systemd/system/freemodel-proxy.service.d/
rm -f /etc/systemd/system/freemodel-proxy.service.d/override.conf

systemctl daemon-reload

# 启用并启动服务
echo ""
echo ">>> 启动服务..."
systemctl enable freemodel-proxy
systemctl restart freemodel-proxy

# 等待服务启动
sleep 3

# 检查状态
echo ""
echo ">>> 服务状态:"
systemctl status freemodel-proxy --no-pager

# 测试健康检查
echo ""
echo ">>> 健康检查:"
curl -s http://localhost:38080/monitor/health | jq .

echo ""
echo "=========================================="
echo "✅ 部署完成!"
echo ""
echo "监控页面: http://localhost:38080/monitor"
echo "健康检查: http://localhost:38080/monitor/health"
echo ""
echo "管理命令:"
echo "  查看状态: sudo systemctl status freemodel-proxy"
echo "  查看日志: sudo journalctl -u freemodel-proxy -f"
echo "  重启服务: sudo systemctl restart freemodel-proxy"
echo "  停止服务: sudo systemctl stop freemodel-proxy"
echo "=========================================="
