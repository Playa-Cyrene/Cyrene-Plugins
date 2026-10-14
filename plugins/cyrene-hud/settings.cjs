"use strict";
const DEFAULTS = { metric: "memory", mode: "hover", hoverDelay: 0.35, displayDuration: 4, avatarTarget: "none", avatarSession: "new", avatarSessionId: null, position: "top-center", displayId: null, width: 408, height: 60, radius: 30, background: "acrylic", backgroundColor: "#f9f4f8", tintOpacity: 0.2, scale: 1, opacity: 0.8, clickThrough: true, cpuFanReferenceRpm: 6300, gpuFanReferenceRpm: 6300, midFanReferenceRpm: 6300 };
function normalizeSettings(value = {}) {
  if (!value || typeof value !== "object") value = {};
  const choice = (key, options) => options.includes(value[key]) ? value[key] : DEFAULTS[key];
  const number = (key, min, max) => Number.isFinite(value[key]) ? Math.min(max, Math.max(min, value[key])) : DEFAULTS[key];
  const allowed = ["cpu", "memory", "gpu", "network", "battery", "clock", "fan"];
  const selected = Array.isArray(value.metrics) ? [...new Set(value.metrics.filter(id => allowed.includes(id)))] : allowed.includes(value.metric) ? [value.metric] : ["memory", "cpu", "gpu"];
  const metrics = selected.length ? selected : ["memory", "cpu", "gpu"];
  return {
    metrics,
    metric: choice("metric", allowed),
    mode: choice("mode", ["persistent", "hover"]),
    hoverDelay: number("hoverDelay", 0, 10),
    displayDuration: number("displayDuration", 0.1, 60),
    avatarTarget: choice("avatarTarget", ["none", "chat", "work", "code", "learn", "settings"]),
    avatarSession: choice("avatarSession", ["new", "existing"]),
    avatarSessionId: typeof value.avatarSessionId === "string" && value.avatarSessionId.length <= 128 && value.avatarSessionId.trim() ? value.avatarSessionId : null,
    position: "top-center",
    displayId: Number.isInteger(value.displayId) ? value.displayId : null,
    width: Math.round(number("width", 340, 800)), height: Math.round(number("height", 60, 320)),
    radius: Math.round(number("radius", 0, 160)),
    background: choice("background", ["solid", "clear", "acrylic", "mica"]),
    backgroundColor: typeof value.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(value.backgroundColor) ? value.backgroundColor.toLowerCase() : DEFAULTS.backgroundColor,
    tintOpacity: number("tintOpacity", 0, 1),
    scale: number("scale", 0.7, 1.4), opacity: number("opacity", 0.35, 1),
    clickThrough: typeof value.clickThrough === "boolean" ? value.clickThrough : true,
    cpuFanReferenceRpm: Math.round(number("cpuFanReferenceRpm", 1000, 12000)),
    gpuFanReferenceRpm: Math.round(number("gpuFanReferenceRpm", 1000, 12000)),
    midFanReferenceRpm: Math.round(number("midFanReferenceRpm", 1000, 12000)),
  };
}
function supportsMaterial(platform, release) {
  const [major, , build] = release.split(".").map(Number);
  return platform === "win32" && (major > 10 || (major === 10 && build >= 22621));
}
function hudBounds(settings, display, material = false) {
  const area = display.workArea;
  const baseWidth = settings.width + (material ? 0 : 32), baseHeight = settings.height + (material ? 0 : 42);
  const scale = Math.min(settings.scale, area.width / baseWidth, area.height / baseHeight);
  const width = Math.round(baseWidth * scale), height = Math.round(baseHeight * scale);
  const margin = Math.min(20, Math.max(0, (area.width - width) / 2), Math.max(0, (area.height - height) / 2));
  const [vertical, horizontal] = settings.position.split("-");
  return { scale, bounds: {
    x: Math.round(area.x + (horizontal === "left" ? margin : horizontal === "right" ? area.width - width - margin : (area.width - width) / 2)),
    y: Math.round(area.y + (vertical === "top" ? margin : area.height - height - margin)), width, height,
  } };
}
module.exports = { DEFAULTS, normalizeSettings, hudBounds, supportsMaterial };



