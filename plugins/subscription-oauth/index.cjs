"use strict";

/**
 * 订阅 OAuth 插件入口。
 *
 * 能力：
 *  - 三家订阅（ChatGPT / Claude / Grok）的 OAuth 登录（PKCE + 本地回调）
 *  - 本地代理：按 Responses / Messages / Chat Completions 三种原生协议直通，
 *    并为对应上游注入订阅 token
 *  - 模型目录 / 用量拉取，弹窗内展示
 *  - ChatGPT / Grok 订阅生图：原图写入插件私有目录，聊天内只返回轻量预览 URL
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
const {
  createImageMediaStore,
  generateImageViaChatGpt,
  generateImageViaGrok,
} = require("./lib/image-generation.cjs");
const {
  syncProfilesIntoModelSettings,
  removeProfilesForProvider,
  preferredProxyPortFromProfiles,
  rebindProfilesToProxyPort,
  refreshProfilesInHostCache,
} = require("./lib/profiles.cjs");
const { PROVIDERS } = require("./lib/vendor-http.cjs");
const { sanitizeLogArg } = require("./lib/privacy.cjs");

const PLUGIN_ID = "subscription-oauth";

let pluginWin = null;
let proxyHandle = null;   // { server, port, start, stop }
let imageMediaStore = null;
let tokenStore = null;
let ctxRef = null;
let profileCacheRefreshTimer = null;
let profileCacheRefreshGeneration = 0;

const PROFILE_CACHE_REFRESH_RETRY_MS = 500;
const PROFILE_CACHE_REFRESH_MAX_ATTEMPTS = 120;

function cancelProfileCacheRefresh() {
  profileCacheRefreshGeneration += 1;
  if (profileCacheRefreshTimer !== null) {
    clearTimeout(profileCacheRefreshTimer);
    profileCacheRefreshTimer = null;
  }
}

/**
 * 插件启动早于宿主窗口创建，但晚于模型设置首次缓存。
 * 等任一宿主窗口的公开 settings API 可用后重放档案，刷新当前进程缓存。
 */
function scheduleProfileCacheRefresh(port) {
  cancelProfileCacheRefresh();
  const generation = profileCacheRefreshGeneration;
  let attempts = 0;

  const schedule = () => {
    profileCacheRefreshTimer = setTimeout(run, PROFILE_CACHE_REFRESH_RETRY_MS);
    profileCacheRefreshTimer.unref?.();
  };
  const run = async () => {
    profileCacheRefreshTimer = null;
    if (generation !== profileCacheRefreshGeneration || !ctxRef) return;
    attempts += 1;
    let result;
    try {
      result = await refreshProfilesInHostCache(port);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (generation !== profileCacheRefreshGeneration || !ctxRef) return;
    if (result.ok) {
      if (result.synced > 0) {
        log(`[profiles] 已通过宿主 API 刷新 ${result.synced} 个订阅模型档案的运行时缓存`);
      }
      return;
    }
    if (attempts >= PROFILE_CACHE_REFRESH_MAX_ATTEMPTS) {
      log(`[profiles] 等待宿主窗口刷新模型缓存超时：${result.error || "未知错误"}`);
      return;
    }
    schedule();
  };

  schedule();
}

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

function imageProviderFromMetadata(toolContext) {
  const metadata = toolContext && typeof toolContext.metadata === "object"
    ? toolContext.metadata
    : null;
  if (!metadata) return null;
  const hint = [metadata.provider, metadata.model, metadata.modelId, metadata.modelKey]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/\bgrok(?:-|\b)|\bxai\b|\bx\.ai\b/.test(hint)) return "grok";
  if (/\bchatgpt\b|\bopenai\b|\bcodex\b|\bgpt-|\bo[1-9](?:\b|-)/.test(hint)) return "chatgpt";
  return null;
}

async function resolveImageProvider(requestedProvider, toolContext) {
  const requested = ["chatgpt", "grok"].includes(requestedProvider) ? requestedProvider : "auto";
  const inferred = requested === "auto" ? imageProviderFromMetadata(toolContext) : null;
  const target = requested === "auto" ? inferred : requested;
  if (target) {
    const tokens = await resolveTokens(target);
    if (!tokens) {
      throw new Error(`${PROVIDERS[target].displayName} 订阅未登录，请先打开订阅 OAuth 插件完成登录`);
    }
    return { providerId: target, tokens };
  }

  // 旧版宿主暂不传当前模型元数据：auto 在仅登录一家时自然选中；
  // 同时登录两家时保持 ChatGPT 优先，模型提示词会要求 Grok 会话显式传 grok。
  const chatGptTokens = await resolveTokens("chatgpt");
  if (chatGptTokens) return { providerId: "chatgpt", tokens: chatGptTokens };
  const grokTokens = await resolveTokens("grok");
  if (grokTokens) return { providerId: "grok", tokens: grokTokens };
  throw new Error("ChatGPT 与 Grok 订阅均未登录，请先打开订阅 OAuth 插件完成登录");
}

function chatGptSizeFromArgs(args) {
  if (["1024x1024", "1024x1536", "1536x1024"].includes(args.size)) return args.size;
  if (["9:16", "2:3"].includes(args.aspect_ratio)) return "1024x1536";
  if (["16:9", "3:2"].includes(args.aspect_ratio)) return "1536x1024";
  return "1024x1024";
}

function grokAspectRatioFromArgs(args) {
  if (["auto", "1:1", "16:9", "9:16", "3:2", "2:3"].includes(args.aspect_ratio)) {
    return args.aspect_ratio;
  }
  if (args.size === "1024x1536") return "2:3";
  if (args.size === "1536x1024") return "3:2";
  if (args.size === "1024x1024") return "1:1";
  return "auto";
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

    // 图片仅保存在插件私有目录；聊天消息里只出现随机 URL，不出现 Base64/磁盘路径。
    imageMediaStore = createImageMediaStore({
      rootDir: ctx.storage.rootDir(),
      getPort: () => (proxyHandle ? proxyHandle.port() : 0),
    });

    // 本地代理（同时只读提供生成图片的 localhost 预览/原图）
    proxyHandle = createProxy({
      getTokens: proxyGetTokens,
      log,
      fetchCatalog,
      fetchUsage,
      mediaStore: imageMediaStore,
    });
    const preferredProxyPort = preferredProxyPortFromProfiles(DEFAULT_PORT);
    const activeProxyPort = await proxyHandle.start(preferredProxyPort);
    const rebound = rebindProfilesToProxyPort(activeProxyPort);
    if (!rebound.ok) {
      log(`[profiles] 自动迁移代理端口失败：${rebound.error}`);
    } else if (rebound.updated > 0) {
      log(`[profiles] 本地代理端口已变化，自动迁移 ${rebound.updated} 个订阅模型档案到 ${activeProxyPort}`);
    }
    // 无论磁盘是否刚发生迁移都重放一次：可修复旧版已留下的“磁盘正确、内存仍旧”状态。
    scheduleProfileCacheRefresh(activeProxyPort);

    // 工具 schema 只有在对应会话模式中启用时才会进入模型请求；额外提供一段
    // 很短的能力说明，避免模型沿用“我不能生图”的先验，并约束订阅商选择与回显。
    ctx.registerPromptProvider({
      id: "image-generation-capability",
      sources: ["conversation"],
      provide() {
        return [
          "[订阅 OAuth 生图能力]",
          "本插件提供 `subscription-oauth_generate_image` 工具，可使用已登录的 ChatGPT Plus / Pro 或具备 Imagine 权限的 Grok Build 订阅生成新图片。",
          "若本轮可用工具中包含该工具：用户要求画图、生成图片、海报、插画或视觉素材时应直接调用，不要声称自己没有生图能力；用户只询问是否支持生图时，应明确说明可以使用此工具。",
          "调用时必须传 `provider`：当前选用 Grok 订阅模型或用户点名 Grok / Grok Build 时传 `grok`；当前选用 ChatGPT 订阅模型或用户点名 ChatGPT 时传 `chatgpt`；无法判断且用户未指定时传 `auto`。Grok 的画幅使用 `aspect_ratio`。",
          "工具成功后会返回预览图与原图链接的 Markdown，最终回复必须原样保留这两行，确保图片直接显示在聊天窗口。",
          "若本轮没有该工具，则提示用户在“工具”页开启“Chat 模式工具增强”，并在 Chat 页签勾选“订阅生图（ChatGPT / Grok）”。",
        ].join("\n");
      },
    });

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

    // 普通 function tool 内部调用 ChatGPT Responses image_generation 或 Grok Build
    // Imagine；宿主无需理解原生工具事件，也不会把上游 Base64 写进对话历史。
    ctx.registerTool({
      id: "subscription-oauth_generate_image",
      name: "订阅生图（ChatGPT / Grok）",
      description: "使用已登录的 ChatGPT Plus / Pro 或 Grok Build 订阅生成一张新图片。Grok 会话应把 provider 设为 grok，ChatGPT 会话设为 chatgpt；无法判断时使用 auto。用户要求画图、生成图片、海报、插画或视觉素材时使用。工具结果会给出 Markdown 预览和原图链接；最终回复必须原样保留这两行 Markdown，不能改写成磁盘路径或 Base64。",
      catalogHint: "通过 ChatGPT 或 Grok 订阅生成图片，并直接在聊天中显示轻量预览。",
      category: "media",
      capability: "subscription-oauth.image-generation",
      enabled: true,
      risk: "network",
      effectKind: "external_side_effect",
      verificationPolicy: "none",
      ledgerPolicy: "bypass",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "完整、具体的生图提示词，应包含主体、构图、风格、光线、色彩和需要出现的文字。",
          },
          provider: {
            type: "string",
            enum: ["auto", "chatgpt", "grok"],
            description: "生图订阅商。当前是 Grok 订阅模型或用户点名 Grok 时必须选 grok；ChatGPT 同理；无法判断时选 auto。",
          },
          size: {
            type: "string",
            enum: ["1024x1024", "1024x1536", "1536x1024"],
            default: "1024x1024",
            description: "ChatGPT 图片尺寸：方图、竖图或横图；Grok 会自动换算，但优先传 aspect_ratio。",
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high"],
            default: "medium",
            description: "生成质量；越高通常等待越久。",
          },
          background: {
            type: "string",
            enum: ["opaque", "transparent"],
            default: "opaque",
            description: "ChatGPT 的不透明或透明背景；Grok 当前忽略此项。",
          },
          aspect_ratio: {
            type: "string",
            enum: ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"],
            default: "auto",
            description: "Grok Imagine 画幅：auto、方图、宽屏、竖屏、横向照片或纵向海报；ChatGPT 会自动换算成最接近的尺寸。",
          },
        },
        required: ["prompt", "provider"],
      },
      async execute(args, toolContext) {
        const prompt = typeof args.prompt === "string" && args.prompt.trim()
          ? args.prompt.trim()
          : (typeof toolContext?.userQuery === "string" ? toolContext.userQuery.trim() : "");
        if (!prompt) throw new Error("请提供生图提示词");
        const requestedProvider = ["auto", "chatgpt", "grok"].includes(args.provider)
          ? args.provider
          : "auto";
        const { providerId, tokens } = await resolveImageProvider(requestedProvider, toolContext);
        if (!imageMediaStore) throw new Error("本地图片服务未启动，请刷新插件后重试");

        const generated = providerId === "grok"
          ? await generateImageViaGrok({
              tokens,
              prompt,
              aspectRatio: grokAspectRatioFromArgs(args),
              signal: toolContext?.signal,
            })
          : await generateImageViaChatGpt({
              tokens,
              prompt,
              size: chatGptSizeFromArgs(args),
              quality: args.quality,
              background: args.background,
              signal: toolContext?.signal,
            });
        const media = await imageMediaStore.save(generated.buffer, {
          background: generated.background || "opaque",
        });
        const providerName = PROVIDERS[providerId].displayName;
        log(`[image:${providerId}] 生成完成：原图 ${media.originalBytes} B，聊天预览 ${media.previewBytes} B`);
        return [
          `图片已通过 ${providerName} 订阅生成。请在最终回复中原样输出下面两行 Markdown，让用户直接看到图片；不要输出 Base64 或磁盘路径：`,
          `![生成图片](${media.previewUrl})`,
          `[查看或下载原图](${media.originalUrl})`,
        ].join("\n");
      },
    });

    log(`[subscription-oauth] 已启动，代理: http://127.0.0.1:${proxyHandle.port()}/v1`);
  },

  async open() {
    await openWindow();
  },

  async unregister() {
    cancelProfileCacheRefresh();
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
    if (proxyHandle) {
      await proxyHandle.stop();
      proxyHandle = null;
    }
    imageMediaStore = null;
    tokenStore = null;
    ctxRef = null;
  },
};

module.exports = plugin;
module.exports.default = plugin;
