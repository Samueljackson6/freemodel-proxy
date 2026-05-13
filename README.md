# FreeModel Proxy Server

高性能 FreeModel API 代理服务，支持 Chat Completions 到 Responses API 的转换。

## 功能特性

### 高可靠
- ✅ **请求重试** - 自动重试失败请求（指数退避）
- ✅ **超时处理** - 防止请求长时间挂起
- ✅ **健康检查** - 自动检测上游 API 状态
- ✅ **错误处理** - 完善的错误信息和日志

### 高可用
- ✅ **监控页面** - 实时监控服务状态
- ✅ **优雅降级** - 上游不可用时返回明确错误
- ✅ **进程守护** - systemd service 配置
- ✅ **自动重启** - 崩溃后自动恢复

### 高效率
- ✅ **连接池** - HTTP 连接复用
- ✅ **响应缓存** - 相同请求缓存结果
- ✅ **批量写入** - SQLite 批量写入优化
- ✅ **模型缓存** - 模型列表缓存

### 低资源
- ✅ **请求限流** - 防止过载
- ✅ **资源限制** - 内存和 CPU 限制
- ✅ **内存优化** - 缓存大小限制

## 快速开始

### 安装

```bash
cd freemodel-proxy
npm install
```

### 配置

```bash
# 复制配置文件
cp .env.example .env

# 编辑配置
nano .env
```

最小配置：
```bash
FREEMODEL_KEY=your_api_key_here
```

### 启动

```bash
# 开发模式
npm run dev

# 生产模式
npm start
```

### Systemd Deployment

```bash
# Prepare local secrets. Do not commit .env.
cp .env.example .env
nano .env  # set FREEMODEL_KEY and PROXY_API_KEY

# Install/update service.
sudo ./deploy.sh

# Check status.
sudo systemctl status freemodel-proxy
```

## 使用方法

### OpenAI 兼容 API

```bash
# 设置代理 URL
export OPENAI_API_BASE=http://localhost:38080/v1

# 使用任意 OpenAI SDK
python -c "
from openai import OpenAI
client = OpenAI(base_url='http://localhost:38080/v1')
response = client.chat.completions.create(
    model='gpt-3.5-turbo',
    messages=[{'role': 'user', 'content': 'Hello!'}]
)
print(response.choices[0].message.content)
"
```

### cURL 测试

```bash
# 聊天补全
curl -X POST http://localhost:38080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 获取模型列表
curl http://localhost:38080/v1/models
```

## 监控

### 监控页面

访问 `http://localhost:38080/monitor` 查看实时监控面板：

- 服务状态
- 请求统计（成功率、延迟）
- Token 用量
- 模型列表
- 最近请求

### API 端点

| 端点 | 说明 |
|------|------|
| `GET /monitor` | 监控页面 |
| `GET /monitor/health` | 健康检查 |
| `GET /monitor/status` | 服务状态 |
| `GET /monitor/stats` | 统计数据 |
| `GET /monitor/requests` | 请求列表 |

### 健康检查

```bash
curl http://localhost:38080/monitor/health
```

响应示例：
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "checks": {
    "database": { "status": "ok" },
    "upstream": { "status": "ok", "latency_ms": 150 }
  }
}
```

## 配置参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FREEMODEL_KEY` | - | FreeModel API Key（必需） |
| `PORT` | 38080 | 监听端口 |
| `MAX_RETRIES` | 3 | 最大重试次数 |
| `RETRY_DELAY_MS` | 1000 | 重试延迟基数 |
| `REQUEST_TIMEOUT_MS` | 60000 | 请求超时 |
| `MAX_SOCKETS` | 50 | 最大连接数 |
| `MODELS_CACHE_TTL` | 300000 | 模型缓存时间 |
| `CACHE_MAX_SIZE` | 100 | 响应缓存大小 |
| `RATE_LIMIT_MAX` | 100 | 限流阈值 |

## 测试

```bash
# 运行测试
npm test

# 或指定代理 URL
PROXY_URL=http://localhost:38080 npm test
```

## 架构

```
┌─────────────────┐
│   Client App    │
└────────┬────────┘
         │ OpenAI API
         ▼
┌─────────────────┐
│  FreeModel      │
│  Proxy Server   │
│                 │
│  ┌───────────┐  │
│  │ Rate      │  │
│  │ Limiter   │  │
│  └─────┬─────┘  │
│        ▼        │
│  ┌───────────┐  │
│  │ Response  │  │
│  │ Cache     │  │
│  └─────┬─────┘  │
│        ▼        │
│  ┌───────────┐  │
│  │ Retry     │  │
│  │ Handler   │  │
│  └─────┬─────┘  │
│        ▼        │
│  ┌───────────┐  │
│  │ Connection│  │
│  │ Pool      │  │
│  └─────┬─────┘  │
└────────┼────────┘
         │
         ▼
┌─────────────────┐
│  FreeModel API  │
└─────────────────┘
```

## License

MIT


## Access Control

Set `PROXY_API_KEY` or comma-separated `PROXY_API_KEYS` in `.env` to protect `/v1/*` and `/monitor/*`. API clients should send `Authorization: Bearer <token>`. Browser access to `/monitor` uses Basic auth; any username is accepted and the token is the password. Local `/monitor/health` remains available for service checks unless `PUBLIC_HEALTHCHECK=true` exposes it more broadly.

Docker deployments should persist SQLite with `DB_PATH=/app/data/proxy_stats.db`.
