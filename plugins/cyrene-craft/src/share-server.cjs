"use strict";

/**
 * 文件分享服务。
 *
 * 为什么自己起一个 http 服务而不是复用宿主的 webServer：
 *   Cyrene 插件没有 DSH 那种 `ctx.webServer` 挂载点。桌面端最朴素也最可靠的做法
 *   就是自己监听一个只绑 127.0.0.1 的端口，把指定目录托管出去。
 *
 * 安全约束（三条都必须满足）：
 *   1. 只监听 127.0.0.1，不接受外部连接
 *   2. 只服务白名单根目录内的文件，路径穿越一律拒
 *   3. 只提供 GET/HEAD，不做任何写操作
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

/** 默认端口；被占用时可以换 */
const DEFAULT_PORT = 16050;

/** 允许分享的文件类型 -> Content-Type */
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/octet-stream",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
};

function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/** 判断 child 是否在 root 内部（防 ../ 与符号链接穿越） */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

class ShareServer {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir  允许分享的根目录（记忆树的 share 子目录）
   * @param {number} opts.port
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    this.rootDir = opts.rootDir;
    this.port = Number(opts.port) || DEFAULT_PORT;
    this.log = opts.log || (() => {});
    this.server = null;
    this.actualPort = null;
    this.error = null;
  }

  get running() {
    return Boolean(this.server && this.server.listening);
  }

  /** 启动；失败不抛，只记录错误供 UI 显示 */
  async start() {
    if (this.running) return { ok: true, port: this.actualPort, url: this.baseUrl() };

    fs.mkdirSync(this.rootDir, { recursive: true });

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.#handle(req, res));

      server.on("error", (e) => {
        this.error = e.code === "EADDRINUSE" ? `端口 ${this.port} 已被占用` : e.message;
        this.server = null;
        this.log(`文件分享启动失败：${this.error}`);
        resolve({ ok: false, error: this.error });
      });

      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        this.actualPort = server.address().port;
        this.error = null;
        this.log(`文件分享已启动：${this.baseUrl()}`);
        resolve({ ok: true, port: this.actualPort, url: this.baseUrl() });
      });
    });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    if (!server) return { ok: true };
    return new Promise((resolve) => {
      server.close(() => resolve({ ok: true }));
      // 兜底：2 秒还没关掉就强制断
      setTimeout(() => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        resolve({ ok: true });
      }, 2000).unref?.();
    });
  }

  baseUrl() {
    return this.actualPort ? `http://127.0.0.1:${this.actualPort}` : null;
  }

  /** 把一个文件路径转成可直接给前端用的 http 地址 */
  urlFor(filePath) {
    if (!this.running) return null;
    const abs = path.resolve(filePath);
    if (!isInside(this.rootDir, abs)) return null;
    const rel = path.relative(this.rootDir, abs).split(path.sep).map(encodeURIComponent).join("/");
    return `${this.baseUrl()}/${rel}`;
  }

  #handle(req, res) {
    // 只允许只读方法
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end("Bad Request");
      return;
    }

    // 解析目标路径并做穿越检查
    const target = path.resolve(this.rootDir, "." + pathname);

    if (target !== this.rootDir && !isInside(this.rootDir, target)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    if (stat.isDirectory()) {
      // 目录不给列表，只回一句提示，避免暴露文件结构
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Directory listing disabled");
      return;
    }

    const headers = {
      "content-type": mimeOf(target),
      "content-length": stat.size,
      "cache-control": "no-store",
      // 即使是本机服务也不让别的页面随便嵌进来
      "x-content-type-options": "nosniff",
    };

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(target);
    stream.on("error", () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
    stream.pipe(res);
  }
}

module.exports = { ShareServer, DEFAULT_PORT, mimeOf, isInside };
