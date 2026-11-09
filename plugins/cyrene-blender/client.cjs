'use strict';

const http = require('node:http');

function errorText(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const known = {
    human_modified: '场景刚被手动修改，旧的读取基准已失效。首版请停止并重新启动网关，再读取场景后继续。',
    human_paused: '你已在 Blender 中暂停代理控制，请恢复后继续。',
    'no addon connected to Gateway': '没有连接的 Blender。请启用配套扩展，并将其网关端口设为面板中的端口。',
    ambiguous_instance: '连接了多个 Blender 实例。首版只支持一个实例，请断开多余连接。',
  };
  return known[raw] || raw;
}

class GatewayClient {
  constructor(port, hostId, signal) {
    this.port = port;
    this.hostId = hostId;
    this.signal = signal;
  }

  request(route, body, options = {}) {
    const { timeout = 12000, binary = false, session = 'workbench', signal } = options;
    const combined = AbortSignal.any([this.signal, signal].filter(Boolean));
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: this.port, path: route,
        method: bytes ? 'POST' : 'GET', signal: combined,
        headers: {
          'content-type': 'application/json',
          ...(bytes ? { 'content-length': bytes.length } : {}),
          'x-dsh-host-id': this.hostId,
          'x-dsh-session-id': session,
          'x-dsh-agent-id': 'cyrene-main',
          'x-dsh-agent-role': 'main',
        },
      }, res => {
        const chunks = [];
        let length = 0;
        res.on('data', chunk => {
          length += chunk.length;
          if (length > 5 * 1024 * 1024) {
            res.destroy(new Error('网关响应超过 5 MB 限制。'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const data = Buffer.concat(chunks);
            if (binary && res.statusCode === 200 && String(res.headers['content-type']).startsWith('image/png')) {
              if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('截图不是有效的 PNG 文件。');
              resolve(data);
              return;
            }
            const result = JSON.parse(data.toString('utf8'));
            if (res.statusCode >= 400 || result.ok === false || result.error || result.result?.error) {
              throw new Error(errorText(result.error || result.result?.error || result.root_cause || result.code || result));
            }
            if (binary) throw new Error('网关没有返回 PNG 截图。');
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error('Blender 请求超时；请检查扩展连接和暂停状态。')), timeout);
      timer.unref?.();
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(bytes);
    });
  }
}

module.exports = { GatewayClient };
