'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { GatewayClient } = require('./client.cjs');
const scripts = require('./scripts.cjs');
const runFile = promisify(execFile);
const terminal = new Set(['completed', 'failed', 'canceled']);
const artifactError = '渲染进程已退出，但输出 PNG 数量不足，未通过产物检查。';

function validateConfig(input, defaults) {
  if (!input || typeof input !== 'object') throw new Error('配置格式错误。');
  const config = {};
  for (const key of ['nodePath', 'blenderPath', 'outputDir']) {
    const value = input[key] === undefined ? defaults[key] : input[key];
    if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error(`${key} 路径无效。`);
    config[key] = value.trim();
  }
  if (!config.nodePath) config.nodePath = 'node';
  if (!config.outputDir || !path.isAbsolute(config.outputDir)) throw new Error('输出目录必须是绝对路径。');
  if (config.blenderPath && !path.isAbsolute(config.blenderPath)) throw new Error('Blender 路径必须是完整的可执行文件路径。');
  config.port = scripts.number(input.port === undefined ? defaults.port : input.port, '端口', 1024, 65535, true);
  return config;
}

function checkNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 9)) {
    throw new Error(`上游网关需要 Node.js 24.9 或更新版本；当前为 ${version.trim()}。请在面板填写新版 node.exe 路径。`);
  }
}

class BlenderService {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.root = ctx.storage.rootDir();
    this.vendorDir = options.vendorDir || path.join(__dirname, 'vendor', 'dsh-blender');
    this.runFile = options.runFile || runFile;
    this.hostId = ctx.storage.get('host-id') || `cyrene-blender-${crypto.randomUUID()}`;
    ctx.storage.set('host-id', this.hostId);
    const defaults = { nodePath: 'node', blenderPath: '', port: 39878, outputDir: path.join(this.root, 'output') };
    this.config = validateConfig(ctx.storage.get('config') || defaults, defaults);
    this.controller = new AbortController();
    this.client = new GatewayClient(this.config.port, this.hostId, this.controller.signal);
    this.child = null;
    this.closed = false;
    this.stopping = false;
    this.session = null;
    this.logs = '';
    this.queue = Promise.resolve();
    this.generation = 0;
    this.jobUpdates = new WeakMap();
    this.state = { config: this.config, gateway: { running: false, owned: false, health: null, error: null }, instances: [], selectedInstanceId: null, jobs: [], scene: null, preview: null };
    this.heartbeat = setInterval(() => {
      if (this.session && !this.stopping) this.client.request('/lease', { action: 'heartbeat', sessionId: this.session.id }, { timeout: 2000 }).catch(error => { this.state.gateway.error = error.message; });
    }, 30000);
    this.heartbeat.unref?.();
  }

  serial(task, signal) {
    const generation = this.generation;
    const run = this.queue.then(() => {
      if (this.closed || this.stopping || this.ctx.signal.aborted || generation !== this.generation) throw new Error('插件正在停止，排队操作已取消。');
      signal?.throwIfAborted();
      return task();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  getState() { return structuredClone(this.state); }

  async saveConfig(input) {
    if (this.child) throw new Error('请先停止网关，再修改连接配置。');
    this.config = validateConfig(input, this.config);
    this.ctx.storage.set('config', this.config);
    this.client = new GatewayClient(this.config.port, this.hostId, this.controller.signal);
    this.state.config = this.config;
    return this.getState();
  }

  async start() {
    if (this.child) return this.refresh();
    // 意外退出会中止旧连接；再次启动时使用新的请求信号。
    if (this.controller.signal.aborted && !this.closed && !this.stopping) {
      this.controller = new AbortController();
      this.client = new GatewayClient(this.config.port, this.hostId, this.controller.signal);
    }
    const generation = this.generation;
    const signal = this.controller.signal;
    const assertStarting = () => {
      if (this.closed || this.stopping || this.ctx.signal.aborted || signal.aborted || this.generation !== generation) throw new Error('网关启动已取消。');
    };
    assertStarting();
    if (process.platform !== 'win32') throw new Error('0.1.0 目前仅支持 Windows。');
    const { stdout } = await this.runFile(this.config.nodePath, ['--version'], { windowsHide: true, timeout: 5000 });
    assertStarting();
    checkNodeVersion(stdout);
    const entry = path.join(this.vendorDir, 'lib', 'runtime', 'gateway.js');
    await fs.access(entry);
    // 每次启动独立保存队列，旧网关遗留的排队任务不能在新连接中自动执行。
    const workdir = path.join(this.root, 'gateway', crypto.randomUUID());
    await fs.mkdir(workdir, { recursive: true });
    const configPath = path.join(workdir, 'cyrene-gateway.json');
    await fs.writeFile(configPath, '{}\n', 'utf8');
    assertStarting();
    this.logs = '';
    this.state.gateway.error = null;
    const child = spawn(this.config.nodePath, [entry], {
      cwd: workdir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, DSH_HOST_ID: this.hostId,
        DSH_BLENDER_GATEWAY_PORT: String(this.config.port), DSH_BLENDER_WORKDIR: workdir,
        DSH_QUEUE_STATE: path.join(workdir, 'state', 'queue.json'),
        DSH_BLENDER_CONFIG: configPath, DSH_BLENDER_VIRTUAL_GUI: 'off',
        ...(this.config.blenderPath ? { DSH_BLENDER_EXE: this.config.blenderPath } : {}),
      },
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { this.logs = (this.logs + b.toString('utf8')).slice(-16000); });
    child.on('error', error => { if (this.child === child) this.state.gateway.error = error.message; });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.session = null;
      this.state.gateway.running = false;
      this.state.gateway.owned = false;
      this.state.instances = [];
      this.state.selectedInstanceId = null;
      if (!this.stopping) {
        this.generation++;
        this.controller.abort();
        this.interruptJobs('网关连接已中断，无法继续确认任务执行状态；请检查 Blender 后再提交。');
        this.state.gateway.error = `网关已退出 (${code ?? signal})。${this.logs.slice(-2000)}`;
      }
    });
    try {
      for (let i = 0; i < 50; i++) {
        if (!this.child) throw new Error(this.state.gateway.error || this.logs || '网关启动失败。');
        try {
          const health = await this.client.request('/health', undefined, { timeout: 700 });
          if (health.gateway?.hostId !== this.hostId || health.gateway?.pid !== child.pid) throw new Error('端口由其他进程占用，请换一个端口。');
          this.state.gateway = { running: true, owned: true, health, error: null };
          return this.refresh();
        } catch (error) {
          if (error.message.includes('端口由')) throw error;
        }
        await delay(200, undefined, { signal: this.controller.signal });
      }
      throw new Error(`网关启动超时。${this.logs.slice(-2000)}`);
    } catch (error) {
      await this.stop();
      this.state.gateway.error = error.message;
      throw error;
    }
  }

  async health(signal) {
    if (!this.child) throw new Error('请先在插件面板启动网关。');
    const health = await this.client.request('/health', undefined, { signal, timeout: 3000 });
    if (health.gateway?.hostId !== this.hostId || health.gateway?.pid !== this.child?.pid) throw new Error('网关归属不匹配，已停止发送操作。');
    this.state.gateway = { running: true, owned: true, health, error: null };
    return health;
  }

  async connected(signal) {
    await this.health(signal);
    this.state.instances = [];
    const doctor = await this.client.request('/doctor', undefined, { signal });
    const addon = doctor.addon;
    if (addon?.kind !== 'ok' || addon.protocol !== 12 || !addon.instanceId) {
      this.state.instances = [];
      throw new Error(`Blender 尚不可用：${addon?.root_cause || addon?.reason || addon?.kind || '请检查扩展连接'}。首版要求网关仅连接一个 Blender 实例。`);
    }
    this.state.instances = [{ instanceId: addon.instanceId, name: addon.instanceId, status: 'ready', ready: true }];
    if (this.state.selectedInstanceId && this.state.selectedInstanceId !== addon.instanceId) throw new Error('当前连接的 Blender 已改变，请重新选择实例。');
    this.state.selectedInstanceId = addon.instanceId;
    return addon.instanceId;
  }

  async ensureSession(signal) {
    const instanceId = await this.connected(signal);
    const result = await this.client.request('/lease', { action: 'attach', kind: 'user-gui', instanceId }, { signal });
    this.session = result.session;
    if (!this.session?.id) throw new Error('网关没有返回有效会话。');
    if (this.session.paused) throw new Error('Blender 控制已暂停，请在 Blender 中恢复后继续。');
    return this.session.id;
  }

  async selectInstance(input) {
    if (!input || typeof input.instanceId !== 'string') throw new Error('实例标识无效。');
    const previous = this.state.selectedInstanceId;
    this.state.selectedInstanceId = null;
    try {
      const actual = await this.connected();
      if (actual !== input.instanceId) throw new Error('该实例已断开。');
      this.state.selectedInstanceId = actual;
    } catch (error) { this.state.selectedInstanceId = previous; throw error; }
    return this.getState();
  }

  async act(code, signal) {
    const sessionId = await this.ensureSession(signal);
    const reply = await this.client.request('/act', { sessionId, py: true, write_scope: 'exclusive', code, timeoutMs: 20000, waitMs: 1000 }, { signal, timeout: 25000 });
    return scripts.parseResult(reply);
  }

  async inspect(signal) {
    this.state.scene = await this.act(scripts.inspectScript(), signal);
    return this.state.scene;
  }

  async transform(input, signal) {
    const code = scripts.transformScript(input);
    const result = await this.act(code, signal);
    this.state.scene = null;
    return result;
  }

  async capture(signal) {
    await this.ensureSession(signal);
    const png = await this.client.request('/frame.png?size=1280', undefined, { binary: true, signal, timeout: 25000 });
    const folder = path.join(this.config.outputDir, 'previews');
    await fs.mkdir(folder, { recursive: true });
    const filePath = path.join(folder, `${Date.now()}-${crypto.randomUUID()}.png`);
    await fs.writeFile(filePath, png, { flag: 'wx' });
    this.state.preview = { filePath, dataUrl: `data:image/png;base64,${png.toString('base64')}`, capturedAt: new Date().toISOString() };
    return { filePath, capturedAt: this.state.preview.capturedAt, hint: '需要图像分析时，使用 Cyrene 的 Read 工具读取此绝对路径。' };
  }

  async saveCopy(signal) {
    const folder = path.join(this.config.outputDir, 'snapshots');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, `${Date.now()}-${crypto.randomUUID()}.blend`);
    const result = await this.act(scripts.snapshotScript(file), signal);
    await fs.access(file);
    return result;
  }

  async render(input = {}, signal) {
    if (!['still', 'animation'].includes(input.kind)) throw new Error('渲染类型必须为 still 或 animation。');
    if (!this.config.blenderPath) throw new Error('请先配置 Blender 可执行文件的完整路径。');
    const percentage = scripts.number(input.resolutionPercentage ?? 50, '分辨率百分比', 1, 100, true);
    const scene = await this.inspect(signal);
    const fps = scripts.number(input.fps === undefined ? scene.fps : input.fps, '帧率', 1, 120, true);
    const fpsBase = input.fps === undefined ? scripts.number(scene.fpsBase ?? 1, '帧率基数', Number.MIN_VALUE, Number.MAX_VALUE) : 1;
    const start = scripts.number(input.frameStart ?? (input.kind === 'still' ? scene.frame : scene.frameStart), '起始帧', 0, 100000, true);
    const end = scripts.number(input.kind === 'still' ? start : (input.frameEnd ?? scene.frameEnd), '结束帧', start, Math.min(start + 3599, 100000), true);
    const folder = path.join(this.config.outputDir, 'renders', `${Date.now()}-${crypto.randomUUID()}`);
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, 'scene.blend');
    const saved = await this.act(scripts.snapshotScript(file, { fps, fpsBase }), signal);
    await fs.access(file);
    const resolution = saved.resolution.map(x => Math.max(4, Math.round(scripts.number(x, '场景分辨率', 4, 32768, true) * percentage / 100)));
    const outputDir = path.join(folder, 'frames');
    const response = await this.client.request('/job', { surface: 'queue', op: 'submit', kind: 'render', file, frames: [start, end], resolution, format: 'PNG', output: outputDir + path.sep, outdir: outputDir, timeout_ms: 3600000 }, { signal });
    if (!response.job?.id) throw new Error('网关没有返回渲染任务编号。');
    const job = { ...response.job, outputDir, snapshot: file, fps, fpsBase, frameStart: start, frameEnd: end };
    this.state.jobs = [job, ...this.state.jobs];
    this.trimJobHistory();
    return job;
  }

  trimJobHistory() {
    let history = 0;
    // 活动任务必须始终可查询和取消，只裁剪已经结束的历史记录。
    this.state.jobs = this.state.jobs.filter(job => !terminal.has(job.state) || ++history <= 100);
  }

  interruptJobs(reason) {
    for (const job of this.state.jobs) {
      if (!terminal.has(job.state)) { job.state = 'failed'; job.error = reason; }
    }
    this.trimJobHistory();
  }

  async updateJob(tracked, pendingResponse) {
    const generation = this.generation;
    const revision = {};
    this.jobUpdates.set(tracked, revision);
    const response = await pendingResponse;
    // 查询和取消可能并发，较早请求的回执不能覆盖更新的操作。
    if (generation !== this.generation || this.jobUpdates.get(tracked) !== revision) return structuredClone(tracked);
    const candidate = { ...tracked, ...response.job };
    if (candidate.state === 'completed') {
      const files = await fs.readdir(candidate.outputDir).catch(() => []);
      if (generation !== this.generation || this.jobUpdates.get(tracked) !== revision) return structuredClone(tracked);
      candidate.renderedFrames = files.filter(name => /\.png$/i.test(name)).length;
      if (candidate.renderedFrames < candidate.frameEnd - candidate.frameStart + 1) {
        candidate.state = 'failed';
        candidate.error = artifactError;
      } else if (candidate.error === artifactError) delete candidate.error;
    }
    // 验收结束后一次性更新可见状态，避免检查期间短暂显示“已完成”。
    Object.assign(tracked, candidate);
    if (!Object.hasOwn(candidate, 'error')) delete tracked.error;
    this.trimJobHistory();
    return structuredClone(tracked);
  }

  async jobStatus(id, signal) {
    const tracked = this.state.jobs.find(x => x.id === id);
    if (!tracked) throw new Error('只能查看或取消本次插件会话创建的任务。');
    await this.health(signal);
    return this.updateJob(tracked, this.client.request('/job', { surface: 'queue', op: 'status', id }, { signal }));
  }

  async cancelJob(input, signal) {
    const tracked = this.state.jobs.find(x => x.id === input?.id);
    if (!tracked) throw new Error('只能取消本次插件会话创建的任务。');
    await this.health(signal);
    return this.updateJob(tracked, this.client.request('/job', { surface: 'queue', op: 'cancel', id: tracked.id }, { signal, timeout: 3000 }));
  }

  async refresh(signal) {
    try {
      await this.connected(signal);
    } catch (error) { this.state.gateway.error = error.message; }
    if (this.child && this.state.gateway.owned) {
      await Promise.all(this.state.jobs.filter(x => !terminal.has(x.state)).map(async job => {
        try { await this.jobStatus(job.id, signal); } catch (error) { this.state.gateway.error = error.message; }
      }));
    }
    return this.getState();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopImpl().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async stopImpl() {
    this.stopping = true;
    this.generation++;
    this.controller.abort();
    const cleanupClient = new GatewayClient(this.config.port, this.hostId);
    const child = this.child;
    if (child) {
      // 先取消本插件作业，再结束自己启动的进程树；不接管或终止其他网关。
      await Promise.allSettled([
        ...this.state.jobs.filter(x => !terminal.has(x.state)).map(async job => {
          await this.updateJob(job, cleanupClient.request('/job', { surface: 'queue', op: 'cancel', id: job.id }, { timeout: 1000 }));
        }),
        ...(this.session ? [cleanupClient.request('/release', { sessionId: this.session.id }, { timeout: 1000 })] : []),
      ]);
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }).catch(() => child.kill());
        } else child.kill('SIGTERM');
      }
    }
    // 没有网关或未拿到取消回执时，不能宣称后台渲染进程已被终止。
    this.interruptJobs(child ? '网关已停止，未能确认任务取消结果；请检查 Blender 后再提交。' : '网关连接已中断，无法确认任务执行状态；请检查 Blender 后再提交。');
    this.child = null;
    this.session = null;
    this.state.gateway = { running: false, owned: false, health: null, error: null };
    this.state.instances = [];
    this.state.selectedInstanceId = null;
    if (!this.closed) {
      this.controller = new AbortController();
      this.client = new GatewayClient(this.config.port, this.hostId, this.controller.signal);
    }
    this.stopping = false;
    return this.getState();
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    await this.stop();
    this.controller.abort();
  }
}

module.exports = { BlenderService, validateConfig, checkNodeVersion };
