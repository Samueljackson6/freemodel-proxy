# FreeModel Proxy Server

将 FreeModel Responses API 转换为 OpenAI Chat Completions API 兼容格式。

## 功能

- ✅ Chat Completions API 代理
- ✅ 流式响应 (SSE) 支持
- ✅ 自动格式转换
- ✅ 请求统计和监控
- ✅ Token 用量追踪
- ✅ 错误日志记录
- ✅ 动态模型列表（从 FreeModel API 获取）

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 FREEMODEL_KEY
```

### 2. 本地运行

```bash
cd freemodel-proxy
npm install
npm start
```

服务启动后：
- **API 端点**: http://localhost:38080/v1
- **监控面板**: http://localhost:38080/monitor

### Docker 部署

```bash
# 创建 .env 文件
cp .env.example .env
# 编辑 .env 填入 FREEMODEL_KEY

docker-compose up -d
```

### Systemd 服务

```bash
# 创建环境配置
sudo mkdir -p /etc/systemd/system/freemodel-proxy.service.d
cat <<EOF | sudo tee /etc/systemd/system/freemodel-proxy.service.d/override.conf
[Service]
Environment=FREEMODEL_KEY=your_key_here
EOF

# 安装服务
sudo cp freemodel-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable freemodel-proxy
sudo systemctl start freemodel-proxy

# 查看状态
sudo systemctl status freemodel-proxy
```

## 使用方式

### 非流式请求

```bash
curl http://localhost:38080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 流式请求

```bash
curl http://localhost:38080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 列出模型

```bash
curl http://localhost:38080/v1/models
```

### OpenAI SDK 兼容

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:38080/v1',
  apiKey: 'any'  // 代理不需要 API key
});

const response = await client.chat.completions.create({
  model: 'gpt-5.5',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## 监控端点

| 端点 | 说明 |
|------|------|
| `/monitor` | 监控面板 (HTML) |
| `/monitor/status` | 服务状态 (JSON) |
| `/monitor/stats` | 请求统计 (JSON) |
| `/monitor/requests` | 最近请求列表 (JSON) |

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `FREEMODEL_KEY` | ✅ 是 | - | FreeModel API Key |
| `PORT` | 否 | 38080 | 服务端口 |

⚠️ **重要**: `FREEMODEL_KEY` 是必需的环境变量，服务启动时会检查，未设置则退出。

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   OpenAI SDK    │────▶│  FreeModel Proxy │────▶│  FreeModel API  │
│                 │     │                  │     │                 │
│ Chat Completions│     │  Format Convert  │     │  Responses API  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │   SQLite DB  │
                        │   (Stats)    │
                        └──────────────┘
```

## API 转换逻辑

### 请求转换

```javascript
// Chat Completions 格式
{
  "model": "gpt-5.5",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}

// ↓ 转换为 Responses API 格式 ↓

{
  "model": "gpt-5.5",
  "input": "user: Hello"
}
```

### 响应转换

```javascript
// Responses API 格式
{
  "output": [{
    "content": [{"text": "Hi!"}]
  }],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5
  }
}

// ↓ 转换为 Chat Completions 格式 ↓

{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "model": "gpt-5.5",
  "choices": [{
    "message": {"role": "assistant", "content": "Hi!"}
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

## 文件结构

```
freemodel-proxy/
├── server.js           # 主服务
├── package.json        # 依赖配置
├── Dockerfile          # Docker 镜像
├── docker-compose.yml  # Docker Compose
├── freemodel-proxy.service  # Systemd 服务
├── proxy_stats.db      # SQLite 数据库 (自动创建)
└── README.md           # 本文档
```
