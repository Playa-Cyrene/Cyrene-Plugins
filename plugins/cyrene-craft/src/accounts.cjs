"use strict";

/**
 * 账户库。
 *
 * 设计要点：
 *   - **密码不落这里**。密码走宿主的 secrets 服务（ctx.deps.secrets），
 *     这个文件只存元数据：id / 名字 / 类型 / 服务器 / 是否已存凭据。
 *   - 文件权限尽量收紧（Windows 上 chmod 效果有限，但至少不是明文密码）
 *   - 读取时容错：文件坏了返回空库，不让插件因此起不来
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE_VERSION = 1;

/** 生成一个短 id，用于在工具返回值里指代账户（不暴露账号名） */
function newId() {
  return crypto.randomBytes(6).toString("hex");
}

/** 校验并归一化服务器地址（host[:port]） */
function normalizeServer(input) {
  const text = String(input || "").trim();
  if (!text) return null;

  // 允许带协议前缀，统一剥掉
  const cleaned = text.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");

  const lastColon = cleaned.lastIndexOf(":");
  if (lastColon > 0 && cleaned.indexOf("]") === -1) {
    const host = cleaned.slice(0, lastColon);
    const port = Number(cleaned.slice(lastColon + 1));
    if (Number.isFinite(port) && port > 0 && port <= 65535) return { host, port };
  }

  return { host: cleaned, port: 25565 };
}

class AccountStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir 插件私有数据目录
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    this.file = path.join(opts.dataDir, "accounts.json");
    this.log = opts.log || (() => {});
    this.accounts = this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || raw.version !== FILE_VERSION || !Array.isArray(raw.accounts)) return [];
      // 只信任结构正确的条目，坏数据直接丢，避免后面到处判空
      return raw.accounts.filter(
        (a) => a && typeof a.id === "string" && typeof a.name === "string" && typeof a.type === "string",
      );
    } catch (e) {
      this.log(`账户库读取失败，按空库处理：${e.message}`);
      return [];
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const payload = { version: FILE_VERSION, accounts: this.accounts };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`账户库写入失败：${e.message}`);
      throw new Error(`账户库写入失败：${e.message}`);
    }
  }

  /** 列出所有账户（不含任何敏感字段） */
  list() {
    return this.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      server: a.server || null,
      hasCredential: Boolean(a.hasCredential),
      lastUsedAt: a.lastUsedAt || null,
      createdAt: a.createdAt || null,
    }));
  }

  /** 按 id / 名字 / 服务器模糊搜索 */
  search(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((a) => {
      const hay = [a.id, a.name, a.type, a.server && a.server.host].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  get(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  /** 按名字找（连接时用户可能直接给游戏名） */
  findByName(name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return null;
    return this.accounts.find((a) => a.name.toLowerCase() === n) || null;
  }

  /** 新增或更新。existingId 传入则更新 */
  upsert(input) {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("账户名不能为空");
    if (name.length > 16) throw new Error("游戏角色名不能超过 16 个字符");

    const type = input.type === "yggdrasil" ? "yggdrasil" : "offline";
    const server = input.server ? normalizeServer(input.server) : null;

    let record = input.id ? this.get(String(input.id)) : this.findByName(name);

    if (!record) {
      record = {
        id: newId(),
        name,
        type,
        server,
        hasCredential: false,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      this.accounts.push(record);
    } else {
      record.name = name;
      record.type = type;
      if (server) record.server = server;
    }

    if (typeof input.hasCredential === "boolean") record.hasCredential = input.hasCredential;

    this.#save();
    return this.list().find((a) => a.id === record.id);
  }

  /** 标记最近使用 */
  touch(id) {
    const record = this.get(id);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
    try {
      this.#save();
    } catch {
      /* 只更新使用时间，失败不影响连接 */
    }
  }

  remove(id) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length === before) return false;
    this.#save();
    return true;
  }

  /** 默认账户：最近使用过的那个 */
  defaultAccount() {
    const used = this.accounts
      .filter((a) => a.lastUsedAt)
      .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
    return used[0] || this.accounts[0] || null;
  }
}

module.exports = { AccountStore, normalizeServer, newId, FILE_VERSION };
