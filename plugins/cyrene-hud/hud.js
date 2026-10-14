"use strict";
const bridge = window.cyreneHud, byId = id => document.getElementById(id);
let config = { metrics: [] }, snapshot = {}, runtime = {}, visible = false, failed = false, busy = false, nextSample = 0, navigationError = "", layout;
const nodes = new Map();
let lastWidths;
let notification = { count: 0, preview: "" }, openingNotification = false;
let testing = false, sampleGeneration = 0;
const testSnapshot = { cpuPercent: 38, cpuFrequencyGhz: 3.8, cpuTemperature: 62, memoryPercent: 65, memoryUsedGb: 20.8, memoryTotalGb: 32, gpuPercent: 54, gpuSource: "nvidia:0", gpuTemperature: 58, vramUsedGb: 4, vramTotalGb: 8, networkBytesPerSecond: 3145728, networkUploadBytesPerSecond: 524288, networkDownloadBytesPerSecond: 2621440, batteryPercent: 76, batteryLabel: "正在使用电池", fans: [{ id: "cpu", rpm: 3200 }, { id: "gpu", rpm: 3500 }] };
function buildMetrics() {
  if ([...nodes.keys()].join() === config.metrics.join()) return;
  nodes.clear(); byId("metrics").replaceChildren();
  for (const id of config.metrics) {
    const item = document.createElement("section"); item.className = "metric"; item.dataset.metric = id;
    item.innerHTML = '<div class="ring" aria-hidden="true"><svg viewBox="0 0 80 80"><circle class="track" cx="40" cy="40" r="32"/><circle class="progress" cx="40" cy="40" r="32"/></svg><span class="ring-label"></span><span class="ring-value"></span></div><div class="metric-detail"><small></small><strong></strong></div>';
    if (["gpu", "fan"].includes(id)) item.querySelector("svg").insertAdjacentHTML("beforeend", '<g class="inner-ring" hidden><circle class="track" cx="40" cy="40" r="24"/><circle class="progress" cx="40" cy="40" r="24"/></g>');
    if (id === "network") item.querySelector(".ring-label").innerHTML = '<span class="network-rate"><b>↑</b><span class="upload">—</span></span><span class="network-rate"><b>↓</b><span class="download">—</span></span>';
    byId("metrics").append(item); nodes.set(id, item);
  }
}
function render() {
  for (const [id, node] of nodes) {
    const info = HudMetrics.describe(id, snapshot, runtime, new Date(), failed, config);
    if (info.ringRates) {
      node.querySelector(".upload").textContent = info.ringRates[0];
      node.querySelector(".download").textContent = info.ringRates[1];
    } else node.querySelector(".ring-label").textContent = info.label;
    node.querySelector(".ring-value").textContent = info.ringValue;
    node.querySelector("strong").textContent = info.detailValue;
    node.querySelector("small").textContent = info.detailLabel;
    let description = `${info.label}：${info.value} · ${info.note}`;
    if (id === "network") description += ` · ${info.detailLabel} · ${info.detailValue}`;
    if (id === "cpu" && Number.isFinite(snapshot.cpuFrequencyGhz) && !failed) description += ` · 系统报告频率 ${info.detailValue}`;
    const vram = node.querySelector(".inner-ring");
    if (vram) {
      vram.toggleAttribute("hidden", info.innerProgress === null);
      vram.querySelector(".progress").setAttribute("stroke-dasharray", `${150.796 * (info.innerProgress || 0) / 100} 150.796`);
      if (id === "gpu" && info.innerProgress !== null) description += ` · 独立显存占用 ${Math.round(info.innerProgress)}%`;
    }
    node.setAttribute("aria-label", description);
    node.classList.toggle("unavailable", info.value === "—");
    node.querySelector(".progress").setAttribute("stroke-dasharray", `${201.062 * (info.progress || 0) / 100} 201.062`);
    node.querySelector(".track").classList.toggle("unmetered", info.progress === null && info.value !== "—");
  }
  byId("runtimeStatus").textContent = HudMetrics.describe("status", {}, runtime).value;
  byId("runtimeFeeling").textContent = HudMetrics.describe("feeling", {}, runtime).value;
  byId("runtimeNote").textContent = testing ? "UI 测试 · 模拟状态" : HudMetrics.describe("status", {}, runtime).note;
  byId("status").textContent = navigationError ? "无法打开" : "";
  byId("status").hidden = !navigationError;
  measureDetails();
}
function measureDetails() {
  function width(node) {
    const copy = node.cloneNode(true);
    copy.removeAttribute("id");
    copy.style.cssText = "position:fixed;top:-10000px;left:0;width:max-content;visibility:hidden;white-space:nowrap";
    node.parentElement.append(copy);
    const value = Math.ceil(copy.getBoundingClientRect().width) + 4;
    copy.remove();
    return value;
  }
  const widths = { metrics: Object.fromEntries([...nodes].map(([id, node]) => [id, width(node.querySelector(".metric-detail"))])), avatar: width(byId("avatarDetail")) + 4 };
  const serialized = JSON.stringify(widths);
  if (serialized !== lastWidths) { lastWidths = serialized; void bridge.detailWidths(widths).catch(() => {}); }
}
function revealDetail(node, width, amount) {
  const edge = Math.max(0, Math.min(width, amount));
  const fade = Math.min(16, edge, width - edge);
  node.style.width = `${width}px`;
  node.style.setProperty("--reveal-solid", `${edge - fade}px`);
  node.style.setProperty("--reveal-edge", `${edge}px`);
  node.setAttribute("aria-hidden", String(edge < 1));
}
function applyLayout(frame) {
  if (!frame) return;
  layout = frame;
  const root = document.documentElement;
  root.style.setProperty("--hud-width", `${frame.width}px`);
  root.style.setProperty("--hud-height", `${frame.height}px`);
  root.style.setProperty("--hud-left", `${frame.offsetX || 0}px`);
  root.style.setProperty("--hud-top", `${frame.offsetY || 0}px`);
  root.style.setProperty("--hud-radius", `${frame.radius ?? config.radius}px`);
  const reveal = frame.revealProgress ?? 1, content = byId("hudContent");
  content.style.width = `${frame.contentWidth ?? frame.width}px`;
  content.style.height = `${frame.contentHeight ?? frame.height}px`;
  content.style.opacity = Math.max(0, Math.min(1, (reveal - .45) / .55));
  content.style.filter = `blur(${(1 - reveal) * 6}px)`;
  content.inert = reveal < 1;
  content.setAttribute("aria-hidden", String(reveal < 1));
  const notice = frame.noticeProgress || 0, quiet = Math.max(0, 1 - Math.max(reveal, notice) * 3);
  byId("capsuleDots").style.opacity = quiet;
  const toast = byId("notificationToast"), badge = byId("unreadBadge");
  toast.style.opacity = Math.max(0, (notice - .35) / .65);
  toast.disabled = notice < .95 || !notification.count;
  toast.setAttribute("aria-hidden", String(notice < .95));
  byId("notificationPreview").textContent = notification.preview;
  badge.hidden = !notification.count;
  badge.style.left = `${frame.avatarX + 33}px`;
  badge.textContent = notification.count > 99 ? "99+" : String(notification.count);
  badge.setAttribute("aria-label", `${notification.count} 条未读主动消息，点击打开`);
  byId("avatarAction").style.left = `${frame.avatarX}px`;
  const avatarDetail = byId("avatarDetail"), progress = Math.min(1, frame.avatarProgress);
  avatarDetail.style.left = `${frame.avatarDetailX}px`;
  revealDetail(avatarDetail, frame.avatarDetailWidth, frame.avatarDetailWidth * progress);
  for (const item of frame.items) {
    const node = nodes.get(item.id); if (!node) continue;
    node.style.left = `${item.x}px`; node.style.width = `${frame.ring + item.amount}px`;
    node.style.height = `${frame.ring}px`;
    node.style.setProperty("--detail-progress", Math.min(1, item.amount / item.fullWidth));
    const ring = node.querySelector(".ring"); ring.style.left = `${item.ringX - item.x}px`;
    ring.style.width = ring.style.height = `${frame.ring}px`;
    const detail = node.querySelector(".metric-detail");
    detail.style.left = `${item.detailX - item.x}px`;
    revealDetail(detail, item.fullWidth, item.amount);
    const covered = progress > .01 && item.x < frame.avatarDetailX + frame.avatarDetailWidth * progress && item.x + frame.ring + item.amount > frame.avatarDetailX;
    node.style.opacity = covered ? 0 : 1; node.setAttribute("aria-hidden", String(covered));
  }
}
async function tick() {
  if (!visible) return;
  if (testing) { render(); return; }
  if (!busy && Date.now() >= nextSample) {
    busy = true;
    nextSample = Date.now() + 1000;
    const generation = sampleGeneration;
    const hardware = config.metrics.some(id => id !== "clock");
    await Promise.all([
      hardware ? bridge.snapshot().then(value => { if (generation === sampleGeneration) { snapshot = value; failed = false; } }, () => { if (generation === sampleGeneration) { snapshot = {}; failed = true; } }) : Promise.resolve(),
      bridge.status().then(value => { if (generation === sampleGeneration) runtime = value; }, () => { if (generation === sampleGeneration) runtime = {}; }),
    ]);
    busy = false;
  }
  render();
}
function ringPalette(luminance) {
  if (luminance < 140) return { track: "rgba(255, 192, 216, 0.22)", ring: "rgb(245, 211, 224)" };
  const amount = Math.max(0, Math.min(1, (luminance - 140) / 115));
  const gray = 198 + amount * 34.5;
  const rgb = values => `rgb(${values.map(value => Math.round(Math.max(0, Math.min(255, value)))).join(", ")})`;
  return { track: rgb([gray + 2, gray, gray + 1]), ring: rgb([241 + amount * 8, 143 + amount * 25, 173 + amount * 23]) };
}
function applyState(state) {
  if (testing !== !!state.testing) {
    testing = !!state.testing; sampleGeneration++; nextSample = 0; failed = false;
    snapshot = testing ? testSnapshot : {};
    runtime = testing ? { available: true, enabled: true, status: "陪伴中", feeling: "平静" } : {};
  }
  notification = state.notification || { count: 0, preview: "" };
  config = state.config; buildMetrics();
  byId("avatarAction").disabled = testing || config.avatarTarget === "none";
  byId("avatarAction").setAttribute("aria-label", navigationError || "头像快捷入口，悬停查看状态和心情");
  const root = document.documentElement;
  root.style.setProperty("--hud-radius", `${config.radius}px`);
  document.body.dataset.background = state.effectiveBackground;
  const rgb = config.backgroundColor.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16));
  const luminance = Math.max(0, Math.min(255, Number.isFinite(state.backdropLuminance) ? state.backdropLuminance : rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722));
  const dark = luminance < 140;
  document.body.classList.toggle("light-avatar", dark); document.body.classList.toggle("dark-tint", dark);
  const palette = ringPalette(luminance);
  document.body.style.setProperty("--hud-track", palette.track);
  document.body.style.setProperty("--hud-ring", palette.ring);
  root.style.setProperty("--hud-color", config.backgroundColor);
  root.style.setProperty("--hud-tint", `rgba(${rgb.join(",")},${config.tintOpacity})`);
  applyLayout(state.layout || layout); render();
}
bridge.onChange(applyState); bridge.onLayout(applyLayout);
bridge.onSnapshot(value => {
  if (testing) return;
  snapshot = value || {}; failed = !value;
  if (visible) render();
});
bridge.onVisibility(value => {
  visible = value; nextSample = 0;
  if (value) void tick();
});
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const updateMotion = () => { void bridge.reducedMotion(motion.matches).catch(() => {}); };
motion.addEventListener("change", updateMotion); updateMotion();
byId("avatarAction").addEventListener("mouseenter", () => { void bridge.avatarHover(true).catch(() => {}); });
byId("avatarAction").addEventListener("mouseleave", () => { void bridge.avatarHover(false).catch(() => {}); });
byId("avatarAction").addEventListener("click", async () => {
  try { await bridge.openTarget(); navigationError = ""; }
  catch (error) { navigationError = error.message || "无法打开窗口，请检查头像快捷入口设置"; }
  byId("avatarAction").setAttribute("aria-label", navigationError || "头像快捷入口，悬停查看状态和心情"); render();
});
for (const id of ["notificationToast", "unreadBadge"]) byId(id).addEventListener("click", async event => {
  event.stopPropagation();
  if (openingNotification) return;
  openingNotification = true;
  try { await bridge.openNotification(); navigationError = ""; }
  catch { navigationError = "无法打开主动消息，请稍后重试"; }
  finally { openingNotification = false; render(); }
});
bridge.state().then(applyState).catch(() => { failed = true; render(); });
document.fonts?.ready.then(measureDetails);
setInterval(() => { void tick(); }, 1000);

