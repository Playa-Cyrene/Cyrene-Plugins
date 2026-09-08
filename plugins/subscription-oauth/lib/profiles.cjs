"use strict";

/**
 * 把订阅模型目录同步成 Cyrene 的模型档案（modelProfiles）。
 *
 * 每个订阅模型生成一个档案：
 *   baseUrl     → 插件代理地址 http://127.0.0.1:<port>/v1
 *   transport   → 按订阅原生协议（chatgpt=responses / claude=anthropic / grok=openai）
 *   apiKey      → 占位（代理不校验）
 *   reasoning   → 从目录 efforts 推断
 *   contextWindowTokens → 目录真实值优先，缺失时按模型族兜底
 *
 * 写入路径（不 require 宿主内部模块，符合插件仓库审核要求）：
 *   1) 优先经渲染进程公开 API `window.settings.saveModelProfile()` 写入
 *      —— 宿主会同步更新内存缓存，聊天窗口选择器立即生效；
 *   2) 没有可用宿主窗口时回退为直接写 model-settings.json（需重启 Cyrene 生效）。
 *
 * 与主仓库 src/main/settings/model-catalog.ts 的 SavedModelProfile 结构对齐。
 */

const { resolveContextWindow } = require("./model-context.cjs");

/** 每订阅的档案前缀，便于识别与清理。 */
const PROFILE_PREFIX = "oauth-sub-";

/** provider 显示名（设置页档案列表展示用）。 */
const PROVIDER_LABELS = {
  chatgpt: "ChatGPT（OpenAI）订阅",
  claude: "Claude（Anthropic）订阅",
  grok: "Grok（xAI）订阅",
};

/**
 * 各订阅的原生协议 —— 代理按原生协议直通，不做格式转换：
 *  - chatgpt → responses（Codex 端点，Cyrene 的 Responses transport 会发 store:false + instructions）
 *  - claude  → anthropic（Messages API）
 *  - grok    → openai（原生 OpenAI 兼容）
 */
const PROVIDER_TRANSPORT = {
  chatgpt: "responses",
  claude: "anthropic",
  grok: "openai",
};

/** 模型名 → 是否默认多模态（代理透传，能力最终由服务端裁定）。 */
function modelSupportsVision() {
  return true;
}

/**
 * 从目录条目推断 reasoning preference。
 * 目录无 effort 信息时返回 undefined（走模型名规则表兜底）。
 * @param {{efforts?: string[]}} model
 */
function reasoningFromModel(model) {
  if (!model.efforts || model.efforts.length === 0) return undefined;
  // 目录顺序即官方降序（xhigh 在前）；默认取中间档，避免最重档拖慢日常使用
  const order = ["xhigh", "high", "medium", "low", "minimal", "max"];
  const sorted = [...model.efforts].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const defaultEffort = sorted.length > 2 ? sorted[Math.floor(sorted.length / 2)] : sorted[sorted.length - 1];
  return { mode: "on", effort: defaultEffort };
}

/**
 * 生成档案数组（不写盘）。
 * @param {string} providerId
 * @param {Array<{id: string, name?: string, efforts?: string[], contextWindow?: number}>} models
 * @param {{port: number}} proxyInfo
 */
function buildProfiles(providerId, models, proxyInfo) {
  const baseUrl = `http://127.0.0.1:${proxyInfo.port}/v1`;
  const transport = PROVIDER_TRANSPORT[providerId] ?? "openai";
  return models.map((model) => ({
    id: `${PROFILE_PREFIX}${providerId}-${model.id}`,
    provider: PROVIDER_LABELS[providerId] ?? `${providerId} 订阅`,
    displayName: `${PROVIDER_LABELS[providerId] ?? providerId} · ${model.name === model.id ? model.id : model.name}`,
    baseUrl,
    model: model.id,
    apiKey: "oauth-subscription",
    explicitTransport: transport,
    reasoning: reasoningFromModel(model),
    // 上下文长度：目录真实值优先，缺失时按模型族兜底（不再统一写死 256k）
    contextWindowTokens: resolveContextWindow(model.id, model.contextWindow, model),
    multimodal: modelSupportsVision(providerId),
  }));
}

/** 配置文件路径（Cyrene 数据目录；用户点击"写入档案"即视为授权写入）。 */
function modelSettingsPath() {
  const path = require("node:path");
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "model-settings.json");
}

/** 读取现有档案列表（纯文件读，不依赖宿主内部模块）。 */
function readExistingProfiles() {
  const fs = require("node:fs");
  try {
    const settings = JSON.parse(fs.readFileSync(modelSettingsPath(), "utf8"));
    return { ok: true, settings, profiles: Array.isArray(settings.modelProfiles) ? settings.modelProfiles : [] };
  } catch (error) {
    return { ok: false, error: `无法读取模型配置：${error.message}` };
  }
}

/** 统计新增/更新数量（按 model + baseUrl 匹配）。 */
function diffProfiles(existing, desired) {
  let added = 0;
  let updated = 0;
  for (const profile of desired) {
    if (existing.some((p) => p.model === profile.model && p.baseUrl === profile.baseUrl)) updated += 1;
    else added += 1;
  }
  return { added, updated };
}

/**
 * 经渲染进程公开 API 写入档案（宿主同步更新缓存，立即生效）。
 * 使用 preload 暴露的 window.settings.saveModelProfile —— 不 require 宿主内部模块。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function saveProfilesViaRenderer(profiles) {
  const { BrowserWindow } = require("electron");
  // 序列化为 JSON 数据字面量插入脚本（不是代码拼接）
  const payload = JSON.stringify(profiles);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      const result = await win.webContents.executeJavaScript(
        "(async () => {\n"
        + "  const api = window.settings;\n"
        + "  if (!api || typeof api.saveModelProfile !== 'function') return { ok: false };\n"
        + `  const list = ${payload};\n`
        + "  for (const profile of list) { await api.saveModelProfile(profile); }\n"
        + "  return { ok: true };\n"
        + "})()",
        true,
      );
      if (result && result.ok) return { ok: true };
    } catch {
      // 该窗口没有 settings API（例如插件自己的窗口）或执行失败 → 尝试下一个窗口
    }
  }
  return { ok: false, error: "没有可用的宿主窗口（请先打开聊天或设置窗口后重试）" };
}

/** 删除某订阅档案（同样优先经渲染进程 API）。 */
async function deleteProfilesViaRenderer(ids) {
  const { BrowserWindow } = require("electron");
  const payload = JSON.stringify(ids);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      const result = await win.webContents.executeJavaScript(
        "(async () => {\n"
        + "  const api = window.settings;\n"
        + "  if (!api || typeof api.deleteModelProfile !== 'function') return { ok: false };\n"
        + `  const ids = ${payload};\n`
        + "  for (const id of ids) { await api.deleteModelProfile(id); }\n"
        + "  return { ok: true };\n"
        + "})()",
        true,
      );
      if (result && result.ok) return { ok: true };
    } catch {
      // 尝试下一个窗口
    }
  }
  return { ok: false, error: "没有可用的宿主窗口" };
}

/** 回退路径：直接写 model-settings.json（宿主缓存未更新，需重启生效）。 */
function writeProfilesToDisk(existingProfiles, desired) {
  const fs = require("node:fs");
  const read = readExistingProfiles();
  if (!read.ok) return read;
  const settings = read.settings;

  const result = [];
  for (const saved of existingProfiles) {
    const matched = desired.find((p) => p.model === saved.model && p.baseUrl === saved.baseUrl);
    result.push(matched ? { ...saved, ...matched } : saved);
  }
  for (const profile of desired) {
    if (!result.some((p) => p.model === profile.model && p.baseUrl === profile.baseUrl)) result.push(profile);
  }
  settings.modelProfiles = result;
  try {
    fs.writeFileSync(modelSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    return { ok: false, error: `写入模型配置失败：${error.message}` };
  }
  return { ok: true, profiles: result.length };
}

/**
 * 把订阅模型目录同步成宿主模型档案。
 * @returns {Promise<{ok: boolean, added?: number, updated?: number, profiles?: number, error?: string, degraded?: boolean}>}
 */
async function syncProfilesIntoModelSettings(providerId, models, proxyInfo) {
  const desired = buildProfiles(providerId, models, proxyInfo);

  const read = readExistingProfiles();
  if (!read.ok) return { ok: false, error: read.error };
  const { added, updated } = diffProfiles(read.profiles, desired);

  // 1) 优先走渲染进程宿主 API（写盘 + 更新内存缓存，立即生效）
  const viaRenderer = await saveProfilesViaRenderer(desired);
  if (viaRenderer.ok) {
    return { ok: true, added, updated, profiles: read.profiles.length + added };
  }

  // 2) 回退：直接写文件（需重启 Cyrene 生效）
  const fallback = writeProfilesToDisk(read.profiles, desired);
  if (!fallback.ok) return { ok: false, error: `${viaRenderer.error}；${fallback.error}` };
  return {
    ok: true,
    added,
    updated,
    profiles: fallback.profiles,
    degraded: true,
    warning: `${viaRenderer.error}，已直接写入配置文件，重启 Cyrene 后生效`,
  };
}

/** 删除某订阅的全部 oauth 档案。 */
async function removeProfilesForProvider(providerId) {
  const prefix = `${PROFILE_PREFIX}${providerId}-`;
  const read = readExistingProfiles();
  if (!read.ok) return { ok: false, error: read.error };
  const ids = read.profiles.filter((p) => String(p.id || "").startsWith(prefix)).map((p) => p.id);
  if (ids.length === 0) return { ok: true, removed: 0 };

  const viaRenderer = await deleteProfilesViaRenderer(ids);
  if (viaRenderer.ok) return { ok: true, removed: ids.length };

  // 回退：直接改文件
  const fs = require("node:fs");
  const settings = read.settings;
  settings.modelProfiles = read.profiles.filter((p) => !String(p.id || "").startsWith(prefix));
  if (settings.modelProfiles.some((p) => p.id === settings.defaultModelProfileId)) {
    settings.defaultModelProfileId = settings.modelProfiles[0] && settings.modelProfiles[0].id;
  }
  try {
    fs.writeFileSync(modelSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    return { ok: false, error: `${viaRenderer.error}；${error.message}` };
  }
  return { ok: true, removed: ids.length, degraded: true, warning: `${viaRenderer.error}，已直接修改配置文件，重启 Cyrene 后生效` };
}

module.exports = {
  PROFILE_PREFIX,
  PROVIDER_LABELS,
  PROVIDER_TRANSPORT,
  buildProfiles,
  reasoningFromModel,
  syncProfilesIntoModelSettings,
  removeProfilesForProvider,
};
