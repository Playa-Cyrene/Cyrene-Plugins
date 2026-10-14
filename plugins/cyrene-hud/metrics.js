"use strict";
(function(root) {
  const labels = { cpu: "CPU", memory: "内存", gpu: "GPU", network: "网速", battery: "电池", clock: "时间", fan: "风扇", status: "状态", feeling: "心情" };
  const percent = value => Number.isFinite(value) ? `${Math.round(value)}%` : "—";
  const rate = value => Number.isFinite(value) && value >= 0 ? `${(value / 1024 ** 2).toFixed(2)} MB/s` : "—";
  function describe(id, data = {}, runtime = {}, date = new Date(), failed = false, settings = {}) {
    let value = "—", note = "等待采样", progress = null, vramProgress = null;
    if (id === "cpu") { value = percent(data.cpuPercent); progress = data.cpuPercent; note = data.cpuModel || "处理器使用率"; }
    if (id === "memory") { value = Number.isFinite(data.memoryUsedGb) && Number.isFinite(data.memoryTotalGb) ? `${data.memoryUsedGb} / ${data.memoryTotalGb} GB` : "—"; progress = data.memoryPercent; note = `${percent(progress)} · 已用 / 总容量`; }
    if (id === "gpu") { value = percent(data.gpuPercent); progress = data.gpuPercent; note = data.gpuSource === "nvidia:0" ? `${data.gpuTemperature ?? "—"} °C · 显存 ${data.vramUsedGb ?? "—"}/${data.vramTotalGb ?? "—"} GB` : data.gpuSource ? "WMI 汇总 · 估算值" : "未读取到显卡数据"; }
    if (id === "network") { value = rate(data.networkBytesPerSecond); note = "全部网卡 · 收发合计"; }
    if (id === "battery") { value = percent(data.batteryPercent); progress = data.batteryPercent; note = data.batteryLabel || "未检测到电池"; }
    if (id === "clock") { value = date.toLocaleTimeString("zh-CN", { hour12: false }); note = date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }); progress = date.getSeconds() / 60 * 100; }
    if (id === "status" || id === "feeling") {
      value = runtime.available && runtime.enabled ? runtime[id === "status" ? "status" : "feeling"] || "—" : "—";
      note = !runtime.available ? "状态暂不可用" : !runtime.enabled ? "状态同步未开启" : id === "status" ? "主程序当前状态" : "主程序当前心情";
    }
    if (failed && ["cpu", "memory", "gpu", "network", "battery"].includes(id)) { value = "—"; progress = null; note = "采集暂不可用，正在重试"; }
    let ringValue = percent(progress), detailLabel = labels[id], detailValue = value;
    if (id === "cpu") detailValue = Number.isFinite(data.cpuFrequencyGhz) && data.cpuFrequencyGhz > 0 ? `${data.cpuFrequencyGhz.toFixed(2)} GHz` : data.cpuModel || "处理器使用率";
    if (id === "cpu" && Number.isFinite(data.cpuTemperature) && data.cpuTemperature > 0 && data.cpuTemperature <= 125) { detailLabel = `CPU · ${data.cpuTemperature} °C`; note += ` · CPU 温度 ${data.cpuTemperature} °C`; }
    if (id === "gpu") {
      detailLabel = Number.isFinite(data.gpuTemperature) ? `GPU · ${data.gpuTemperature} °C` : "GPU";
      detailValue = Number.isFinite(data.vramUsedGb) && Number.isFinite(data.vramTotalGb) ? `显存 ${data.vramUsedGb} / ${data.vramTotalGb} GB` : data.gpuSource ? "WMI 汇总 · 估算值" : "未读取到显卡数据";
      if (!failed && data.gpuSource === "nvidia:0" && Number.isFinite(data.vramUsedGb) && Number.isFinite(data.vramTotalGb) && data.vramTotalGb > 0 && data.vramUsedGb >= 0 && data.vramUsedGb <= data.vramTotalGb) vramProgress = Number.isFinite(data.vramPercent) && data.vramPercent >= 0 && data.vramPercent <= 100 ? data.vramPercent : data.vramUsedGb / data.vramTotalGb * 100;
    }
    if (id === "network") { ringValue = "↑↓"; detailLabel = `↑ ${rate(data.networkUploadBytesPerSecond)}`; detailValue = `↓ ${rate(data.networkDownloadBytesPerSecond)}`; }
    if (id === "fan") {
      const fans = !failed && Array.isArray(data.fans) ? data.fans.filter(fan => ["cpu", "gpu", "mid"].includes(fan.id) && Number.isFinite(fan.rpm) && fan.rpm >= 0 && fan.rpm <= 12000).slice(0, 2) : [];
      const line = fan => `${fan.id === "cpu" ? "CPU" : fan.id === "gpu" ? "GPU" : "辅助"} ${fan.rpm} RPM`;
      const reference = fan => settings[`${fan.id}FanReferenceRpm`] || 6300;
      const usage = fan => Math.min(100, fan.rpm / reference(fan) * 100);
      value = fans.length ? fans.map(line).join(" · ") : "—";
      progress = fans.length ? usage(fans[0]) : null;
      vramProgress = fans.length > 1 ? usage(fans[1]) : null;
      ringValue = percent(progress);
      detailLabel = fans.length ? line(fans[0]) : "风扇";
      detailValue = fans.length > 1 ? line(fans[1]) : fans.length ? "转速 · RPM" : "未读取到风扇数据";
      note = fans.length ? "相对参考转速 · " + fans.map(fan => `${fan.id.toUpperCase()} 100%=${reference(fan)} RPM`).join(" · ") : "未读取到风扇数据";
    }
    if (id === "battery") detailValue = note;
    if (id === "clock") { ringValue = date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }); detailLabel = note; }
    if (failed && ["cpu", "memory", "gpu", "network", "battery"].includes(id)) { ringValue = "—"; detailLabel = labels[id]; detailValue = "采集暂不可用"; }
    const ringRates = id === "network" ? failed ? ["—", "—"] : [rate(data.networkUploadBytesPerSecond).replace(" MB/s", ""), rate(data.networkDownloadBytesPerSecond).replace(" MB/s", "")] : null;
    return { label: labels[id], value, note, ringValue, detailLabel, detailValue, innerProgress: vramProgress, ringRates, progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : null };
  }
  const api = { labels, describe };
  if (typeof module !== "undefined") module.exports = api; else root.HudMetrics = api;
})(globalThis);

