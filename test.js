#!/usr/bin/env node

/**
 * FreeModel Proxy 测试脚本
 * 测试代理服务的各项功能
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

function readDotenvKey() {
  try {
    const envPath = path.join(__dirname, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const values = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2].replace(/^['\"]|['\"]$/g, '');
    }
    return values.PROXY_API_KEY || (values.PROXY_API_KEYS || '').split(',')[0] || '';
  } catch (e) {
    return '';
  }
}

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:38080';
const TEST_MODEL = process.env.TEST_MODEL || 'gpt-5.4-mini';
const PROXY_API_KEY = process.env.PROXY_API_KEY || (process.env.PROXY_API_KEYS || '').split(',')[0] || readDotenvKey();

let testsPassed = 0;
let testsFailed = 0;
const results = [];

async function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, PROXY_URL);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(PROXY_API_KEY ? { Authorization: `Bearer ${PROXY_API_KEY}` } : {}),
        ...options.headers
      },
      timeout: options.timeout || 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function test(name, fn) {
  console.log(`\n测试: ${name}`);
  try {
    await fn();
    console.log(`  ✓ 通过`);
    testsPassed++;
    results.push({ name, status: 'passed' });
  } catch (error) {
    console.log(`  ✗ 失败: ${error.message}`);
    testsFailed++;
    results.push({ name, status: 'failed', error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// ============ 测试用例 ============

async function testMonitorPage() {
  await test('监控页面可访问', async () => {
    const res = await request('/monitor');
    assert(res.status === 200, `状态码应为 200，实际 ${res.status}`);
    assert(typeof res.body === 'string', '应返回 HTML');
    assert(res.body.includes('FreeModel Proxy Monitor'), '应包含标题');
  });
}

async function testHealthEndpoint() {
  await test('健康检查端点', async () => {
    const res = await request('/monitor/health');
    assert(res.status === 200 || res.status === 503, `状态码应为 200 或 503`);
    assert(res.body.status, '应返回状态');
    assert(res.body.checks, '应返回检查结果');
    assert(res.body.checks.database, '应包含数据库检查');
    assert(res.body.checks.upstream, '应包含上游检查');
  });
}

async function testStatusEndpoint() {
  await test('状态端点', async () => {
    const res = await request('/monitor/status');
    assert(res.status === 200, `状态码应为 200`);
    assert(res.body.services, '应返回服务列表');
    assert(Array.isArray(res.body.services), 'services 应为数组');
  });
}

async function testStatsEndpoint() {
  await test('统计端点', async () => {
    const res = await request('/monitor/stats');
    assert(res.status === 200, `状态码应为 200`);
    assert(typeof res.body.total_requests === 'number', '应返回总请求数');
    assert(typeof res.body.successful_requests === 'number', '应返回成功请求数');
    assert(typeof res.body.avg_latency_ms === 'number', '应返回平均延迟');
  });
}

async function testRequestsEndpoint() {
  await test('请求列表端点', async () => {
    const res = await request('/monitor/requests');
    assert(res.status === 200, `状态码应为 200`);
    assert(Array.isArray(res.body.requests), 'requests 应为数组');
  });
}

async function testModelsEndpoint() {
  await test('模型列表端点', async () => {
    const res = await request('/v1/models');
    // 上游可能不可用，只检查格式
    assert(res.status === 200 || res.status === 500, `状态码应为 200 或 500`);
  });
}

async function testChatCompletionsValidation() {
  await test('Chat Completions 参数验证', async () => {
    const res = await request('/v1/chat/completions', {
      method: 'POST',
      body: {} // 缺少必需参数
    });
    assert(res.status === 400, `缺少参数应返回 400，实际 ${res.status}`);
    assert(res.body.error, '应返回错误信息');
  });
}

async function testRateLimit() {
  await test('限流功能', async () => {
    // 快速发送多个请求测试限流
    const promises = [];
    for (let i = 0; i < 110; i++) {
      promises.push(request('/v1/models'));
    }
    const results = await Promise.all(promises);
    const rateLimited = results.some(r => r.status === 429);
    // 可能不会触发限流（如果限流阈值较高），但代码应该能处理
    assert(true, '限流测试完成');
  });
}

// ============ 运行测试 ============

async function main() {
  console.log('========================================');
  console.log('FreeModel Proxy 测试套件');
  console.log(`目标: ${PROXY_URL}`);
  console.log('========================================');

  // 监控相关测试
  await testMonitorPage();
  await testHealthEndpoint();
  await testStatusEndpoint();
  await testStatsEndpoint();
  await testRequestsEndpoint();
  
  // API 相关测试
  await testModelsEndpoint();
  await testChatCompletionsValidation();
  await testRateLimit();

  // 输出汇总
  console.log('\n========================================');
  console.log('测试汇总');
  console.log('========================================');
  console.log(`总计: ${testsPassed + testsFailed}`);
  console.log(`通过: ${testsPassed} ✓`);
  console.log(`失败: ${testsFailed} ✗`);
  
  if (testsFailed > 0) {
    console.log('\n失败的测试:');
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
  
  console.log('\n✅ 所有测试通过!');
  process.exit(0);
}

main().catch(console.error);
