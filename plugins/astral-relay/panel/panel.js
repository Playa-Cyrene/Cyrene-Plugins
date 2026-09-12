// 星驿 · 配置面板
// channel 与 src/ui/ipc.ts 对应：插件侧注册短名，框架命名空间化为
// plugin:astral-relay:<channel>，这里用完整名 invoke。
// 安全约定：面板绝不显示订阅 Key 本身，只显示「有没有配」。
const { ipcRenderer } = require("electron");

const GET_STATE = "plugin:astral-relay:get-state";
const SAVE_CONFIG = "plugin:astral-relay:save-config";
const SAVE_KEY = "plugin:astral-relay:save-key";
const CLEAR_KEY = "plugin:astral-relay:clear-key";

const $ = (id) => document.getElementById(id);

function badge(text, cls) {
  const span = document.createElement("span");
  span.className = "badge " + (cls || "");
  span.textContent = text;
  return span;
}

function renderGate(gate) {
  const node = $("gate-badge");
  node.textContent = gate && gate.open ? "活动中" : "空闲";
  node.className = "badge " + (gate && gate.open ? "on" : "off");
}

/** 生效中的 Code 轮次登记数。只有数量，面板拿不到也不需要用户输入本身。 */
function renderBinding(binding) {
  const node = $("binding-badge");
  const pending = binding && typeof binding.pending === "number" ? binding.pending : 0;
  node.textContent = "Code 轮次登记 " + pending;
  node.className = "badge " + (pending > 0 ? "on" : "off");
}

/** 一张厂商卡片。所有文本走 textContent —— 面板不拼 HTML。 */
function providerCard(p) {
  const card = document.createElement("section");
  card.className = "provider" + (p.available ? "" : " disabled");

  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("h2");
  title.textContent = p.label;
  head.appendChild(title);
  head.appendChild(
    p.kind === "coding-only"
      ? badge("仅 Code 模式", "warn")
      : p.kind === "general"
        ? badge("全模式", "on")
        : badge("未实现", ""),
  );
  if (p.available) {
    const connected = p.auth === "oauth" ? p.oauth.connected : p.keyConfigured;
    const statusBadge = badge(connected ? "已连接" : "未连接", connected ? "on" : "off");
    statusBadge.id = "auth-status-" + p.id;
    head.appendChild(statusBadge);
  }
  card.appendChild(head);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent = p.note;
  card.appendChild(note);

  const terms = document.createElement("p");
  terms.className = "note";
  const link = document.createElement("a");
  link.href = p.termsUrl;
  link.target = "_blank";
  link.textContent = p.termsUrl;
  terms.appendChild(document.createTextNode("条款："));
  terms.appendChild(link);
  card.appendChild(terms);

  if (!p.available) return card;

  if (p.regions.length > 1) {
    const label = document.createElement("label");
    label.textContent = "区域";
    const select = document.createElement("select");
    for (const region of p.regions) {
      const option = document.createElement("option");
      option.value = region.id;
      option.textContent = region.label + "（" + region.baseUrl + "）";
      if (region.id === p.regionId) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", async (event) => {
      await ipcRenderer.invoke(SAVE_CONFIG, { providerId: p.id, regionId: event.target.value });
      await refresh();
    });
    card.appendChild(label);
    card.appendChild(select);
  }

  if (p.experimental) {
    // 实验性：实现完整但没有端到端实测过，必须让用户看见
    const flag = document.createElement("p");
    flag.className = "note";
    flag.textContent = "实验性：该接入尚未经过端到端实测，失败请回退到按量付费档案。";
    card.appendChild(flag);
  }
  if (p.auth === "oauth") {
    const row = document.createElement("div");
    row.className = "row";
    const status = document.createElement("p");
    status.className = "note";
    const connect = document.createElement("button");
    connect.id = "oauth-connect-" + p.id;
    connect.disabled = p.oauth.connecting;
    connect.textContent = p.oauth.connected ? "重新连接" : "连接订阅";
    const cancel = document.createElement("button");
    cancel.textContent = "取消登录";
    cancel.className = "ghost";
    const disconnect = document.createElement("button");
    disconnect.textContent = "断开连接";
    disconnect.className = "ghost";
    const models = document.createElement("button");
    models.textContent = "读取模型";
    models.className = "ghost";
    const modelList = document.createElement("code");
    modelList.hidden = true;
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      status.textContent = "请在浏览器中完成授权（5 分钟内），完成后自动保存。";
      try {
        const result = await ipcRenderer.invoke("plugin:astral-relay:oauth-login", p.id);
        if (!result.ok) { status.textContent = result.error; return; }
        await refresh();
      } catch { status.textContent = "连接失败，请重试。"; }
      finally { connect.disabled = false; }
    });
    cancel.addEventListener("click", async () => {
      try { await ipcRenderer.invoke("plugin:astral-relay:oauth-cancel", p.id); status.textContent = "已取消登录。"; }
      catch { status.textContent = "取消失败，请重试。"; }
    });
    disconnect.addEventListener("click", async () => {
      try {
        const result = await ipcRenderer.invoke("plugin:astral-relay:oauth-logout", p.id);
        if (!result.ok) { status.textContent = result.error; return; }
        await refresh();
      } catch { status.textContent = "断开失败，请重试。"; }
    });
    models.addEventListener("click", async () => {
      models.disabled = true;
      status.textContent = "正在读取订阅可用模型…";
      try {
        const result = await ipcRenderer.invoke("plugin:astral-relay:oauth-models", p.id);
        if (!result.ok) { status.textContent = result.error; return; }
        modelList.hidden = false;
        modelList.textContent = result.result.map((model) => model.id).join("\n");
        status.textContent = "将模型 ID 填入 Cyrene 模型档案。";
      } catch { status.textContent = "读取模型失败，请重试。"; }
      finally { models.disabled = false; }
    });
    for (const button of [connect, cancel, disconnect, models]) row.appendChild(button);
    card.appendChild(row);
    card.appendChild(status);
    card.appendChild(modelList);
  } else {
  const keyLabel = document.createElement("label");
  keyLabel.textContent = "订阅 Key" + (p.keyPrefix ? "（应以 " + p.keyPrefix + " 开头）" : "");
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.placeholder = "留空则不修改已保存的 Key";
  keyInput.autocomplete = "off";
  card.appendChild(keyLabel);
  card.appendChild(keyInput);

  const row = document.createElement("div");
  row.className = "row";
  const save = document.createElement("button");
  save.textContent = "保存 Key";
  save.addEventListener("click", async () => {
    if (!keyInput.value) return;
    const result = await ipcRenderer.invoke(SAVE_KEY, { providerId: p.id, key: keyInput.value });
    keyInput.value = "";
    if (result && result.ok && result.prefixMismatch) {
      window.alert("已保存，但前缀不是 " + result.expectedPrefix + "，确认没贴成按量付费 Key。");
    } else if (result && !result.ok) {
      window.alert(result.error || "保存失败");
    }
    await refresh();
  });
  const clear = document.createElement("button");
  clear.className = "ghost";
  clear.textContent = "清除";
  clear.addEventListener("click", async () => {
    await ipcRenderer.invoke(CLEAR_KEY, p.id);
    await refresh();
  });
  row.appendChild(save);
  row.appendChild(clear);
  card.appendChild(row);
  }

  const urlLabel = document.createElement("label");
  urlLabel.textContent = "模型档案 Base URL（协议选 " + (p.protocol === "responses" ? "Responses" : "OpenAI 兼容") + "）";
  const url = document.createElement("code");
  url.textContent = p.baseUrl || "代理未运行";
  card.appendChild(urlLabel);
  card.appendChild(url);

  return card;
}

function render(state, statusOnly = false) {
  renderGate(state.gate);
  renderBinding(state.binding);
  for (const p of state.providers) {
    if (p.auth !== "oauth") continue;
    const node = document.getElementById("auth-status-" + p.id);
    if (node) {
      node.textContent = p.oauth.connecting ? "连接中…" : p.oauth.connected ? "已连接" : "未连接";
      node.className = "badge " + (p.oauth.connected ? "on" : "off");
    }
    const connect = document.getElementById("oauth-connect-" + p.id);
    if (connect) { connect.disabled = p.oauth.connecting; connect.textContent = p.oauth.connected ? "重新连接" : "连接订阅"; }
  }
  // Status polling must not replace password inputs or unsaved region/TTL edits.
  // Provider cards are rebuilt only after an explicit save/clear action.
  if (statusOnly) return;
  const list = $("providers");
  list.textContent = "";
  for (const p of state.providers) list.appendChild(providerCard(p));
  $("token").textContent = state.proxy ? state.proxy.token : "—";
  $("ttl").value = state.windowTtlMs;
}

async function refresh(statusOnly = false) {
  try {
    render(await ipcRenderer.invoke(GET_STATE), statusOnly);
  } catch (err) {
    $("gate-note").textContent = "读取状态失败：" + String(err);
  }
}

$("save-ttl").addEventListener("click", async () => {
  await ipcRenderer.invoke(SAVE_CONFIG, { windowTtlMs: Number($("ttl").value) });
  await refresh();
});

void refresh();
// 闸门状态随轮次变化，轮询刷新即可，不值得为它加一条推送通道。
setInterval(() => {
  void refresh(true);
}, 3000);
