"use strict";

/**
 * 订阅 OAuth 插件入口。
 *
 * 能力：
 *  - 三家订阅（ChatGPT / Claude / Grok）的 OAuth 登录（PKCE + 本地回调）
 *  - 本地代理：按 Responses / Messages / Chat Completions 三种原生协议直通，
 *    并为对应上游注入订阅 token
 *  - 模型目录 / 用量拉取，弹窗内展示
 *  - token 过期自动 refresh；secrets 加密存储（host 可用时）
 *
 * 使用：登录后从插件窗口把目录一键写入模型档案；插件会为三家分别选择
 * 正确的 transport 与本地代理端点。
 */
const path = require("node:path");

const { createProxy, DEFAULT_PORT } = require("./lib/proxy.cjs");
const oauth = require("./lib/oauth.cjs");
const { createTokenStore } = require("./lib/token-store.cjs");
const { fetchCatalog } = require("./lib/catalog.cjs");
const { fetchUsage } = require("./lib/usage.cjs");
const { syncProfilesIntoModelSettings, removeProfilesForProvider } = require("./lib/profiles.cjs");
const { PROVIDERS } = require("./lib/vendor-http.cjs");
const { sanitizeLogArg } = require("./lib/privacy.cjs");

const PLUGIN_ID = "subscription-oauth";

let pluginWin = null;
let proxyHandle = null;   // { server, port, start, stop }
let tokenStore = null;
let ctxRef = null;

function log(...args) {
  try {
    (ctxRef && ctxRef.log ? ctxRef.log : console.log)(...args.map(sanitizeLogArg));
  } catch {
    // 日志失败不影响插件
  }
}

/** token 是否有效：未过期，或距过期 > 60s 视为安全。 */
function tokenFresh(tokens) {
  if (!tokens || !tokens.accessToken) return false;
  if (!tokens.expiresAt) return true;
  return tokens.expiresAt - Date.now() > 60_000;
}

/**
 * 取得某 provider **当前激活账号**的有效 token；过期时用 refresh_token 换新并回写。
 *
 * 关键：刷新必须按 accountId 原地更新该账号（tokenStore.updateAccount），
 * 不能用 addAccount —— refresh 响应可能不含 accountId/邮箱，会被当成新账号
 * 追加并激活，导致后续请求切到"幽灵账号"、用量与对话落到错误账号。
 *
 * @returns {Promise<object | null>}
 */
async function resolveTokens(providerId) {
  if (!tokenStore) return null;
  const active = await tokenStore.getActive(providerId);
  if (!active) return null;
  const { accountId, tokens } = active;
  if (tokenFresh(tokens)) return tokens;
  try {
    const refreshed = await oauth.refresh(providerId, tokens.refreshToken, log);
    // refresh 响应常缺 id_token → accountId/label 可能为空，回填原账号的值
    const merged = {
      ...refreshed,
      accountId: refreshed.accountId || tokens.accountId,
      accountLabel: refreshed.accountLabel || tokens.accountLabel,
    };
    const updated = await tokenStore.updateAccount(providerId, accountId, merged);
    if (!updated) {
      log(`[oauth:${providerId}] token 刷新完成，但原账号记录不存在，跳过回写`);
    }
    log(`[oauth:${providerId}] token 已刷新并回写当前账号`);
    return merged;
  } catch (error) {
    log(`[oauth:${providerId}] refresh 失败，返回旧 token 兜底: ${error.message}`);
    return tokens;
  }
}

/** 代理服务器的 token 解析闭包。 */
function proxyGetTokens(providerId) {
  return resolveTokens(providerId).then((tokens) => (tokens ? { tokens } : null));
}

/** 弹窗内 IPC 的公共数据：登录状态、账号列表、代理地址。 */
async function statusPayload() {
  const providers = {};
  for (const id of Object.keys(PROVIDERS)) {
    const accountInfo = tokenStore ? await tokenStore.listAccounts(id) : { accounts: [] };
    const tokens = await resolveTokens(id);
    providers[id] = {
      connected: Boolean(tokens),
      accountLabel: tokens ? (tokens.accountLabel || undefined) : undefined,
      expiresAt: tokens ? tokens.expiresAt : undefined,
      defaultModel: PROVIDERS[id].defaultModel,
      activeAccountId: accountInfo.activeAccountId,
      accounts: accountInfo.accounts,
    };
  }
  return {
    providers,
    port: proxyHandle ? proxyHandle.port() : 0,
    encrypted: tokenStore ? tokenStore.encrypted : false,
  };
}

async function catalogPayload(providerId) {
  const tokens = await resolveTokens(providerId);
  if (!tokens) return { ok: false, models: [], hidden: [], error: "尚未登录该订阅" };
  return fetchCatalog(providerId, tokens);
}

async function usagePayload(providerId) {
  const tokens = await resolveTokens(providerId);
  if (!tokens) return { ok: false, error: "尚未登录该订阅" };
  const result = await fetchUsage(providerId, tokens);
  if (!result.ok) {
    log(`[usage] ${providerId} 查询失败: ${result.error}`);
  } else {
    const windowCount = result.usage && Array.isArray(result.usage.windows) ? result.usage.windows.length : 0;
    log(`[usage] ${providerId} 查询成功: 计划=${result.usage.plan || "?"} 窗口数=${windowCount}`);
  }
  return result;
}

/** 登录：调用 oauth.login 后作为新账号写入 store（同账号自动更新）。 */
async function login(providerId) {
  // electron 按需加载：入口在纯 Node 环境（SDK 冒烟测试）也能被 require
  const { shell } = require("electron");
  const tokens = await oauth.login(providerId, log, (url) => shell.openExternal(url));
  const added = await tokenStore.addAccount(providerId, tokens);
  return {
    ok: true,
    accountLabel: tokens.accountLabel || undefined,
    accountId: added.accountId,
    isNewAccount: added.added,
    providerId,
  };
}

/** 切换当前使用的账号。 */
async function switchAccount(providerId, accountId) {
  const ok = await tokenStore.switchAccount(providerId, accountId);
  return ok ? { ok: true } : { ok: false, error: "账号不存在" };
}

/** 删除指定账号（不影响其他账号）。 */
async function removeAccount(providerId, accountId) {
  const ok = await tokenStore.removeAccount(providerId, accountId);
  return ok ? { ok: true } : { ok: false, error: "账号不存在" };
}

/** 清空该订阅的全部账号。 */
async function logout(providerId) {
  await tokenStore.remove(providerId);
  return { ok: true };
}

/** 弹窗窗口：标准即用即关的 BrowserWindow。 */
async function openWindow() {
  if (pluginWin && !pluginWin.isDestroyed()) {
    pluginWin.focus();
    return;
  }
  const { BrowserWindow, ipcMain } = require("electron");
  const CH_MIN = "plugin:subscription-oauth:win-minimize";
  const CH_CLOSE = "plugin:subscription-oauth:win-close";
  pluginWin = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 480,
    minHeight: 480,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#fff9fc",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  const onMin = () => { if (pluginWin && !pluginWin.isDestroyed()) pluginWin.minimize(); };
  const onClose = () => { if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close(); };
  ipcMain.on(CH_MIN, onMin);
  ipcMain.on(CH_CLOSE, onClose);
  pluginWin.on("closed", () => {
    ipcMain.removeListener(CH_MIN, onMin);
    ipcMain.removeListener(CH_CLOSE, onClose);
    pluginWin = null;
  });
  await pluginWin.loadFile(path.join(__dirname, "ui.html"));
}

const plugin = {
  async register(ctx) {
    ctxRef = ctx;
    tokenStore = createTokenStore(ctx.deps.secrets, ctx.storage);

    // IPC：弹窗 UI 调用的数据通道
    ctx.registerIpc("status", () => statusPayload());
    ctx.registerIpc("login", async (providerId) => {
      try {
        return await login(providerId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ctx.registerIpc("logout", async (providerId) => {
      try {
        return await logout(providerId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ctx.registerIpc("switchAccount", async (providerId, accountId) => {
      try {
        return await switchAccount(providerId, accountId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ctx.registerIpc("removeAccount", async (providerId, accountId) => {
      try {
        return await removeAccount(providerId, accountId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ctx.registerIpc("catalog", (providerId) => catalogPayload(providerId));
    ctx.registerIpc("usage", (providerId) => usagePayload(providerId));

    // 把订阅模型目录同步成 Cyrene 模型档案（聊天窗口选择器直接可选）
    // options.includeHidden=true 时连带 visibility=hide/none 的模型一起写入；
    // options.models=[...] 时只写指定的模型（用于单独添加某个隐藏模型）。
    ctx.registerIpc("syncProfiles", async (providerId, options) => {
      try {
        const tokens = await resolveTokens(providerId);
        if (!tokens) return { ok: false, error: "尚未登录该订阅" };
        const catalogRes = await fetchCatalog(providerId, tokens);
        if (!catalogRes.ok) return { ok: false, error: catalogRes.error || "模型目录拉取失败" };
        const port = proxyHandle ? proxyHandle.port() : 0;
        if (!port) return { ok: false, error: "代理未启动" };

        let models = catalogRes.models;
        const opt = options && typeof options === "object" ? options : {};
        if (Array.isArray(opt.models) && opt.models.length > 0) {
          models = opt.models;
        } else if (opt.includeHidden === true) {
          models = [...catalogRes.models, ...(catalogRes.hidden || [])];
        }

        const result = await syncProfilesIntoModelSettings(providerId, models, { port });
        if (result.ok) {
          log(`[profiles] ${providerId} 同步完成：新增 ${result.added} 更新 ${result.updated}，共 ${result.profiles} 个档案`);
        }
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    // 退出登录时清除该订阅的档案
    ctx.registerIpc("removeProfiles", async (providerId) => {
      try {
        return await removeProfilesForProvider(providerId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // 手动添加单个模型（目录未列出时的兜底，如 gpt-6-astra）
    ctx.registerIpc("addModel", async (providerId, modelId, modelName) => {
      try {
        // 规范化：去空格 + 转小写（模型 ID 大小写敏感，用户输入常被首字母大写）
        const id = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
        if (!id) return { ok: false, error: "请填写模型 ID" };
        if (!/^(gpt-|o[1-9]|claude-|grok-)/i.test(id)) {
          return { ok: false, error: "模型 ID 需以 gpt- / o1-o9 / claude- / grok- 开头" };
        }
        const port = proxyHandle ? proxyHandle.port() : 0;
        if (!port) return { ok: false, error: "代理未启动" };
        const model = { id, name: typeof modelName === "string" && modelName.trim() ? modelName.trim() : id };
        const result = await syncProfilesIntoModelSettings(providerId, [model], { port });
        if (result.ok) {
          log(`[profiles] 手动添加模型 ${id} → 新增 ${result.added} 更新 ${result.updated}`);
        }
        return { ...result, modelId: id };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // 本地代理
    proxyHandle = createProxy({
      getTokens: proxyGetTokens,
      log,
      fetchCatalog,
      fetchUsage,
    });
    await proxyHandle.start(DEFAULT_PORT);

    // 注册 AI 工具：让昔涟能查订阅状态（可选增强）
    ctx.registerTool({
      id: "subscription-oauth_status",
      name: "订阅账号状态",
      description: "查询当前登录的订阅账号状态（ChatGPT / Claude / Grok）及本地代理地址。用户问订阅登录了吗、代理端口是多少时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const payload = await statusPayload();
        const lines = [];
        for (const [id, info] of Object.entries(payload.providers)) {
          const accountCount = Array.isArray(info.accounts) ? info.accounts.length : 0;
          const countLabel = info.connected && accountCount > 1 ? `（${accountCount} 个账号）` : "";
          lines.push(`${info.connected ? "已登录" : "未登录"} · ${PROVIDERS[id].displayName}${countLabel}`);
        }
        lines.push(`本地代理: http://127.0.0.1:${payload.port}/v1`);
        lines.push(`存储: ${payload.encrypted ? "加密（系统密钥）" : "宿主 secrets 不可用（不会写入新凭据）"}`);
        return lines.join("\n");
      },
    });

    log(`[subscription-oauth] 已启动，代理: http://127.0.0.1:${proxyHandle.port()}/v1`);
  },

  async open() {
    await openWindow();
  },

  async unregister() {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
    if (proxyHandle) {
      await proxyHandle.stop();
      proxyHandle = null;
    }
    tokenStore = null;
    ctxRef = null;
  },
};

module.exports = plugin;
module.exports.default = plugin;
