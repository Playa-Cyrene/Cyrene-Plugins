"use strict";
const bridge = window.cyreneHud, byId = id => document.getElementById(id);
let materialSupported = false, glassStatus = "off", powerPaused = false, sessionMode = "", sessionRequest = 0, formEdited = false;
let metricOrder = [], selectedMetrics = new Set(), dragging = null;
const metricIds = ["memory", "cpu", "gpu", "network", "battery", "clock", "fan"];
byId("displayInfo").addEventListener("click", () => {
  const notes = byId("displayNotes"); notes.hidden = !notes.hidden;
  byId("displayInfo").setAttribute("aria-expanded", String(!notes.hidden));
});
function drawMetrics() {
  byId("metricList").replaceChildren();
  metricOrder.forEach((id, index) => {
    const row = document.createElement("div"); row.className = "metric-option"; row.draggable = true; row.dataset.metric = id;
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.checked = selectedMetrics.has(id); input.dataset.metric = id;
    input.addEventListener("input", () => {
      if (input.checked) selectedMetrics.add(id); else selectedMetrics.delete(id);
      formEdited = true;
      outputs();
    });
    label.append(input, document.createTextNode(HudMetrics.labels[id])); row.append(label);
    for (const [text, offset] of [["↑", -1], ["↓", 1]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "secondary"; button.textContent = text;
      button.setAttribute("aria-label", `${HudMetrics.labels[id]}${offset < 0 ? "上移" : "下移"}`);
      button.disabled = index + offset < 0 || index + offset >= metricOrder.length;
      button.addEventListener("click", () => { [metricOrder[index], metricOrder[index + offset]] = [metricOrder[index + offset], id]; formEdited = true; drawMetrics(); });
      row.append(button);
    }
    row.addEventListener("dragstart", event => { dragging = id; event.dataTransfer.setData("text/plain", id); });
    row.addEventListener("dragover", event => event.preventDefault());
    row.addEventListener("drop", event => {
      event.preventDefault(); if (!dragging || dragging === id) return;
      metricOrder.splice(metricOrder.indexOf(dragging), 1); metricOrder.splice(metricOrder.indexOf(id), 0, dragging);
      formEdited = true; dragging = null; drawMetrics();
    });
    row.addEventListener("dragend", () => { dragging = null; });
    byId("metricList").append(row);
  });
}
function outputs() {
  byId("fanReferences").hidden = !selectedMetrics.has("fan");
  for (const key of ["hoverDelay", "displayDuration"]) byId(key).disabled = byId("mode").value !== "hover";
  const sessionTarget = ["chat", "work", "code", "learn"].includes(byId("avatarTarget").value);
  byId("avatarSessionField").hidden = !sessionTarget;
  byId("avatarSessionIdField").hidden = !sessionTarget || byId("avatarSession").value !== "existing";
  byId("avatarSessionId").required = sessionTarget && byId("avatarSession").value === "existing";
  byId("scaleValue").textContent = `${Math.round(Number(byId("scale").value) * 100)}%`;
  byId("opacityValue").textContent = `${Math.round(Number(byId("opacity").value) * 100)}%`;
  const material = materialSupported && byId("background").value === "mica" && byId("mode").value !== "hover";
  byId("radius").disabled = material;
  byId("radiusValue").textContent = material ? "系统材质使用直角" : `${byId("radius").value} px`;
  byId("tintOpacityValue").textContent = `${Math.round(Number(byId("tintOpacity").value) * 100)}%`;
  byId("materialNote").textContent = glassStatus === "failed" ? "毛玻璃启动失败，已回退纯色。可切换为纯色并保存，再切回毛玻璃重试。" : !materialSupported ? "本机不支持原生材质（需 Windows 11 22H2+）。纯色和透明仍可用。" : powerPaused && byId("background").value === "acrylic" ? "Windows 节能模式已暂停模糊，当前使用通透背景。颜色和透明度仍可调，退出节能后自动恢复毛玻璃。" : material ? "云母取壁纸色调，使用直角；若需要圆角模糊，请选择毛玻璃。" : "毛玻璃支持自定义圆角；效果受 Windows 透明效果与节能设置影响。";
}
async function loadSessions(selected = byId("avatarSessionId").value) {
  const mode = byId("avatarTarget").value;
  if (!["chat", "work", "code", "learn"].includes(mode) || byId("avatarSession").value !== "existing") return;
  if (sessionMode === mode) { if (selected) byId("avatarSessionId").value = selected; return; }
  const request = ++sessionRequest;
  byId("avatarSessionId").replaceChildren(new Option("正在读取会话…", ""));
  try {
    const sessions = await bridge.listSessions(mode);
    if (request !== sessionRequest || byId("avatarTarget").value !== mode) return;
    sessionMode = mode;
    byId("avatarSessionId").replaceChildren(new Option(sessions.length ? "请选择会话" : "没有可选会话，请选择新建", ""), ...sessions.map(session => new Option(session.title, session.id)));
    if (selected && sessions.some(session => session.id === selected)) byId("avatarSessionId").value = selected;
    else if (selected) byId("feedback").textContent = "原指定会话已不可用，请重新选择。";
  } catch (error) {
    if (request !== sessionRequest) return;
    byId("avatarSessionId").replaceChildren(new Option("无法读取会话", ""));
    byId("feedback").textContent = error.message || "无法读取会话，请重新启用插件。";
  }
}
function fill(state) {
  materialSupported = state.materialSupported; glassStatus = state.glassStatus; powerPaused = state.powerPaused;
  byId("editionNote").textContent = state.edition === "upstream" ? "兼容版：按宿主规则打开所选模式的会话，无需新增主程序接口。" : "本地版：Chat 在聊天窗口打开，Work、Code、Learn 在工作窗口打开。";
  for (const option of byId("background").options) option.disabled = !materialSupported && ["acrylic", "mica"].includes(option.value);
  byId("displayId").replaceChildren(new Option("主显示器", ""), ...state.displays.map(display => new Option(display.label, String(display.id))));
  const metrics = state.config.metrics || [state.config.metric];
  selectedMetrics = new Set(metrics); metricOrder = [...metrics, ...metricIds.filter(id => !selectedMetrics.has(id))]; drawMetrics();
  for (const [key, value] of Object.entries(state.config)) { if (!byId(key)) continue; if (key === "clickThrough") byId(key).checked = value; else byId(key).value = value ?? ""; }
  outputs();
  void loadSessions(state.config.avatarSessionId);
}
function testState(state) {
  const region = byId("testRegion"), selected = region.value;
  region.replaceChildren(new Option("头像 · 状态与心情", "avatar"), ...state.config.metrics.map(id => new Option(HudMetrics.labels[id], id)));
  if (["avatar", ...state.config.metrics].includes(selected)) region.value = selected;
  byId("testFeedback").textContent = state.testing ? "测试中 · 使用模拟数据。通知展示 2 秒后缩回；悬停任一区域可查看角标。结束测试将恢复真实状态。" : "未在测试 · 使用已保存设置。关闭设置页或 60 秒无操作后自动结束测试。";
}
bridge.state().then(testState).catch(() => {});
bridge.onChange(testState);
for (const button of document.querySelectorAll("[data-test-action]")) button.addEventListener("click", async () => {
  try { testState(await bridge.testUi(button.dataset.testAction === "hover" ? byId("testRegion").value : button.dataset.testAction)); }
  catch (error) { byId("testFeedback").textContent = error.message || "无法启动 UI 测试。"; }
});
bridge.state().then(fill).catch(() => { byId("feedback").textContent = "无法读取设置，请重新启用 HUD 插件。"; });
bridge.onChange(state => { if (!formEdited) fill(state); });
byId("form").addEventListener("input", () => { formEdited = true; });
for (const key of ["scale", "opacity", "radius", "background", "tintOpacity", "mode"]) byId(key).addEventListener("input", outputs);
for (const key of ["avatarTarget", "avatarSession"]) byId(key).addEventListener("input", () => {
  sessionMode = ""; sessionRequest++;
  byId("avatarSessionId").replaceChildren(new Option("请选择会话", ""));
  outputs(); void loadSessions("");
});
byId("form").addEventListener("submit", async event => {
  event.preventDefault();
  const metrics = metricOrder.filter(id => selectedMetrics.has(id));
  if (!metrics.length) { byId("feedback").textContent = "请至少选择一个性能圆环。"; return; }
  const config = Object.fromEntries(["mode", "position", "background", "backgroundColor", "avatarTarget", "avatarSession", "avatarSessionId"].map(key => [key, byId(key).value]));
  Object.assign(config, { metrics, metric: metrics[0] });
  for (const key of ["height", "radius", "tintOpacity", "hoverDelay", "displayDuration", "cpuFanReferenceRpm", "gpuFanReferenceRpm", "midFanReferenceRpm"]) config[key] = Number(byId(key).value);
  Object.assign(config, { displayId: byId("displayId").value === "" ? null : Number(byId("displayId").value), scale: Number(byId("scale").value), opacity: Number(byId("opacity").value), clickThrough: byId("clickThrough").checked });
  try { const state = await bridge.save(config); formEdited = false; fill(state); byId("feedback").textContent = "已保存"; } catch { byId("feedback").textContent = "保存失败，请重试。"; }
});
byId("preview").addEventListener("click", () => { bridge.preview().catch(() => { byId("feedback").textContent = "无法显示预览。"; }); });

