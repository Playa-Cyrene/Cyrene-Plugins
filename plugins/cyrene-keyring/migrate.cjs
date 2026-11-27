"use strict";

/**
 * 旧插件数据迁移。
 *
 * 把散落在 cyrene-vault / gh-vault / bdpan-vault / cyrene-totp / app-settings 里的
 * 秘密读出来，转成钥匙环条目。只在主进程内存里停留，不写临时明文、不进日志、
 * 不出现在任何返回给面板或 Agent 的字段里。
 *
 * 旧数据的两种加密方式：
 * - cyrene-vault：PowerShell DPAPI（ConvertFrom-SecureString 的十六进制串）
 * - 其余三个：Electron safeStorage（Windows 下同样是 DPAPI）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const LEGACY_DPAPI = path.join(__dirname, "legacy-vault.ps1");

/**
 * 旧数据目录。优先问 Electron 的 userData（标准安装是 %APPDATA%/live2d-cyrene），
 * 再退回 %APPDATA%/Cyrene，避免只认一个目录导致「从旧插件导入」永远没有数据。
 */
function resolveAppDir() {
  const candidates = [];
  try {
    const electron = require("electron");
    if (electron && electron.app && typeof electron.app.getPath === "function") {
      candidates.push(electron.app.getPath("userData"));
    }
  } catch {
    /* 非 Electron 环境 */
  }
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  candidates.push(path.join(roaming, "live2d-cyrene"));
  candidates.push(path.join(roaming, "Cyrene"));
  for (const dir of candidates) {
    try {
      if (
        fs.existsSync(path.join(dir, "plugin-data")) ||
        fs.existsSync(path.join(dir, "app-settings.json"))
      ) {
        return dir;
      }
    } catch {
      /* 继续试下一个 */
    }
  }
  return candidates[0];
}

function pluginDataDir() {
  return path.join(resolveAppDir(), "plugin-data");
}

function settingsFile() {
  return path.join(resolveAppDir(), "app-settings.json");
}

/** 旧保险箱里已知的几个键名，按实际含义给标题和类型。 */
const VAULT_META = {
  "student-mail-password": { title: "学生邮箱", group: "邮箱", type: "password" },
  cluade: { title: "Claude", group: "AI", type: "password" },
  "cloudflare-vault": { title: "Cloudflare", group: "云服务", type: "password" },
  "cloudeflare-API": {
    title: "Cloudflare API",
    group: "云服务",
    type: "api_key",
    service: "cloudflare",
  },
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

function getSafeStorage() {
  try {
    const electron = require("electron");
    const safeStorage = electron && electron.safeStorage;
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch {
    /* 非 Electron 环境 */
  }
  return null;
}

/** 解开 { v, enc, data } 信封。 */
function decodeSafeRecord(record) {
  if (!record || typeof record !== "object") return "";
  if (!record.enc) return String(record.data || "");
  const safeStorage = getSafeStorage();
  if (!safeStorage) throw new Error("当前环境拿不到系统加密，解不开这条旧数据");
  return safeStorage.decryptString(Buffer.from(String(record.data || ""), "base64"));
}

/** 用 DPAPI 解旧保险箱的十六进制串。 */
function dpapiUnprotectHex(hex) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(
      os.tmpdir(),
      "cyrene-keyring-legacy-" +
        process.pid +
        "-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2) +
        ".tmp"
    );
    try {
      fs.writeFileSync(tmp, String(hex || ""), "utf8");
    } catch (error) {
      return reject(new Error("临时文件写入失败：" + messageOf(error)));
    }
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", LEGACY_DPAPI, "unprotect", tmp],
      { timeout: 20000, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 已删除 */
        }
        if (error) {
          return reject(
            new Error((stderr || error.message || "").trim() || "DPAPI 解密失败")
          );
        }
        resolve(String(stdout || "").replace(/\r?\n$/, ""));
      }
    );
  });
}

function guessType(key, value) {
  if (/api|token|key|secret/i.test(key)) return "api_key";
  if (/^(sk-|gh[pousr]_|xox[baprs]-|AKIA|glpat-)/.test(value)) return "api_key";
  return "password";
}

function fromVaultKey(key, value) {
  const meta = VAULT_META[key] || {};
  const type = meta.type || guessType(key, value);
  const base = {
    type,
    title: meta.title || key,
    group: meta.group || "旧保险箱",
    note: "从 cyrene-vault 迁移",
  };
  if (type === "api_key") {
    return { ...base, key: value, service: meta.service || "" };
  }
  return { ...base, username: "", password: value, url: "" };
}

function fromLegacyTotp(item) {
  return {
    type: "totp",
    title: item.issuer || item.account || "未命名 2FA",
    issuer: String(item.issuer || ""),
    account: String(item.account || ""),
    secret: String(item.secret || ""),
    digits: Number(item.digits) || 6,
    period: Number(item.period) || 30,
    algorithm: String(item.algorithm || "sha1").toLowerCase(),
    group: "2FA 验证码",
    note: "从 cyrene-totp 迁移",
  };
}

/* ------------------------------ 只读清单 ------------------------------ */

function scanLegacy() {
  const sources = [];
  const PLUGIN_DATA = pluginDataDir();
  const SETTINGS_FILE = settingsFile();

  const vault = readJson(path.join(PLUGIN_DATA, "cyrene-vault", "vault.json"));
  const vaultItems = vault
    ? Object.keys(vault).map((key) => ({
        label: (VAULT_META[key] && VAULT_META[key].title) || key,
        detail: vault[key] && vault[key].len ? vault[key].len + " 字符" : "长度未知",
      }))
    : [];
  sources.push({
    id: "cyrene-vault",
    label: "旧保险箱（cyrene-vault）",
    available: vaultItems.length > 0,
    count: vaultItems.length,
    items: vaultItems,
  });

  const gh = readJson(path.join(PLUGIN_DATA, "gh-vault", "githubToken.json"));
  sources.push({
    id: "gh-vault",
    label: "GitHub 令牌（gh-vault）",
    available: Boolean(gh && gh.data),
    count: gh && gh.data ? 1 : 0,
    items: gh && gh.data ? [{ label: "GitHub 令牌", detail: gh.label || "未填备注" }] : [],
  });

  const bdpan = readJson(path.join(PLUGIN_DATA, "bdpan-vault", "bdpanApiKey.json"));
  sources.push({
    id: "bdpan-vault",
    label: "百度网盘 API Key（bdpan-vault）",
    available: Boolean(bdpan && bdpan.data),
    count: bdpan && bdpan.data ? 1 : 0,
    items: bdpan && bdpan.data ? [{ label: "百度网盘 API Key", detail: bdpan.label || "未填备注" }] : [],
  });

  let totpCount = 0;
  let totpItems = [];
  const totpRecord = readJson(path.join(PLUGIN_DATA, "cyrene-totp", "totpEntries.json"));
  if (totpRecord) {
    try {
      const list = JSON.parse(decodeSafeRecord(totpRecord));
      if (Array.isArray(list)) {
        totpCount = list.length;
        totpItems = list.map((item) => ({
          label: (item.issuer || "未命名") + (item.account ? " / " + item.account : ""),
          detail: (item.digits || 6) + " 位 · " + (item.period || 30) + " 秒",
        }));
      }
    } catch (error) {
      totpItems = [{ label: "旧验证码库", detail: "打不开：" + messageOf(error) }];
    }
  }
  sources.push({
    id: "cyrene-totp",
    label: "旧 2FA 验证码（cyrene-totp）",
    available: totpCount > 0,
    count: totpCount,
    items: totpItems,
  });

  const settings = readJson(SETTINGS_FILE) || {};
  const mailReady = Boolean(settings.emailSmtpHost && settings.emailSmtpUser && settings.emailSmtpPass);
  sources.push({
    id: "mail-send",
    label: "邮箱 SMTP（app-settings.json）",
    available: mailReady,
    count: mailReady ? 1 : 0,
    items: mailReady
      ? [
          {
            label: settings.emailSmtpUser,
            detail: settings.emailSmtpHost + ":" + (settings.emailSmtpPort || "?"),
          },
        ]
      : [],
  });

  return { sources };
}

/* ------------------------------ 真正导入 ------------------------------ */

async function collectLegacy() {
  const entries = [];
  const report = [];
  const PLUGIN_DATA = pluginDataDir();
  const SETTINGS_FILE = settingsFile();

  // 1. 旧保险箱
  const vault = readJson(path.join(PLUGIN_DATA, "cyrene-vault", "vault.json")) || {};
  const vaultKeys = Object.keys(vault);
  let vaultDone = 0;
  const vaultErrors = [];
  for (const key of vaultKeys) {
    try {
      const value = await dpapiUnprotectHex(vault[key] && vault[key].v);
      if (!value) throw new Error("解出来是空的");
      entries.push(fromVaultKey(key, value));
      vaultDone += 1;
    } catch (error) {
      vaultErrors.push(key + "：" + messageOf(error));
    }
  }
  report.push({
    id: "cyrene-vault",
    label: "旧保险箱",
    found: vaultKeys.length,
    imported: vaultDone,
    failed: vaultKeys.length - vaultDone,
    errors: vaultErrors,
  });

  // 2. GitHub 令牌
  const gh = readJson(path.join(PLUGIN_DATA, "gh-vault", "githubToken.json"));
  if (gh && gh.data) {
    try {
      const token = decodeSafeRecord(gh);
      entries.push({
        type: "api_key",
        title: "GitHub 令牌",
        service: "github",
        key: token,
        group: "开发",
        note: "从 gh-vault 迁移" + (gh.label ? " · " + gh.label : ""),
      });
      report.push({ id: "gh-vault", label: "GitHub 令牌", found: 1, imported: 1, failed: 0 });
    } catch (error) {
      report.push({ id: "gh-vault", label: "GitHub 令牌", found: 1, imported: 0, failed: 1, errors: [messageOf(error)] });
    }
  }

  // 3. 百度网盘 Key
  const bdpan = readJson(path.join(PLUGIN_DATA, "bdpan-vault", "bdpanApiKey.json"));
  if (bdpan && bdpan.data) {
    try {
      const key = decodeSafeRecord(bdpan);
      entries.push({
        type: "api_key",
        title: "百度网盘 API Key",
        service: "baidu-netdisk",
        key,
        group: "云服务",
        note: "从 bdpan-vault 迁移" + (bdpan.label ? " · " + bdpan.label : ""),
      });
      report.push({ id: "bdpan-vault", label: "百度网盘 API Key", found: 1, imported: 1, failed: 0 });
    } catch (error) {
      report.push({ id: "bdpan-vault", label: "百度网盘 API Key", found: 1, imported: 0, failed: 1, errors: [messageOf(error)] });
    }
  }

  // 4. 旧 2FA 验证码
  const totpRecord = readJson(path.join(PLUGIN_DATA, "cyrene-totp", "totpEntries.json"));
  if (totpRecord) {
    try {
      const list = JSON.parse(decodeSafeRecord(totpRecord));
      const items = Array.isArray(list) ? list.filter((item) => item && item.secret) : [];
      let done = 0;
      const errors = [];
      for (const item of items) {
        try {
          entries.push(fromLegacyTotp(item));
          done += 1;
        } catch (error) {
          errors.push((item.issuer || item.account || "未命名") + "：" + messageOf(error));
        }
      }
      report.push({
        id: "cyrene-totp",
        label: "2FA 验证码",
        found: items.length,
        imported: done,
        failed: items.length - done,
        errors,
      });
    } catch (error) {
      report.push({ id: "cyrene-totp", label: "2FA 验证码", found: 0, imported: 0, failed: 0, errors: [messageOf(error)] });
    }
  }

  // 5. 邮箱 SMTP
  const settings = readJson(SETTINGS_FILE) || {};
  if (settings.emailSmtpHost && settings.emailSmtpUser && settings.emailSmtpPass) {
    entries.push({
      type: "password",
      title: "邮箱 SMTP · " + settings.emailSmtpHost,
      username: String(settings.emailSmtpUser),
      password: String(settings.emailSmtpPass),
      url: String(settings.emailSmtpHost),
      group: "邮箱",
      note:
        "SMTP " +
        settings.emailSmtpHost +
        ":" +
        (settings.emailSmtpPort || "?") +
        (settings.emailSmtpSecure ? " · SSL" : "") +
        " · 从 mail-send 迁移",
    });
    report.push({ id: "mail-send", label: "邮箱 SMTP", found: 1, imported: 1, failed: 0 });
  }

  return { entries, report };
}

module.exports = {
  scanLegacy,
  collectLegacy,
};
