"use strict";

/**
 * mineflayer 运行时解析。
 *
 * 背景（实测数据）：
 *   完整依赖树 = 98.4 MB / 1808 个文件，而 Cyrene 插件 zip 上限是
 *   50 MiB / 2000 条目 / 解压后 200 MiB。所以**不能**把运行时打进插件包。
 *
 * 三级策略：
 *   1. 本插件自己的 plugin-data 目录（自装，最独立）
 *   2. 复用 minecraft-bot 插件自带的运行时（本机实测存在 mineflayer 4.39.0）
 *   3. 都没有 -> 用宿主自带的 Electron 二进制以 ELECTRON_RUN_AS_NODE 跑 npm 装到 1
 *
 * 每一级都要能失败而不抛，只在全部失败时给一条人能看懂的指引。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** 运行时子目录名；和 plugins/minecraft-bot 的布局保持一致便于复用 */
const RUNTIME_SUBDIR = path.join("runtime", "bot-runtime");

/** 自动安装时的超时：npm 装 mineflayer 通常 1-3 分钟，给足 8 分钟 */
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;

/** 要装的依赖；mineflayer 会带全部传递依赖 */
const INSTALL_PACKAGES = ["mineflayer@^4.39.0", "vec3@^0.1.7"];

/**
 * 判断某个目录里是不是有一份可用的 mineflayer。
 * 只查 package.json 存在 + 能找到 index.js，不做 require（避免在宿主进程里加载 98MB 依赖树）。
 */
function isUsableRuntime(nodeModulesDir) {
  try {
    const pkgPath = path.join(nodeModulesDir, "mineflayer", "package.json");
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (!pkg.name || pkg.name !== "mineflayer") return false;
    const entry = path.join(nodeModulesDir, "mineflayer", pkg.main || "index.js");
    return fs.existsSync(entry);
  } catch {
    return false;
  }
}

/** 读版本号，拿不到返回 null */
function runtimeVersion(nodeModulesDir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(nodeModulesDir, "mineflayer", "package.json"), "utf8"),
    );
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * 候选目录列表，按优先级排列。
 *
 * userDataDir 是 Cyrene 的 userData 根，形如 `%APPDATA%\Cyrene`；
 * dataDir 是本插件的私有数据目录 `…\Cyrene\plugin-data\cyrene-craft`。
 *
 * ⚠️ 不能拿 dataDir 的 dirname 当 userDataDir——那会得到
 *    `…\Cyrene\plugin-data`，再拼 plugins/... 就成了一个不存在的路径。
 *    这里显式从 dataDir 反推插件根目录，找不到就用 APPDATA 兜底。
 */
function candidateDirs({ dataDir, userDataDir }) {
  const list = [];

  // 1. 本插件自装
  list.push({
    source: "self",
    dir: path.join(dataDir, RUNTIME_SUBDIR, "node_modules"),
    label: "插件自装运行时",
  });

  // 2. 复用 minecraft-bot（同一套布局）
  for (const root of pluginRootCandidates({ dataDir, userDataDir })) {
    list.push({
      source: "minecraft-bot",
      dir: path.join(root, "plugins", "minecraft-bot", RUNTIME_SUBDIR, "node_modules"),
      label: "minecraft-bot 插件自带运行时",
    });
  }

  return list;
}

/**
 * 反推「插件根目录」（即 `%APPDATA%\Cyrene`，plugins/ 与 plugin-data/ 的父目录）。
 *
 * 多个候选都试一遍，第一条命中的生效；找不到时返回空数组，
 * 让上层直接走「自动安装」那条路，而不是拿着错路径去猜。
 */
function pluginRootCandidates({ dataDir, userDataDir }) {
  const roots = [];

  const push = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!roots.includes(resolved)) roots.push(resolved);
  };

  // 显式传入的（正常情况下就是对的）
  push(userDataDir);

  // 从 dataDir 反推：…/<root>/plugin-data/<id> → 上两级
  try {
    const fromData = path.resolve(path.dirname(path.dirname(dataDir)));
    push(fromData);
  } catch {
    /* 路径不正常就跳过 */
  }

  // 环境变量兜底
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, "Cyrene"));
  if (process.env.CYRENE_USER_DATA) push(process.env.CYRENE_USER_DATA);

  return roots;
}

/**
 * 解析出可用的 node_modules 目录。
 * 返回 { ok, dir, source, version, label } 或 { ok: false, reason, tried }
 */
function resolveRuntime(opts) {
  const tried = [];
  for (const candidate of candidateDirs(opts)) {
    const usable = isUsableRuntime(candidate.dir);
    tried.push({ source: candidate.source, dir: candidate.dir, usable });
    if (usable) {
      return {
        ok: true,
        dir: candidate.dir,
        source: candidate.source,
        label: candidate.label,
        version: runtimeVersion(candidate.dir),
        tried,
      };
    }
  }
  return { ok: false, reason: "没有找到可用的 mineflayer 运行时", tried };
}

/**
 * 拿到可以当 Node 用的可执行文件。
 *
 * Electron 应用里 process.execPath 指向 electron.exe，直接跑脚本会去开窗口；
 * 加 ELECTRON_RUN_AS_NODE=1 才变成普通 node。这样用户机器不需要单独装 Node。
 */
function nodeLikeExecutable() {
  const candidates = [];

  if (process.execPath) candidates.push({ exe: process.execPath, electronAsNode: true });

  // 万一宿主不是 Electron（比如开发调试直接跑 node），退回真正的 node
  if (process.env.CYRENE_CRAFT_NODE) {
    candidates.unshift({ exe: process.env.CYRENE_CRAFT_NODE, electronAsNode: false });
  }

  return candidates;
}

/** 跑一条命令，带超时，返回 { code, stdout, stderr } */
function runOnce(exe, argv, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, argv, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e && e.message ? e.message : e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
      resolve({ code: -2, stdout, stderr: `${stderr}\n安装超时（${INSTALL_TIMEOUT_MS} ms）` });
    }, INSTALL_TIMEOUT_MS);

    child.stdout.on("data", (c) => {
      stdout += c.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e && e.message ? e.message : e) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

/**
 * 自动安装运行时到本插件私有目录。
 *
 * 为什么用 `npm install --prefix <dir>` 而不是写 package.json 再 npm i：
 * --prefix 会直接把 node_modules 建在目标目录下，省掉一次「先写清单再读清单」的步骤，
 * 失败面更小。npm 本身从哪里来：优先宿主 Electron 里的 npm（打包时通常会带），
 * 其次系统 npm。
 */
async function installRuntime(opts) {
  const target = path.join(opts.dataDir, RUNTIME_SUBDIR);
  fs.mkdirSync(target, { recursive: true });

  const attempts = [];

  // 找 npm：先试 Electron 内置，再试系统 PATH 上的 npm
  const npmCandidates = [];
  if (process.env.npm_execpath) {
    // 从 npm 脚本里启动时能直接拿到 cli.js
    npmCandidates.push({
      exe: process.execPath,
      argv: [process.env.npm_execpath],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  npmCandidates.push({
    exe: process.platform === "win32" ? "npm.cmd" : "npm",
    argv: [],
    env: { ...process.env },
  });

  for (const npm of npmCandidates) {
    const argv = [
      ...npm.argv,
      "install",
      "--prefix",
      target,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...INSTALL_PACKAGES,
    ];

    const result = await runOnce(npm.exe, argv, { cwd: target, env: npm.env });
    attempts.push({ exe: npm.exe, code: result.code, tail: result.stderr.slice(-800) });

    if (result.code === 0 && isUsableRuntime(path.join(target, "node_modules"))) {
      return {
        ok: true,
        dir: path.join(target, "node_modules"),
        source: "self",
        label: "插件自装运行时（刚刚安装）",
        version: runtimeVersion(path.join(target, "node_modules")),
        attempts,
      };
    }
  }

  return {
    ok: false,
    reason:
      "无法自动安装 mineflayer。请任选一种方式解决：\n" +
      "1) 在「插件」面板启用 minecraft-bot 插件（它有现成运行时，本插件会自动复用）\n" +
      "2) 手动在该目录执行 npm install mineflayer vec3 ：\n   " +
      target,
    attempts,
  };
}

/** 给诊断工具用的详细报告 */
function describe(opts) {
  const resolved = resolveRuntime(opts);
  return {
    resolved: resolved.ok
      ? {
          ok: true,
          source: resolved.source,
          label: resolved.label,
          version: resolved.version,
          dir: resolved.dir,
        }
      : { ok: false, reason: resolved.reason },
    tried: resolved.tried.map((t) => ({
      source: t.source,
      dir: t.dir,
      usable: t.usable,
    })),
    dataDir: opts.dataDir,
    nodeExe: process.execPath,
  };
}

module.exports = {
  resolveRuntime,
  installRuntime,
  describe,
  isUsableRuntime,
  runtimeVersion,
  nodeLikeExecutable,
  RUNTIME_SUBDIR,
};
