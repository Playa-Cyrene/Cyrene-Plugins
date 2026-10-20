"use strict";

/**
 * 记忆树：`<工作区>/.cyrene-craft/`
 *
 * whale-craft 的对应物是 `.whale-craft/`。结构保持一致，方便迁移：
 *   README.md   索引（AI 自己维护）
 *   RULES.md    行事准则
 *   share/      可以对外分享的文件（文件分享服务只托管这个目录）
 *   其它任意文档
 *
 * 安全：所有路径都必须落在根目录内。这里不接受绝对路径，
 * 也拒绝 `..` 与符号链接逃逸——记忆树是 AI 会写的地方，不能让它变成任意文件读写。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR_NAME = ".cyrene-craft";

/** 单文件写入上限，避免一次写爆磁盘 */
const MAX_WRITE_BYTES = 4 * 1024 * 1024;

/** 默认索引内容 */
const DEFAULT_README = `# Cyrene Craft 记忆

这里是昔涟在 Minecraft 里的长期记忆。跨会话保留，重启不丢。

## 建议结构

- \`world.md\` —— 这个世界是什么样：地形、坐标、重要地点
- \`projects.md\` —— 正在做的事：在建什么、进度到哪
- \`people.md\` —— 遇到的玩家：谁是谁、怎么相处
- \`lessons.md\` —— 踩过的坑：什么方法行不通

## 约定

- 记事实，不记流水账
- 坐标写完整（x, y, z），别只写"那边"
- 每次做完一件大事，回来更新一次
`;

/** 默认行事准则 */
const DEFAULT_RULES = `# 行事准则

1. 不确定的时候先看，别先动手。\`map\` / \`scan\` / \`status\` 都是免费的。
2. 挖之前确认脚下不是空的，也别挖到别人的建筑。
3. 玩家说话先回应，再决定要不要做事。
4. 长任务（挖矿、建造）开始前说一句在做什么，结束说一句结果。
5. 记忆树是给自己看的，写清楚，下次才用得上。
`;

/**
 * 判断 child 是否严格位于 root 内部
 * 用 realpath 比较，防止通过符号链接逃出去
 */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

class MemoryStore {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir 记忆树根目录（<工作区>/.cyrene-craft）
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    this.rootDir = path.resolve(opts.rootDir);
    this.log = opts.log || (() => {});
  }

  get shareDir() {
    return path.join(this.rootDir, "share");
  }

  /** 首次使用时建目录与默认文件 */
  ensure() {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.shareDir, { recursive: true });

    const readme = path.join(this.rootDir, "README.md");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, DEFAULT_README, "utf8");

    const rules = path.join(this.rootDir, "RULES.md");
    if (!fs.existsSync(rules)) fs.writeFileSync(rules, DEFAULT_RULES, "utf8");
  }

  /**
   * 把用户/模型给的相对路径解析成绝对路径，并做越界检查。
   * 返回 null 表示越界（调用方按拒绝处理）。
   */
  resolve(relPath) {
    const text = String(relPath || "").replace(/\\/g, "/").trim();

    // 绝对路径直接拒：记忆树只接受相对路径
    if (path.isAbsolute(text) || /^[a-zA-Z]:/.test(text)) return null;

    const abs = path.resolve(this.rootDir, text);
    if (abs === this.rootDir) return abs;

    // 先做字面检查（能挡住大部分 ../）
    if (!isInside(this.rootDir, abs)) return null;

    // 再做真实路径检查（挡住符号链接逃逸）；目标不存在时只信任字面检查
    try {
      const realRoot = fs.realpathSync(this.rootDir);
      const realTarget = fs.realpathSync(abs);
      if (!isInside(realRoot, realTarget)) return null;
    } catch {
      /* 文件还不存在，字面检查已经足够 */
    }

    return abs;
  }

  /** 列目录（不递归） */
  list(relPath = "") {
    this.ensure();
    const dir = this.resolve(relPath);
    if (!dir) throw new Error("路径越界：记忆树只允许相对路径，且不能跑到根目录外");

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`读取目录失败：${e.message}`);
    }

    return entries
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = null;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* 读不到大小就算了 */
        }
        return {
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          size,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  /** 读文件（文本） */
  read(relPath, maxBytes = MAX_WRITE_BYTES) {
    this.ensure();
    const file = this.resolve(relPath);
    if (!file) throw new Error("路径越界：记忆树只允许相对路径");

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`文件不存在：${relPath}`);
    }
    if (stat.isDirectory()) throw new Error(`${relPath} 是目录，用 list 查看`);

    const limit = Math.min(maxBytes, MAX_WRITE_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(stat.size, limit));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8");
      return {
        path: relPath,
        size: stat.size,
        truncated: stat.size > limit,
        content: text,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 写文件（覆盖） */
  write(relPath, content) {
    this.ensure();
    const file = this.resolve(relPath);
    if (!file) throw new Error("路径越界：记忆树只允许相对路径");
    if (file === this.rootDir) throw new Error("不能把内容写到记忆树根目录本身");

    const data = Buffer.from(String(content ?? ""), "utf8");
    if (data.length > MAX_WRITE_BYTES) {
      throw new Error(`内容太大（${data.length} 字节），单文件上限 ${MAX_WRITE_BYTES} 字节`);
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名，避免写一半崩了留下坏文件
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);

    return { path: relPath, bytes: data.length };
  }

  /** 追加 */
  append(relPath, content) {
    this.ensure();
    const file = this.resolve(relPath);
    if (!file) throw new Error("路径越界：记忆树只允许相对路径");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, String(content ?? ""), "utf8");

    const size = fs.statSync(file).size;
    return { path: relPath, size };
  }

  /** 删除 */
  remove(relPath) {
    this.ensure();
    const file = this.resolve(relPath);
    if (!file) throw new Error("路径越界：记忆树只允许相对路径");
    if (file === this.rootDir) throw new Error("不能删除记忆树根目录");

    try {
      const stat = fs.statSync(file);
      if (stat.isDirectory()) {
        // 只有空目录才允许删，避免一条命令删掉整棵树
        const remain = fs.readdirSync(file);
        if (remain.length > 0) throw new Error(`目录 ${relPath} 不为空，先清空再删`);
        fs.rmdirSync(file);
      } else {
        fs.unlinkSync(file);
      }
      return { path: relPath, removed: true };
    } catch (e) {
      throw new Error(`删除失败：${e.message}`);
    }
  }

  /** 读行事准则（RULES.md） */
  readRules() {
    this.ensure();
    try {
      return fs.readFileSync(path.join(this.rootDir, "RULES.md"), "utf8");
    } catch {
      return DEFAULT_RULES;
    }
  }

  /** 把文件挪进 share 目录并返回相对路径（分享工具用） */
  ensureShareable(filePath) {
    this.ensure();
    const abs = path.resolve(String(filePath));
    const shareDir = path.resolve(this.shareDir);

    if (path.relative(shareDir, abs).startsWith("..")) {
      // 在 share 目录外：复制进来
      const name = path.basename(abs);
      const target = path.join(shareDir, name);
      fs.copyFileSync(abs, target);
      return target;
    }
    return abs;
  }
}

module.exports = { MemoryStore, ROOT_DIR_NAME, DEFAULT_README, DEFAULT_RULES, MAX_WRITE_BYTES };
