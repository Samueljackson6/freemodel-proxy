const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 38080;

// FreeModel API configuration
const FREEMODEL_API = 'https://api.freemodel.dev/v1';
const FREEMODEL_KEY = process.env.FREEMODEL_KEY;
if (!FREEMODEL_KEY) {
  console.error('ERROR: FREEMODEL_KEY environment variable is required');
  process.exit(1);
}

// Model list cache (populated dynamically from /v1/models)
let modelCache = { data: [], updatedAt: 0 };

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'proxy_stats.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    model TEXT,
    endpoint TEXT,
    success INTEGER,
    latency_ms INTEGER,
    tokens_input INTEGER,
    tokens_output INTEGER,
    error_message TEXT
  );
  
  CREATE TABLE IF NOT EXISTS service_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    service TEXT,
    status TEXT,
    latency_ms INTEGER
  );
`);

app.use(express.json({ limit: '10mb' }));

// Middleware: Request logging
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

// ============ Chat Completions API Proxy ============

app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const { model, messages, stream = false, ...otherParams } = req.body;

  if (!model) {
    return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
  }

  // Convert Chat Completions to Responses API format
  // Responses API uses "input" field with simple text
  const input = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

  try {
    if (stream) {
      // Streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const response = await fetch(`${FREEMODEL_API}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FREEMODEL_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({ model, input, stream: true })
      });

      if (!response.ok) {
        const errorText = await response.text();
        res.write(`data: ${JSON.stringify({ error: { message: errorText } })}\n\n`);
        res.end();
        logRequest(model, '/v1/chat/completions', false, Date.now() - startTime, 0, 0, errorText);
        return;
      }

      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      const chatId = `chatcmpl-${Date.now()}`;

      response.body.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        let currentEvent = null;

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // Send final chunk
              const finalChunk = {
                id: chatId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }]
              };
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
              continue;
            }
            
            try {
              const parsed = JSON.parse(data);
              
              // Handle response.output_text.delta events
              if (currentEvent === 'response.output_text.delta' || parsed.type === 'response.output_text.delta') {
                const delta = parsed.delta || '';
                if (delta) {
                  const chatChunk = {
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: { content: delta },
                      finish_reason: null
                    }]
                  };
                  res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                }
              }
              
              // Track usage from response.completed or similar events
              if (parsed.usage) {
                inputTokens = parsed.usage.input_tokens || inputTokens;
                outputTokens = parsed.usage.output_tokens || outputTokens;
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      });

      response.body.on('end', () => {
        res.end();
        const latency = Date.now() - startTime;
        logRequest(model, '/v1/chat/completions', true, latency, inputTokens, outputTokens, null);
      });

      response.body.on('error', err => {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        res.end();
        logRequest(model, '/v1/chat/completions', false, Date.now() - startTime, 0, 0, err.message);
      });

    } else {
      // Non-streaming response
      const response = await fetch(`${FREEMODEL_API}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FREEMODEL_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, input })
      });

      const latency = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        logRequest(model, '/v1/chat/completions', false, latency, 0, 0, errorText);
        return res.status(response.status).json({ error: { message: errorText } });
      }

      const data = await response.json();

      // Convert Responses API to Chat Completions format
      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;

      if (data.output) {
        for (const item of data.output) {
          if (item.content) {
            for (const c of item.content) {
              if (c.text) content += c.text;
            }
          }
        }
      }

      if (data.usage) {
        inputTokens = data.usage.input_tokens || 0;
        outputTokens = data.usage.output_tokens || 0;
      }

      const chatResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens
        }
      };

      logRequest(model, '/v1/chat/completions', true, latency, inputTokens, outputTokens, null);
      res.json(chatResponse);
    }

  } catch (error) {
    const latency = Date.now() - startTime;
    logRequest(model, '/v1/chat/completions', false, latency, 0, 0, error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

// ============ Models List ============

async function fetchModels() {
  const now = Date.now();
  // Cache for 5 minutes
  if (modelCache.data.length > 0 && now - modelCache.updatedAt < 300000) {
    return modelCache.data;
  }
  try {
    const response = await fetch(`${FREEMODEL_API}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${FREEMODEL_KEY}` }
    });
    if (response.ok) {
      const data = await response.json();
      modelCache = { data: data.data || [], updatedAt: now };
    }
  } catch (e) {
    // Return cache even if stale
  }
  return modelCache.data;
}

app.get('/v1/models', async (req, res) => {
  const models = await fetchModels();
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: m.created || 1700000000,
      owned_by: m.owned_by || 'freemodel'
    }))
  });
});

// ============ Monitoring Endpoints ============

// Service status
app.get('/monitor/status', async (req, res) => {
  const services = [];
  
  // Check FreeModel API
  try {
    const startTime = Date.now();
    const response = await fetch(`${FREEMODEL_API}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${FREEMODEL_KEY}` }
    });
    const latency = Date.now() - startTime;
    
    services.push({
      name: 'FreeModel API',
      status: response.ok ? 'online' : 'degraded',
      latency_ms: latency,
      last_check: new Date().toISOString()
    });

    // Update model cache
    if (response.ok) {
      const data = await response.json();
      if (data.data) {
        modelCache = { data: data.data, updatedAt: Date.now() };
      }
    }
  } catch (e) {
    services.push({
      name: 'FreeModel API',
      status: 'offline',
      latency_ms: null,
      last_check: new Date().toISOString(),
      error: e.message
    });
  }

  const models = await fetchModels();
  const modelStatus = {};
  models.forEach(m => {
    modelStatus[m.id] = { available: true, status: 'available' };
  });
  res.json({ services, models: modelStatus });
});

// Request statistics
app.get('/monitor/stats', (req, res) => {
  const period = req.query.period || '24h';
  let since;
  
  switch (period) {
    case '1h': since = Date.now() - 3600000; break;
    case '24h': since = Date.now() - 86400000; break;
    case '7d': since = Date.now() - 604800000; break;
    case '30d': since = Date.now() - 2592000000; break;
    default: since = Date.now() - 86400000;
  }

  const stats = {
    period,
    since: new Date(since).toISOString(),
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    avg_latency_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    by_model: {},
    by_endpoint: {},
    recent_errors: []
  };

  // Total and success/failure counts
  const totalReq = db.prepare(`
    SELECT COUNT(*) as count, 
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
           AVG(latency_ms) as avg_latency,
           SUM(tokens_input) as total_input,
           SUM(tokens_output) as total_output
    FROM requests WHERE timestamp >= ?
  `).get(since);

  stats.total_requests = totalReq.count || 0;
  stats.successful_requests = totalReq.success_count || 0;
  stats.failed_requests = stats.total_requests - stats.successful_requests;
  stats.avg_latency_ms = Math.round(totalReq.avg_latency || 0);
  stats.total_input_tokens = totalReq.total_input || 0;
  stats.total_output_tokens = totalReq.total_output || 0;

  // By model
  const byModel = db.prepare(`
    SELECT model, COUNT(*) as count, 
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
           AVG(latency_ms) as avg_latency
    FROM requests WHERE timestamp >= ?
    GROUP BY model
  `).all(since);

  byModel.forEach(row => {
    stats.by_model[row.model] = {
      total: row.count,
      success: row.success_count,
      failed: row.count - row.success_count,
      avg_latency_ms: Math.round(row.avg_latency || 0)
    };
  });

  // By endpoint
  const byEndpoint = db.prepare(`
    SELECT endpoint, COUNT(*) as count,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count
    FROM requests WHERE timestamp >= ?
    GROUP BY endpoint
  `).all(since);

  byEndpoint.forEach(row => {
    stats.by_endpoint[row.endpoint] = {
      total: row.count,
      success: row.success_count,
      failed: row.count - row.success_count
    };
  });

  // Recent errors
  const errors = db.prepare(`
    SELECT timestamp, model, error_message, latency_ms
    FROM requests 
    WHERE timestamp >= ? AND success = 0 AND error_message IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 20
  `).all(since);

  stats.recent_errors = errors.map(e => ({
    timestamp: new Date(e.timestamp).toISOString(),
    model: e.model,
    error: e.error_message,
    latency_ms: e.latency_ms
  }));

  res.json(stats);
});

// Recent requests
app.get('/monitor/requests', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const requests = db.prepare(`
    SELECT * FROM requests 
    ORDER BY timestamp DESC 
    LIMIT ?
  `).all(limit);

  res.json({
    count: requests.length,
    requests: requests.map(r => ({
      id: r.id,
      timestamp: new Date(r.timestamp).toISOString(),
      model: r.model,
      endpoint: r.endpoint,
      success: r.success === 1,
      latency_ms: r.latency_ms,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      error: r.error_message
    }))
  });
});

// Dashboard HTML
app.get('/monitor', (req, res) => {
  res.send(`
<!DOCTYPE html>
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
      font-size: 24px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h1::before { content: '🔌'; }
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
      font-size: 14px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    .stat-value {
      font-size: 32px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .stat-change {
      font-size: 14px;
      margin-top: 4px;
    }
    .up { color: #22c55e; }
    .down { color: #ef4444; }
    .neutral { color: #94a3b8; }
    .status-online { color: #22c55e; }
    .status-offline { color: #ef4444; }
    .status-degraded { color: #f59e0b; }
    .model-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .model-item {
      background: #0f172a;
      padding: 12px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .model-name { font-weight: 500; }
    .model-status {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .model-status.stable { background: #166534; color: #86efac; }
    .model-status.unstable { background: #854d0e; color: #fde047; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 12px;
      border-bottom: 1px solid #334155;
    }
    th { color: #94a3b8; font-weight: 500; }
    .error-row { color: #fca5a5; }
    .refresh-btn {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .refresh-btn:hover { background: #2563eb; }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .endpoint-info {
      background: #0f172a;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-family: monospace;
      font-size: 14px;
    }
    .endpoint-info code { color: #60a5fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-row">
      <h1>FreeModel Proxy Monitor</h1>
      <button class="refresh-btn" onclick="refreshAll()">🔄 刷新</button>
    </div>
    
    <div class="endpoint-info">
      <strong>代理端点:</strong> <code id="proxy-url"></code><br>
      <strong>API Base:</strong> <code>http://localhost:${PORT}/v1</code>
    </div>

    <div class="grid">
      <div class="card">
        <h2>服务状态</h2>
        <div id="service-status">加载中...</div>
      </div>
      
      <div class="card">
        <h2>模型可用性</h2>
        <div id="models-status" class="model-grid">加载中...</div>
      </div>
      
      <div class="card">
        <h2>请求统计 (24h)</h2>
        <div class="stat-value" id="total-requests">-</div>
        <div class="stat-change" id="success-rate">-</div>
      </div>
      
      <div class="card">
        <h2>平均延迟</h2>
        <div class="stat-value" id="avg-latency">- ms</div>
        <div class="stat-change neutral" id="latency-note">Chat Completions → Responses API</div>
      </div>
      
      <div class="card">
        <h2>Token 用量</h2>
        <div class="stat-value" id="total-tokens">-</div>
        <div class="stat-change neutral" id="token-breakdown">输入: - / 输出: -</div>
      </div>
      
      <div class="card">
        <h2>成功率</h2>
        <div class="stat-value" id="success-percent">-</div>
        <div class="stat-change" id="error-count">-</div>
      </div>
    </div>

    <div class="card">
      <h2>最近请求</h2>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>端点</th>
            <th>延迟</th>
            <th>Tokens</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody id="recent-requests">加载中...</tbody>
      </table>
    </div>

    <div class="card">
      <h2>最近错误</h2>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>错误信息</th>
            <th>延迟</th>
          </tr>
        </thead>
        <tbody id="recent-errors">加载中...</tbody>
      </table>
    </div>
  </div>

  <script>
    document.getElementById('proxy-url').textContent = window.location.origin;

    async function fetchJSON(url) {
      const res = await fetch(url);
      return res.json();
    }

    async function refreshAll() {
      try {
        // Status
        const status = await fetchJSON('/monitor/status');
        let statusHtml = '';
        status.services.forEach(s => {
          const statusClass = s.status === 'online' ? 'status-online' : 
                              s.status === 'degraded' ? 'status-degraded' : 'status-offline';
          statusHtml += \`<div style="margin-bottom:8px">
            <span>\${s.name}</span>
            <span class="\${statusClass}" style="margin-left:10px">\${s.status}</span>
            \${s.latency_ms ? \`<span class="neutral" style="margin-left:10px">\${s.latency_ms}ms</span>\` : ''}
          </div>\`;
        });
        document.getElementById('service-status').innerHTML = statusHtml;

        // Models
        let modelsHtml = '';
        for (const [model, info] of Object.entries(status.models)) {
          modelsHtml += \`<div class="model-item">
            <span class="model-name">\${model}</span>
            <span class="model-status \${info.status}">\${info.status}</span>
          </div>\`;
        }
        document.getElementById('models-status').innerHTML = modelsHtml;

        // Stats
        const stats = await fetchJSON('/monitor/stats?period=24h');
        document.getElementById('total-requests').textContent = stats.total_requests;
        document.getElementById('success-rate').innerHTML = 
          \`<span class="up">✓ \${stats.successful_requests} 成功</span> / 
           <span class="down">✗ \${stats.failed_requests} 失败</span>\`;
        
        document.getElementById('avg-latency').textContent = stats.avg_latency_ms + ' ms';
        
        const totalTokens = stats.total_input_tokens + stats.total_output_tokens;
        document.getElementById('total-tokens').textContent = totalTokens.toLocaleString();
        document.getElementById('token-breakdown').textContent = 
          \`输入: \${stats.total_input_tokens.toLocaleString()} / 输出: \${stats.total_output_tokens.toLocaleString()}\`;
        
        const successPercent = stats.total_requests > 0 
          ? Math.round(stats.successful_requests / stats.total_requests * 100) 
          : 0;
        document.getElementById('success-percent').textContent = successPercent + '%';
        document.getElementById('error-count').innerHTML = stats.failed_requests > 0
          ? \`<span class="down">\${stats.failed_requests} 个请求失败</span>\`
          : \`<span class="up">无错误</span>\`;

        // Recent requests
        const requests = await fetchJSON('/monitor/requests?limit=20');
        let reqHtml = '';
        requests.requests.forEach(r => {
          const statusIcon = r.success ? '✓' : '✗';
          const rowClass = r.success ? '' : 'error-row';
          reqHtml += \`<tr class="\${rowClass}">
            <td>\${new Date(r.timestamp).toLocaleString('zh-CN')}</td>
            <td>\${r.model}</td>
            <td>\${r.endpoint}</td>
            <td>\${r.latency_ms}ms</td>
            <td>\${r.tokens_input || 0}+\${r.tokens_output || 0}</td>
            <td>\${statusIcon}</td>
          </tr>\`;
        });
        document.getElementById('recent-requests').innerHTML = reqHtml || '<tr><td colspan="6" class="neutral">暂无请求</td></tr>';

        // Recent errors
        let errHtml = '';
        stats.recent_errors.forEach(e => {
          errHtml += \`<tr class="error-row">
            <td>\${new Date(e.timestamp).toLocaleString('zh-CN')}</td>
            <td>\${e.model}</td>
            <td>\${e.error}</td>
            <td>\${e.latency_ms}ms</td>
          </tr>\`;
        });
        document.getElementById('recent-errors').innerHTML = errHtml || '<tr><td colspan="4" class="neutral">暂无错误</td></tr>';

      } catch (err) {
        console.error('Refresh failed:', err);
      }
    }

    refreshAll();
    setInterval(refreshAll, 30000);
  </script>
</body>
</html>
  `);
});

// ============ Helper Functions ============

function logRequest(model, endpoint, success, latencyMs, tokensInput, tokensOutput, errorMessage) {
  try {
    db.prepare(`
      INSERT INTO requests (model, endpoint, success, latency_ms, tokens_input, tokens_output, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(model, endpoint, success ? 1 : 0, latencyMs, tokensInput, tokensOutput, errorMessage);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}

// ============ Start Server ============

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         FreeModel Proxy Server Started                   ║
╠══════════════════════════════════════════════════════════╣
║  Proxy URL:   http://localhost:${PORT}/v1                 ║
║  Monitor:     http://localhost:${PORT}/monitor            ║
║  API Status:  http://localhost:${PORT}/monitor/status     ║
║  Stats:       http://localhost:${PORT}/monitor/stats      ║
╠══════════════════════════════════════════════════════════╣
║  Models are fetched dynamically from FreeModel API       ║
║  Use GET /v1/models to list available models             ║
╚══════════════════════════════════════════════════════════╝
  `);
});
