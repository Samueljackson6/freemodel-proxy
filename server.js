const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 38080;
const FREEMODEL_API = 'https://api.freemodel.dev/v1';
const FREEMODEL_KEY = process.env.FREEMODEL_KEY;

// ============ 配置 ============
const CONFIG = {
  // 重试配置
  retry: {
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 1000,
    retryableStatusCodes: [429, 500, 502, 503, 504]
  },
  // 超时配置
  timeout: {
    requestMs: parseInt(process.env.REQUEST_TIMEOUT_MS) || 60000,
    connectMs: parseInt(process.env.CONNECT_TIMEOUT_MS) || 10000
  },
  // 连接池配置
  pool: {
    maxSockets: parseInt(process.env.MAX_SOCKETS) || 50,
    maxFreeSockets: parseInt(process.env.MAX_FREE_SOCKETS) || 10,
    keepAliveMsecs: 30000
  },
  // 缓存配置
  cache: {
    modelsTTL: parseInt(process.env.MODELS_CACHE_TTL) || 300000, // 5分钟
    maxSize: parseInt(process.env.CACHE_MAX_SIZE) || 100
  },
  // 限流配置
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX) || 100
  },
  // 监控配置
  monitor: {
    refreshInterval: parseInt(process.env.MONITOR_REFRESH_MS) || 5000
  },
  storage: {
    dbPath: process.env.DB_PATH || path.join(process.env.DATA_DIR || __dirname, 'proxy_stats.db')
  },
  security: {
    apiKeys: [
      process.env.PROXY_API_KEY,
      ...(process.env.PROXY_API_KEYS || '').split(',')
    ].map(key => (key || '').trim()).filter(Boolean),
    requireAuth: (process.env.REQUIRE_PROXY_AUTH || '').toLowerCase() !== 'false',
    publicHealthcheck: (process.env.PUBLIC_HEALTHCHECK || '').toLowerCase() === 'true',
    trustProxy: (process.env.TRUST_PROXY || '').toLowerCase() === 'true'
  }
};

app.set('trust proxy', CONFIG.security.trustProxy);

if (!FREEMODEL_KEY) {
  console.error('ERROR: FREEMODEL_KEY environment variable is required');
  process.exit(1);
}

if (CONFIG.security.requireAuth && CONFIG.security.apiKeys.length === 0) {
  console.warn('WARNING: proxy authentication is disabled because PROXY_API_KEY/PROXY_API_KEYS is not configured');
}

// ============ HTTP Agent 连接池 ============
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: CONFIG.pool.maxSockets,
  maxFreeSockets: CONFIG.pool.maxFreeSockets,
  keepAliveMsecs: CONFIG.pool.keepAliveMsecs
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: CONFIG.pool.maxSockets,
  maxFreeSockets: CONFIG.pool.maxFreeSockets,
  keepAliveMsecs: CONFIG.pool.keepAliveMsecs
});

// ============ 缓存 ============
const cache = {
  models: { data: null, updatedAt: 0 },
  responses: new Map()
};

// ============ 数据库 ============
fs.mkdirSync(path.dirname(CONFIG.storage.dbPath), { recursive: true });
const db = new Database(CONFIG.storage.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    request_id TEXT,
    model TEXT,
    endpoint TEXT,
    success INTEGER,
    latency_ms INTEGER,
    tokens_input INTEGER,
    tokens_output INTEGER,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp);
  CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
  CREATE INDEX IF NOT EXISTS idx_success ON requests(success);
`);

// 批量写入队列
const logQueue = [];
let flushInterval = null;

function startBatchWriter() {
  flushInterval = setInterval(() => {
    flushLogQueue();
  }, 1000); // 每秒批量写入一次
}

function flushLogQueue() {
  if (logQueue.length === 0) return;

  const items = logQueue.splice(0, logQueue.length);
  const stmt = db.prepare(`
    INSERT INTO requests (request_id, model, endpoint, success, latency_ms, tokens_input, tokens_output, error_message, retry_count)
    VALUES (?, ?, '/v1/chat/completions', ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run(...row);
    }
  });

  try {
    insertMany(items);
  } catch (e) {
    console.error('Batch write failed:', e);
  }
}

function logRequest(requestId, model, success, latencyMs, tokensInput, tokensOutput, errorMessage, retryCount = 0) {
  logQueue.push([requestId, model, success ? 1 : 0, latencyMs, tokensInput, tokensOutput, errorMessage, retryCount]);
}

// ============ 请求限流 ============
const rateLimiter = new Map();

function checkRateLimit(clientId) {
  const now = Date.now();
  const windowStart = now - CONFIG.rateLimit.windowMs;

  // 清理过期记录
  for (const [id, timestamps] of rateLimiter) {
    const validTimestamps = timestamps.filter(t => t > windowStart);
    if (validTimestamps.length === 0) {
      rateLimiter.delete(id);
    } else {
      rateLimiter.set(id, validTimestamps);
    }
  }

  // 检查当前客户端
  const clientTimestamps = rateLimiter.get(clientId) || [];
  const validTimestamps = clientTimestamps.filter(t => t > windowStart);

  if (validTimestamps.length >= CONFIG.rateLimit.maxRequests) {
    return { allowed: false, retryAfter: Math.min(...validTimestamps) + CONFIG.rateLimit.windowMs - now };
  }

  validTimestamps.push(now);
  rateLimiter.set(clientId, validTimestamps);
  return { allowed: true };
}

// ============ 工具函数 ============

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = CONFIG.retry.maxRetries) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout.requestMs);

  const fetchOptions = {
    ...options,
    signal: controller.signal,
    agent: url.startsWith('https') ? httpsAgent : httpAgent
  };

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);
      return { response, attempts: attempt + 1 };
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      // 如果是中止错误，不重试
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${CONFIG.timeout.requestMs}ms`);
      }

      // 最后一次尝试不等待
      if (attempt < retries) {
        const delay = CONFIG.retry.retryDelayMs * Math.pow(2, attempt); // 指数退避
        console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, error.message);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

async function fetchWithRetryAndStatusCheck(url, options, retries = CONFIG.retry.maxRetries) {
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { response, attempts } = await fetchWithRetry(url, options, 0); // 内部不重试，由外层控制

      // 检查是否是可重试的状态码
      if (response.ok) {
        return { response, attempts: attempt + 1 };
      }

      lastResponse = response;

      if (!CONFIG.retry.retryableStatusCodes.includes(response.status)) {
        return { response, attempts: attempt + 1 };
      }

      lastError = new Error(`HTTP ${response.status}`);

      if (attempt < retries) {
        const delay = CONFIG.retry.retryDelayMs * Math.pow(2, attempt);
        console.warn(`HTTP ${response.status}, retrying in ${delay}ms`);
        await sleep(delay);
      }
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        const delay = CONFIG.retry.retryDelayMs * Math.pow(2, attempt);
        console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, error.message);
        await sleep(delay);
      }
    }
  }

  if (lastResponse) {
    return { response: lastResponse, attempts: retries + 1 };
  }

  throw lastError;
}

// ============ 中间件 ============


function timingSafeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getAuthToken(req) {
  const authorization = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }
  if (/^Basic\s+/i.test(authorization)) {
    try {
      const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return separator >= 0 ? decoded.slice(separator + 1).trim() : decoded.trim();
    } catch (e) {
      return '';
    }
  }
  return (req.get('x-api-key') || '').trim();
}

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function shouldBypassAuth(req) {
  const requestPath = req.originalUrl.split('?')[0];
  return requestPath === '/monitor/health' && (CONFIG.security.publicHealthcheck || isLocalRequest(req));
}

function requireProxyAuth(req, res, next) {
  if (!CONFIG.security.requireAuth || CONFIG.security.apiKeys.length === 0 || shouldBypassAuth(req)) {
    return next();
  }

  const token = getAuthToken(req);
  const authorized = token && CONFIG.security.apiKeys.some(key => timingSafeTokenEqual(token, key));
  if (authorized) return next();

  res.setHeader('WWW-Authenticate', 'Basic realm="FreeModel Proxy"');
  return res.status(401).json({
    error: {
      message: 'Unauthorized',
      type: 'authentication_error'
    }
  });
}

function getClientId(req) {
  const token = getAuthToken(req);
  if (token) {
    return `key:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  }
  return req.ip || req.connection.remoteAddress || 'unknown';
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.input_text === 'string') return part.input_text;
      if (part.type === 'image_url' || part.image_url) return '[image_url omitted by proxy]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function convertMessagesToInput(messages) {
  return messages.map(message => {
    const role = typeof message.role === 'string' ? message.role : 'user';
    return `${role}: ${normalizeMessageContent(message.content)}`;
  }).join('\n\n');
}

function buildResponsesRequestBody(body, input) {
  const requestBody = { model: body.model, input };
  const passthrough = [
    'temperature', 'top_p', 'presence_penalty', 'frequency_penalty',
    'stop', 'seed', 'metadata', 'user', 'instructions', 'reasoning'
  ];

  for (const key of passthrough) {
    if (body[key] !== undefined) requestBody[key] = body[key];
  }

  if (body.max_output_tokens !== undefined) {
    requestBody.max_output_tokens = body.max_output_tokens;
  } else if (body.max_tokens !== undefined) {
    requestBody.max_output_tokens = body.max_tokens;
  }

  return requestBody;
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  let content = '';
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === 'string') content += c.text;
        }
      }
    }
  }
  return content;
}

function extractUsage(data) {
  const usage = data.usage || {};
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  return { inputTokens, outputTokens };
}

function sendChatStreamDone(res, chatId, model) {
  res.write(`data: ${JSON.stringify({
    id: chatId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })}\n\n`);
  res.write('data: [DONE]\n\n');
}

async function handleStreamingChatCompletion(req, res, requestBody, model, startTime) {
  const body = { ...requestBody, stream: true };
  let attempts = 0;

  try {
    const result = await fetchWithRetryAndStatusCheck(
      `${FREEMODEL_API}/responses`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FREEMODEL_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(body)
      }
    );
    const response = result.response;
    attempts = result.attempts;

    if (!response.ok) {
      const errorText = await response.text();
      const latency = Date.now() - startTime;
      logRequest(req.requestId, model, false, latency, 0, 0, errorText, attempts - 1);
      return res.status(response.status).json({ error: { message: errorText } });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const chatId = `chatcmpl-${Date.now()}`;
    let buffer = '';
    let currentEvent = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let completed = false;

    const finish = (success, errorMessage = null) => {
      if (!completed) {
        completed = true;
        if (success) sendChatStreamDone(res, chatId, model);
        res.end();
        const latency = Date.now() - startTime;
        logRequest(req.requestId, model, success, latency, inputTokens, outputTokens, errorMessage, Math.max(0, attempts - 1));
      }
    };

    response.body.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) {
          currentEvent = null;
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          finish(true);
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const eventType = parsed.type || currentEvent;

          if (eventType === 'response.output_text.delta') {
            const delta = parsed.delta || '';
            if (delta) {
              res.write(`data: ${JSON.stringify({
                id: chatId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
              })}\n\n`);
            }
          }

          if (parsed.usage) {
            const usage = extractUsage(parsed);
            inputTokens = usage.inputTokens || inputTokens;
            outputTokens = usage.outputTokens || outputTokens;
          }

          if (eventType === 'response.completed') {
            const usage = extractUsage(parsed.response || parsed);
            inputTokens = usage.inputTokens || inputTokens;
            outputTokens = usage.outputTokens || outputTokens;
            finish(true);
          }
        } catch (e) {
          console.warn('Failed to parse upstream stream event:', e.message);
        }
      }
    });

    response.body.on('end', () => finish(true));
    response.body.on('error', error => {
      if (!completed) {
        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
        finish(false, error.message);
      }
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    logRequest(req.requestId, model, false, latency, 0, 0, error.message, Math.max(0, attempts - 1));
    return res.status(500).json({ error: { message: error.message } });
  }
}

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  req.requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  req.startTime = Date.now();
  next();
});

app.use(['/v1', '/monitor'], requireProxyAuth);

// 限流中间件
app.use('/v1/', (req, res, next) => {
  const clientId = getClientId(req);
  const rateCheck = checkRateLimit(clientId);

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: {
        message: 'Rate limit exceeded',
        type: 'rate_limit_error',
        retry_after_ms: rateCheck.retryAfter
      }
    });
  }

  next();
});

// ============ 监控 HTML 页面 ============

app.get('/monitor', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FreeModel Proxy Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .status-online { background: #10b981; color: #fff; }
    .status-offline { background: #ef4444; color: #fff; }
    .status-degraded { background: #f59e0b; color: #fff; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #334155;
    }
    .card h2 {
      font-size: 1rem;
      color: #94a3b8;
      margin-bottom: 15px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .stat-label {
      font-size: 0.85rem;
      color: #64748b;
      margin-top: 5px;
    }
    .stat-positive { color: #10b981; }
    .stat-negative { color: #ef4444; }
    .stat-warning { color: #f59e0b; }

    .service-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid #334155;
    }
    .service-item:last-child { border-bottom: none; }

    .model-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      max-height: 300px;
      overflow-y: auto;
    }
    .model-item {
      background: #0f172a;
      padding: 10px;
      border-radius: 6px;
      font-size: 0.85rem;
      display: flex;
      justify-content: space-between;
    }
    .model-available { color: #10b981; }
    .model-unavailable { color: #ef4444; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    th, td {
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid #334155;
    }
    th { color: #94a3b8; font-weight: 500; }
    tr:hover { background: #0f172a; }

    .success { color: #10b981; }
    .failed { color: #ef4444; }

    .refresh-info {
      text-align: center;
      color: #64748b;
      font-size: 0.85rem;
      margin-top: 20px;
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: #64748b;
    }

    .progress-bar {
      height: 4px;
      background: #334155;
      border-radius: 2px;
      overflow: hidden;
      margin-top: 10px;
    }
    .progress-fill {
      height: 100%;
      background: #3b82f6;
      transition: width 0.3s ease;
    }

    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
      .stat-value { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      FreeModel Proxy Monitor
      <span id="status-badge" class="status-badge status-offline">加载中...</span>
    </h1>

    <div class="grid">
      <div class="card">
        <h2>请求统计 (24h)</h2>
        <div id="stats-container">
          <div class="loading">加载中...</div>
        </div>
      </div>

      <div class="card">
        <h2>服务状态</h2>
        <div id="services-container">
          <div class="loading">加载中...</div>
        </div>
      </div>

      <div class="card">
        <h2>Token 用量</h2>
        <div id="tokens-container">
          <div class="loading">加载中...</div>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="card" style="grid-column: span 2;">
        <h2>可用模型</h2>
        <div id="models-container">
          <div class="loading">加载中...</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>最近请求</h2>
      <div id="requests-container">
        <div class="loading">加载中...</div>
      </div>
    </div>
  </div>

  <div class="refresh-info">
    每 <span id="refresh-interval">${CONFIG.monitor.refreshInterval / 1000}</span> 秒自动刷新 |
    最后更新: <span id="last-update">-</span>
  </div>

  <script>
    let refreshInterval;

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>\"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\"': '&quot;',
        "'": '&#39;'
      }[ch]));
    }

    async function fetchStatus() {
      try {
        const [statusRes, statsRes, requestsRes] = await Promise.all([
          fetch('/monitor/status'),
          fetch('/monitor/stats'),
          fetch('/monitor/requests')
        ]);

        const status = await statusRes.json();
        const stats = await statsRes.json();
        const requests = await requestsRes.json();

        renderStatus(status);
        renderStats(stats);
        renderRequests(requests);
        updateLastRefresh();
      } catch (e) {
        console.error('Failed to fetch status:', e);
        document.getElementById('status-badge').textContent = '离线';
        document.getElementById('status-badge').className = 'status-badge status-offline';
      }
    }

    function renderStatus(status) {
      const badge = document.getElementById('status-badge');
      const service = status.services?.[0];

      if (service) {
        badge.textContent = service.status === 'online' ? '在线' :
                           service.status === 'degraded' ? '降级' : '离线';
        badge.className = 'status-badge status-' + service.status;
      }

      // 服务状态
      const servicesContainer = document.getElementById('services-container');
      if (service) {
        servicesContainer.innerHTML = \`
          <div class="service-item">
            <span>\${escapeHtml(service.name)}</span>
            <span class="\${service.status === 'online' ? 'success' : 'failed'}">
              \${service.status === 'online' ? '✓ 在线' : '✗ ' + (service.error || service.status)}
              \${service.latency_ms ? '(' + service.latency_ms + 'ms)' : ''}
            </span>
          </div>
        \`;
      }

      // 模型列表
      const modelsContainer = document.getElementById('models-container');
      if (status.models && Object.keys(status.models).length > 0) {
        const modelHtml = Object.entries(status.models).map(([id, info]) => \`
          <div class="model-item">
            <span>\${escapeHtml(id)}</span>
            <span class="\${info.available ? 'model-available' : 'model-unavailable'}">
              \${info.available ? '✓' : '✗'}
            </span>
          </div>
        \`).join('');
        modelsContainer.innerHTML = \`<div class="model-grid">\${modelHtml}</div>\`;
      } else {
        modelsContainer.innerHTML = '<div class="loading">无可用模型</div>';
      }
    }

    function renderStats(stats) {
      const successRate = stats.total_requests > 0
        ? ((stats.successful_requests / stats.total_requests) * 100).toFixed(1)
        : 0;

      const statsContainer = document.getElementById('stats-container');
      statsContainer.innerHTML = \`
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
          <div>
            <div class="stat-value">\${stats.total_requests}</div>
            <div class="stat-label">总请求</div>
          </div>
          <div>
            <div class="stat-value \${parseFloat(successRate) >= 90 ? 'stat-positive' : parseFloat(successRate) >= 70 ? 'stat-warning' : 'stat-negative'}">
              \${successRate}%
            </div>
            <div class="stat-label">成功率</div>
          </div>
          <div>
            <div class="stat-value stat-positive">\${stats.successful_requests}</div>
            <div class="stat-label">成功</div>
          </div>
          <div>
            <div class="stat-value \${stats.failed_requests > 0 ? 'stat-negative' : ''}">\${stats.failed_requests}</div>
            <div class="stat-label">失败</div>
          </div>
          <div style="grid-column: span 2;">
            <div class="stat-value">\${stats.avg_latency_ms}ms</div>
            <div class="stat-label">平均延迟</div>
          </div>
        </div>
      \`;

      // Token 用量
      const tokensContainer = document.getElementById('tokens-container');
      tokensContainer.innerHTML = \`
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
          <div>
            <div class="stat-value">\${formatNumber(stats.total_input_tokens)}</div>
            <div class="stat-label">输入 Tokens</div>
          </div>
          <div>
            <div class="stat-value">\${formatNumber(stats.total_output_tokens)}</div>
            <div class="stat-label">输出 Tokens</div>
          </div>
          <div style="grid-column: span 2;">
            <div class="stat-value">\${formatNumber(stats.total_input_tokens + stats.total_output_tokens)}</div>
            <div class="stat-label">总计</div>
          </div>
        </div>
      \`;
    }

    function renderRequests(requests) {
      const container = document.getElementById('requests-container');

      if (!requests.requests || requests.requests.length === 0) {
        container.innerHTML = '<div class="loading">暂无请求记录</div>';
        return;
      }

      const tableHtml = \`
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>状态</th>
              <th>延迟</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            \${requests.requests.slice(0, 20).map(r => \`
              <tr>
                <td>\${formatTime(r.timestamp)}</td>
                <td>\${escapeHtml(r.model)}</td>
                <td class="\${r.success ? 'success' : 'failed'}">\${r.success ? '✓' : '✗'} \${r.error || ''}</td>
                <td>\${r.latency_ms}ms</td>
                <td>\${r.tokens_input || 0}/\${r.tokens_output || 0}</td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      \`;

      container.innerHTML = tableHtml;
    }

    function formatNumber(num) {
      if (!num) return '0';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return num.toString();
    }

    function formatTime(isoString) {
      const date = new Date(isoString);
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function updateLastRefresh() {
      document.getElementById('last-update').textContent = new Date().toLocaleTimeString('zh-CN');
    }

    // 初始化
    fetchStatus();
    refreshInterval = setInterval(fetchStatus, ${CONFIG.monitor.refreshInterval});
  </script>
</body>
</html>`);
});

// ============ Chat Completions API ============

app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, stream = false } = req.body;
  const startTime = Date.now();

  if (!model || !messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'model and messages are required', type: 'invalid_request_error' }
    });
  }

  // 检查缓存（仅对非流式请求）
  try {
    const input = convertMessagesToInput(messages);
    const requestBody = buildResponsesRequestBody(req.body, input);

    if (stream) {
      return handleStreamingChatCompletion(req, res, requestBody, model, startTime);
    }

    const cacheKey = JSON.stringify(requestBody);
    if (cache.responses.has(cacheKey)) {
      const cached = cache.responses.get(cacheKey);
      if (Date.now() - cached.timestamp < 60000) {
        const latency = Date.now() - startTime;
        logRequest(req.requestId, model, true, latency, cached.inputTokens, cached.outputTokens, null, 0);
        return res.json(cached.response);
      }
    }

    const { response, attempts } = await fetchWithRetryAndStatusCheck(
      `${FREEMODEL_API}/responses`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FREEMODEL_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    const latency = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      logRequest(req.requestId, model, false, latency, 0, 0, errorText, attempts);
      return res.status(response.status).json({ error: { message: errorText } });
    }

    const data = await response.json();

    // 解析响应
    const content = extractOutputText(data);
    const { inputTokens, outputTokens } = extractUsage(data);

    const chatResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    };

    // 缓存响应
    if (!stream) {
      cache.responses.set(cacheKey, {
        response: chatResponse,
        timestamp: Date.now(),
        inputTokens,
        outputTokens
      });

      // 清理过期缓存
      if (cache.responses.size > CONFIG.cache.maxSize) {
        const oldestKey = cache.responses.keys().next().value;
        cache.responses.delete(oldestKey);
      }
    }

    logRequest(req.requestId, model, true, latency, inputTokens, outputTokens, null, attempts - 1);
    res.json(chatResponse);

  } catch (error) {
    const latency = Date.now() - startTime;
    logRequest(req.requestId, model, false, latency, 0, 0, error.message, 0);
    res.status(500).json({ error: { message: error.message } });
  }
});

// ============ Models API ============

app.get('/v1/models', async (req, res) => {
  try {
    // 检查缓存
    if (cache.models.data && Date.now() - cache.models.updatedAt < CONFIG.cache.modelsTTL) {
      return res.json(cache.models.data);
    }

    const response = await fetch(`${FREEMODEL_API}/models`, {
      headers: { 'Authorization': `Bearer ${FREEMODEL_KEY}` },
      agent: httpsAgent
    });
    const data = await response.json();

    // 更新缓存
    cache.models.data = data;
    cache.models.updatedAt = Date.now();

    res.json(data);
  } catch (error) {
    // 如果有缓存，返回降级数据
    if (cache.models.data) {
      return res.json(cache.models.data);
    }
    res.status(500).json({ error: { message: error.message } });
  }
});

// ============ 监控端点 ============

app.get('/monitor/status', async (req, res) => {
  try {
    const start = Date.now();
    const response = await fetch(`${FREEMODEL_API}/models`, {
      headers: { 'Authorization': `Bearer ${FREEMODEL_KEY}` },
      agent: httpsAgent,
      timeout: CONFIG.timeout.connectMs
    });
    const latency = Date.now() - start;
    const data = await response.json();

    res.json({
      services: [{
        name: 'FreeModel API',
        status: response.ok ? 'online' : 'degraded',
        latency_ms: latency
      }],
      models: data.data ? Object.fromEntries(data.data.map(m => [m.id, { available: true }])) : {}
    });
  } catch (e) {
    res.json({
      services: [{
        name: 'FreeModel API',
        status: 'offline',
        error: e.message
      }],
      models: {}
    });
  }
});

app.get('/monitor/stats', (req, res) => {
  const period = req.query.period || '24h';
  let since;
  switch (period) {
    case '1h': since = Date.now() - 3600000; break;
    case '7d': since = Date.now() - 604800000; break;
    default: since = Date.now() - 86400000;
  }

  const stats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success,
           AVG(latency_ms) as avg_latency,
           SUM(tokens_input) as input_tokens,
           SUM(tokens_output) as output_tokens,
           MAX(timestamp) as last_request
    FROM requests WHERE timestamp >= ?
  `).get(since);

  res.json({
    period,
    total_requests: stats.total || 0,
    successful_requests: stats.success || 0,
    failed_requests: (stats.total || 0) - (stats.success || 0),
    success_rate: stats.total ? ((stats.success / stats.total) * 100).toFixed(2) : 0,
    avg_latency_ms: Math.round(stats.avg_latency || 0),
    total_input_tokens: stats.input_tokens || 0,
    total_output_tokens: stats.output_tokens || 0,
    last_request: stats.last_request ? new Date(stats.last_request).toISOString() : null
  });
});

app.get('/monitor/requests', (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
  const requests = db.prepare(`
    SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?
  `).all(limit);

  res.json({
    count: requests.length,
    requests: requests.map(r => ({
      id: r.id,
      request_id: r.request_id,
      timestamp: new Date(r.timestamp).toISOString(),
      model: r.model,
      success: r.success === 1,
      latency_ms: r.latency_ms,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      error: r.error_message,
      retries: r.retry_count
    }))
  });
});

app.get('/monitor/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks: {}
  };

  // 检查数据库
  try {
    db.prepare('SELECT 1').get();
    health.checks.database = { status: 'ok' };
  } catch (e) {
    health.checks.database = { status: 'error', message: e.message };
    health.status = 'unhealthy';
  }

  // 检查上游 API
  try {
    const start = Date.now();
    const response = await fetch(`${FREEMODEL_API}/models`, {
      headers: { 'Authorization': `Bearer ${FREEMODEL_KEY}` },
      agent: httpsAgent,
      timeout: 5000
    });
    health.checks.upstream = {
      status: response.ok ? 'ok' : 'degraded',
      latency_ms: Date.now() - start,
      http_status: response.status
    };
  } catch (e) {
    health.checks.upstream = { status: 'error', message: e.message };
  }

  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// ============ 优雅关闭 ============

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('\nReceived shutdown signal, closing gracefully...');

  // 停止批量写入定时器
  if (flushInterval) {
    clearInterval(flushInterval);
  }

  // 刷新剩余日志
  flushLogQueue();

  // 关闭数据库
  try {
    db.close();
  } catch (e) {
    console.error('Error closing database:', e);
  }

  process.exit(0);
}

// ============ 启动服务 ============

startBatchWriter();

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     FreeModel Proxy Server (优化版 v4.0)                 ║
╠══════════════════════════════════════════════════════════╣
║  Proxy URL:   http://localhost:${PORT}/v1                 ║
║  Monitor:     http://localhost:${PORT}/monitor            ║
║  Health:      http://localhost:${PORT}/monitor/health     ║
║                                                          ║
║  Features:                                               ║
║  ✓ Request retry with exponential backoff                ║
║  ✓ Request timeout handling                              ║
║  ✓ HTTP connection pool                                  ║
║  ✓ Response cache                                        ║
║  ✓ Rate limiting                                         ║
║  ✓ Batch database writes                                 ║
║  ✓ Graceful shutdown                                     ║
╚══════════════════════════════════════════════════════════╝
  `);
});
