"use strict";

/**
 * BotBridge —— 宿主侧的机器人子进程管理器。
 *
 * 为什么要有这一层：
 *   mineflayer 是长连接状态机，一次卡死或未捕获异常就会让整个进程不可用。
 *   放进子进程后，宿主只面对一条行协议：子进程崩了可以单独 kill + 重启，
 *   宿主插件本身永远不受影响。
 *
 * 关键设计：
 *   - 用 ELECTRON_RUN_AS_NODE=1 让 electron.exe 当普通 node 跑，用户不用装 Node
 *   - 请求-响应靠自增 id + Map 配对，每条请求都有硬超时
 *   - 崩溃重启最多 3 次，连续失败就停在 disconnected，不无限重试
 *   - 连接成功稳定运行 60 秒后重启计数清零（避免「每 10 分钟崩一次」被当成稳定）
 */

const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { encode, createDecoder, isResponse, isEvent } = require("./protocol.cjs");

/**
 * Windows 上子进程写 stdout 时会按控制台 OEM 代码页编码。
 * 本机 chcp 是 437（美式英语），中文字节会被压成 ? 和乱码，
 * 行协议里的错误信息就成了天书。
 *
 * 解法：用 cmd /d /s /c "chcp 65001 > nul && set ... && node ..." 拉起子进程，
 * 让它的 stdout 走 UTF-8。非 Windows 或拿不到 cmd 时退回原方式。
 */
const IS_WINDOWS = process.platform === "win32";

/**
 * 拼一个安全的 cmd 命令行。
 * 用 /d /s /c 关掉 AutoRun 与额外引号解析，避免路径里的空格把命令切碎。
 */
function buildWindowsCommand(exe, argv) {
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const parts = [quote(exe), ...argv.map(quote)];
  // chcp 的输出重定向掉，否则会混进 stdout 把第一条消息弄坏
  return `chcp 65001 > nul && ${parts.join(" ")}`;
}

/** 连接成功后存活超过这个时长，重启计数清零 */
const STABLE_CONNECTION_MS = 60_000;
/** 意外退出后等多久重连 */
const RESTART_DELAY_MS = 5_000;
/** 连续自动重启上限 */
const MAX_RESTARTS = 3;

/** 各类命令的超时（毫秒）。长任务单独放宽，但要保证一定会返回。 */
const TIMEOUTS = {
  default: 15_000,
  connect: 60_000,
  status: 10_000,
  query: 15_000,
  move: 120_000,
  dig: 60_000,
  place: 30_000,
  collect: 10 * 60_000,
  craft: 60_000,
  smelt: 10 * 60_000,
  attack: 120_000,
  build: 10 * 60_000,
  sequence: 10 * 60_000,
};

/** Windows 下递归杀进程树 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已经没了 */
      }
    }
    resolve();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class BotBridge {
  /**
   * @param {object} opts
   * @param {string} opts.runtimeEntry   bot-runtime.cjs 的绝对路径
   * @param {string} opts.nodeModulesDir mineflayer 所在 node_modules 目录
   * @param {string} opts.dataDir        插件私有数据目录
   * @param {(msg:string)=>void} opts.log
   * @param {(event:string, data:any)=>void} opts.onEvent 事件回调（上游订阅用）
   */
  constructor(opts) {
    this.runtimeEntry = opts.runtimeEntry;
    this.nodeModulesDir = opts.nodeModulesDir;
    this.dataDir = opts.dataDir;
    this.log = opts.log || (() => {});
    this.onEventRaw = opts.onEvent || (() => {});

    this.child = null;
    this.state = "disconnected"; // disconnected / starting / connected / stopping
    this.opts = null; // 最近一次连接参数
    this.connectedAt = 0;
    this.restartCount = 0;
    this.userStopped = true;
    this.lastError;

    /** 等待响应的请求：id -> { resolve, reject, timer } */
    this.pending = new Map();
    this.seq = 0;

    /** 最近事件环形缓冲，供 mc_events 之类按需拉取 */
    this.events = [];
    this.maxEvents = 200;

    /** 最近一次状态快照，UI 轮询用（不用每次都打子进程） */
    this.snapshot = this.#emptySnapshot();

    /** 状态订阅者 */
    this.stateListeners = [];
    /** 聊天订阅者：fn(player, message) */
    this.chatListeners = [];
    /** 任意事件订阅者：fn(eventName, data) */
    this.eventListeners = [];
  }

  #emptySnapshot() {
    return {
      state: "disconnected",
      host: null,
      port: null,
      username: null,
      position: null,
      health: null,
      food: null,
      inventory: [],
      players: [],
      currentTask: null,
      recentChat: [],
      lastError: null,
      restartCount: 0,
      gameMode: null,
      dimension: null,
    };
  }

  /* ----------------------------- 订阅 ----------------------------- */

  onStateChange(fn) {
    this.stateListeners.push(fn);
    return () => {
      this.stateListeners = this.stateListeners.filter((f) => f !== fn);
    };
  }

  onChat(fn) {
    this.chatListeners.push(fn);
    return () => {
      this.chatListeners = this.chatListeners.filter((f) => f !== fn);
    };
  }

  onEvent(fn) {
    this.eventListeners.push(fn);
    return () => {
      this.eventListeners = this.eventListeners.filter((f) => f !== fn);
    };
  }

  #notifyState() {
    for (const fn of [...this.stateListeners]) {
      try {
        fn(this.state);
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    }
  }

  /* --------------------------- 进程生命周期 --------------------------- */

  /** 启动子进程（不连接服务器，只是把跑 mineflayer 的环境拉起来） */
  async start() {
    if (this.child && this.state !== "disconnected") return;
    await this.#spawn();
  }

  #spawn() {
    return new Promise((resolve, reject) => {
      if (!this.runtimeEntry) return reject(new Error("缺少 bot-runtime 入口路径"));

      this.state = "starting";
      this.#notifyState();

      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CYRENE_CRAFT_NODE_MODULES: this.nodeModulesDir,
        CYRENE_CRAFT_DATA: this.dataDir,
        // 让子进程不要尝试弹任何窗口 / 用 GPU
        ELECTRON_NO_ATTACH_CONSOLE: "1",
      };

      let child;
      try {
        child = spawn(process.execPath, [this.runtimeEntry], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        this.state = "disconnected";
        this.#notifyState();
        return reject(e);
      }

      this.child = child;
      let ready = false;
      let stderrTail = "";

      const decoder = createDecoder(
        (msg) => this.#handleMessage(msg, () => {
          if (!ready) {
            ready = true;
            resolve();
          }
        }),
        (err) => this.log(`[bridge] 协议错误：${err.message}`),
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", decoder);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        // 子进程的 stderr 是它的错误输出，原样记一份便于排查
        const text = String(chunk).trim();
        if (text) this.log(`[runtime] ${text}`);
      });

      child.on("error", (e) => {
        this.lastError = e.message;
        if (!ready) {
          ready = true;
          reject(e);
        }
      });

      child.on("close", (code) => {
        const wasConnected = this.state === "connected";
        this.child = null;
        this.#failAllPending(new Error(`机器人进程已退出（code=${code}）`));

        if (this.userStopped) {
          this.state = "disconnected";
          this.#notifyState();
          return;
        }

        // 非用户主动停止 -> 意外退出，考虑自动重启
        const uptime = this.connectedAt ? Date.now() - this.connectedAt : 0;
        if (wasConnected && uptime > STABLE_CONNECTION_MS) this.restartCount = 0;

        if (this.restartCount < MAX_RESTARTS && this.opts) {
          this.restartCount += 1;
          this.lastError = `机器人进程意外退出（code=${code}），第 ${this.restartCount} 次自动重连`;
          this.log(`[bridge] ${this.lastError}`);
          this.state = "starting";
          this.#notifyState();
          sleep(RESTART_DELAY_MS).then(() => {
            if (this.userStopped) return;
            this.#spawn()
              .then(() => this.request("connect", this.opts, "connect"))
              .then(() => {
                this.state = "connected";
                this.connectedAt = Date.now();
                this.#notifyState();
              })
              .catch((e) => {
                this.lastError = e.message;
                this.state = "disconnected";
                this.#notifyState();
              });
          });
        } else {
          this.lastError =
            this.lastError ||
            (stderrTail ? `机器人进程退出：${stderrTail.slice(-300)}` : `机器人进程退出（code=${code}）`);
          this.state = "disconnected";
          this.#notifyState();
        }
      });
    });
  }

  /** 消息分发：响应配给等待者，事件转给订阅者 */
  #handleMessage(msg, onReady) {
    if (msg && msg.kind === "ready") {
      this.log(`[bridge] 运行时就绪 pid=${msg.pid} mineflayer=${msg.mineflayerVersion || "?"}`);
      onReady();
      return;
    }

    if (isResponse(msg)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return; // 超时后迟到的响应，丢弃
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error || "子进程返回失败"));
      return;
    }

    if (isEvent(msg)) {
      this.#handleEvent(msg.event, msg.data);
    }
  }

  #handleEvent(event, data) {
    // 环形缓冲
    this.events.push({ event, data, at: Date.now() });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);

    switch (event) {
      case "state":
        if (data && data.state) {
          this.state = data.state;
          if (data.state === "connected") this.connectedAt = Date.now();
          this.#notifyState();
        }
        break;
      case "chat":
        this.snapshot.recentChat.push({ player: data.player, message: data.message, at: Date.now() });
        if (this.snapshot.recentChat.length > 50) this.snapshot.recentChat.shift();
        for (const fn of [...this.chatListeners]) {
          try {
            fn(data.player, data.message, data);
          } catch (e) {
            this.log(`[bridge] 聊天订阅者异常：${e.message}`);
          }
        }
        break;
      case "system":
        this.snapshot.recentChat.push({ player: null, message: data.message, at: Date.now() });
        if (this.snapshot.recent > 50) this.snapshot.recentChat.shift();
        break;
      case "status":
        // 子进程定期推送的状态快照，直接覆盖 UI 用的缓存
        this.snapshot = { ...this.snapshot, ...data, state: this.state };
        break;
      case "inventory":
        this.snapshot.inventory = Array.isArray(data) ? data : [];
        break;
      case "task":
        this.snapshot.currentTask = data && data.label ? data.label : null;
        break;
      case "instinct":
        // 本能层刚刚自己做了什么，记下来给提示词用
        this.snapshot.instinctLastAction = data && data.kind ? data.kind : null;
        this.snapshot.instinctActionAgeMs = 0;
        this.instinctActionAt = Date.now();
        break;
      case "error":
        this.lastError = data && data.message ? data.message : String(data);
        break;
      default:
        break;
    }

    for (const fn of [...this.eventListeners]) {
      try {
        fn(event, data);
      } catch {
        /* 订阅者异常不影响通道 */
      }
    }
    this.onEventRaw(event, data);
  }

  #failAllPending(err) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  /** 发一条请求并等待响应，带硬超时 */
  request(cmd, args = {}, kind = "default") {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        reject(new Error("机器人进程未启动。请先调用 connect 工具"));
        return;
      }

      const id = ++this.seq;
      const timeoutMs = TIMEOUTS[kind] ?? TIMEOUTS.default;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`命令 ${cmd} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.child.stdin.write(encode({ id, cmd, args }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /* ----------------------------- 对外动作 ----------------------------- */

  /** 连接服务器 */
  async connect({ host, port = 25565, username = "Cyrene", auth = "offline", password = null, version = null }) {
    this.userStopped = false;
    this.restartCount = 0;
    this.opts = { host, port, username, auth, password, version };
    this.lastError = null;

    await this.start();
    const data = await this.request("connect", this.opts, "connect");
    this.state = "connected";
    this.connectedAt = Date.now();
    this.#notifyState();
    return data;
  }

  /** 主动断开（用户操作），不会触发自动重连 */
  async disconnect() {
    this.userStopped = true;
    try {
      if (this.child) await this.request("disconnect", {}, "default");
    } catch {
      /* 子进程可能已经没了，忽略 */
    }
    await this.stop();
    return this.status();
  }

  /** 彻底停掉子进程 */
  async stop() {
    this.userStopped = true;
    const child = this.child;
    this.child = null;
    this.state = "stopping";
    this.#notifyState();

    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      await killTree(child.pid);
    }

    this.#failAllPending(new Error("机器人进程已停止"));
    this.state = "disconnected";
    this.connectedAt = 0;
    this.#notifyState();
  }

  /** 当前状态快照（融合缓存与实时字段） */
  status() {
    const ageMs = this.instinctActionAt ? Date.now() - this.instinctActionAt : null;
    return {
      ...this.snapshot,
      state: this.state,
      lastError: this.lastError,
      restartCount: this.restartCount,
      host: this.opts ? this.opts.host : null,
      port: this.opts ? this.opts.port : null,
      username: this.opts ? this.opts.username : null,
      instinctActionAgeMs: ageMs,
    };
  }

  /** 取走未消费的事件（mc_events 用），并从缓冲删掉 */
  takeEvents(limit = 50, filter = null) {
    const picked = [];
    const remain = [];
    for (const item of this.events) {
      if (picked.length < limit && (!filter || filter(item))) picked.push(item);
      else remain.push(item);
    }
    this.events = remain;
    return picked;
  }

  /** 正在跑什么（用于 stop 工具与 UI） */
  isRunning() {
    return Boolean(this.child) && this.state !== "disconnected" && this.state !== "stopping";
  }
}

module.exports = { BotBridge, TIMEOUTS, MAX_RESTARTS, STABLE_CONNECTION_MS };
