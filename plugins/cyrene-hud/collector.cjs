"use strict";
// Built-in collector derived from Playa's MIT-licensed system-status. See NOTICE.md and LICENSE.
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const WINDOWS_SCRIPT = [
  "$r = [ordered]@{}",
  "$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | Select-Object DeviceID,Size,FreeSpace)",
  "$net = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue)",
  // Measure-Object returns objects with Property/Sum, not ReceivedBytes/SentBytes.
  "if ($net.Count) { $r.net = @{ r = [double](($net | Measure-Object ReceivedBytes -Sum).Sum); s = [double](($net | Measure-Object SentBytes -Sum).Sum) } } else { $r.net = $null }",
  "$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1",
  "if ($bat) { $r.bat = @{ p = [int]$bat.EstimatedChargeRemaining; status = [int]$bat.BatteryStatus } } else { $r.bat = $null }",
  "$g = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Measure-Object -Property UtilizationPercentage -Sum",
  "if ($g.Sum -ne $null) { $r.gpuEngine = [math]::Round([double]$g.Sum, 1) } else { $r.gpuEngine = $null }",
  "ConvertTo-Json -InputObject $r -Compress -Depth 4",
].join("; ");

function runCommand(cmd, args, timeout, signal) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, signal }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || "") });
    });
  });
}

function parseNvidia(stdout) {
  const nums = stdout.trim().split(/\s*,\s*/).map(value => value.trim() === "" ? NaN : Number(value));
  if (nums.length !== 4 || !nums.every(Number.isFinite)) return null;
  const [temperature, percent, used, total] = nums;
  if (percent < 0 || percent > 100 || used < 0 || total <= 0 || used > total) return null;
  return { temperature, percent, used, total };
}

function createCollector({ system = os, command = runCommand, now = Date.now } = {}) {
  const controller = new AbortController();
  let lastCpu = null, lastNet = null, cached = null, cachedAt = 0, pending = null;
  let nextNvidiaAttempt = 0;
  let nextAsusAttempt = 0;
  const check = () => controller.signal.throwIfAborted();

  function sampleCpu() {
    const cpus = system.cpus();
    const sample = cpus.reduce((sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }), { idle: 0, total: 0 });
    let percent = null;
    if (lastCpu && sample.total > lastCpu.total) {
      percent = Math.round(Math.max(0, Math.min(100, (1 - (sample.idle - lastCpu.idle) / (sample.total - lastCpu.total)) * 100)));
    }
    lastCpu = sample;
    const speed = cpus[0]?.speed;
    return { percent, model: cpus[0]?.model.trim() ?? null, frequencyGhz: Number.isFinite(speed) && speed > 0 ? speed / 1000 : null };
  }

  async function readGpu() {
    if (now() < nextNvidiaAttempt) return null;
    // Select one GPU explicitly; the upstream parser treated multi-GPU CSV as one row.
    const result = await command("nvidia-smi", ["--id=0", "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], 3000, controller.signal);
    const gpu = result.ok ? parseNvidia(result.stdout) : null;
    if (!gpu) nextNvidiaAttempt = now() + 30000;
    return gpu;
  }

  async function readMisc() {
    if (system.platform() !== "win32") return null;
    const result = await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], 8000, controller.signal);
    if (!result.ok) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
  async function readAsusSensors() {
    const unknown = { cpuTemperature: null, fans: [] };
    if (system.platform() !== "win32" || now() < nextAsusAttempt) return unknown;
    const result = await command(path.join(__dirname, "AsusSensors.exe"), [], 1500, controller.signal);
    let value;
    try { if (result.ok) value = JSON.parse(result.stdout); } catch {}
    const cpuTemperature = Number.isFinite(value?.temperature) && value.temperature > 0 && value.temperature <= 125 ? value.temperature : null;
    const fans = [["cpu", "CPU", value?.cpuFanRpm], ["gpu", "GPU", value?.gpuFanRpm], ["mid", "辅助", value?.midFanRpm]].filter(([, , rpm]) => Number.isFinite(rpm) && rpm >= 0 && rpm <= 12000).slice(0, 2).map(([id, label, rpm]) => ({ id, label, rpm }));
    if (cpuTemperature === null && !fans.length) nextAsusAttempt = now() + 30000;
    return { cpuTemperature, fans };
  }

  function netRate(net) {
    const unknown = { total: null, upload: null, download: null };
    if (!net || !Number.isFinite(net.r) || !Number.isFinite(net.s)) { lastNet = null; return unknown; }
    const current = { r: net.r, s: net.s, time: now() }, previous = lastNet;
    lastNet = current;
    if (!previous || current.time <= previous.time || current.r < previous.r || current.s < previous.s) return unknown;
    const elapsed = (current.time - previous.time) / 1000;
    const download = (current.r - previous.r) / elapsed, upload = (current.s - previous.s) / elapsed;
    return { total: download + upload, upload, download };
  }

  async function collect() {
    const cpu = sampleCpu();
    const [gpu, misc, asus] = await Promise.all([readGpu(), readMisc(), readAsusSensors()]);
    check();
    const total = system.totalmem(), used = total - system.freemem();
    const gb = bytes => Math.round(bytes / 1024 ** 3 * 10) / 10;
    const battery = misc?.bat;
    const batteryPercent = battery && Number.isFinite(battery.p) && battery.p >= 0 && battery.p <= 100 ? battery.p : null;
    const gpuFallback = Number.isFinite(misc?.gpuEngine) ? Math.min(100, Math.max(0, Math.round(misc.gpuEngine))) : null;
    const network = netRate(misc?.net);
    return {
      capturedAt: now(), cpuPercent: cpu.percent, cpuModel: cpu.model, cpuFrequencyGhz: cpu.frequencyGhz,
      cpuTemperature: asus.cpuTemperature, cpuTemperatureSource: asus.cpuTemperature === null ? null : "asus-acpi", fans: asus.fans,
      memoryPercent: Math.round(used / total * 100), memoryUsedGb: gb(used), memoryTotalGb: gb(total),
      gpuPercent: gpu ? Math.round(gpu.percent) : gpuFallback,
      gpuSource: gpu ? "nvidia:0" : gpuFallback == null ? null : "wmi-engine-sum",
      gpuTemperature: gpu?.temperature ?? null,
      vramUsedGb: gpu ? Math.round(gpu.used / 1024 * 10) / 10 : null,
      vramTotalGb: gpu ? Math.round(gpu.total / 1024 * 10) / 10 : null,
      vramPercent: gpu ? gpu.used / gpu.total * 100 : null,
      networkBytesPerSecond: network.total, networkUploadBytesPerSecond: network.upload, networkDownloadBytesPerSecond: network.download,
      batteryPercent,
      batteryLabel: batteryPercent == null ? "未检测到电池" : [6, 7, 8, 9].includes(battery.status) ? "充电中" : battery.status === 2 ? "已接通电源" : "电池供电 / 状态未知",
      uptimeSeconds: Math.floor(system.uptime()),
      disks: (Array.isArray(misc?.disks) ? misc.disks : []).filter(d => Number.isFinite(d.Size) && d.Size > 0 && Number.isFinite(d.FreeSpace)).map(d => ({
        name: d.DeviceID || "?", usedGb: gb(d.Size - d.FreeSpace), totalGb: gb(d.Size), percent: Math.round((d.Size - d.FreeSpace) / d.Size * 100),
      })),
    };
  }

  return {
    snapshot(maxAge = 2500) {
      check();
      if (cached && now() - cachedAt < maxAge) return Promise.resolve(cached);
      if (!pending) {
        pending = collect().then(value => { cached = value; cachedAt = now(); return value; }).finally(() => { pending = null; });
      }
      return pending;
    },
    dispose() { controller.abort(); cached = null; lastCpu = null; lastNet = null; },
  };
}

module.exports = { createCollector, parseNvidia, WINDOWS_SCRIPT };
