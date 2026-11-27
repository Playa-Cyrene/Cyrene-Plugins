"use strict";

/**
 * Windows Hello 门禁 + DPAPI 本地保护。
 *
 * 两个能力：
 * - helloVerify()：弹系统 Hello 验证，返回是否通过
 * - dpapiProtect / dpapiUnprotect：用当前 Windows 用户的 DPAPI 保护一段字节
 *
 * 安全边界要说清楚：DPAPI 绑的是 Windows 账户，不是 Hello 本身。
 * Hello 只负责「证明坐在电脑前的是号主」，解密的钥匙仍在 DPAPI 里。
 * 也就是说，能在这个账户下跑代码的进程，理论上可以绕过 Hello 直接解 DPAPI。
 * 防的是「别人拿到电脑」，不是「本机恶意软件」。
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

function runPowerShell(scriptName, args, input, options) {
  return new Promise((resolve, reject) => {
    const opts = options || {};
    const argv = ["-NoProfile"];
    if (!opts.interactive) argv.push("-NonInteractive");
    argv.push("-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, scriptName));
    for (const arg of args || []) argv.push(arg);

    const child = spawn("powershell.exe", argv, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error("PowerShell 超时"));
    }, opts.timeoutMs || 60000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code !== 0) {
        const detail = (out || stderr.trim() || "exit " + code).replace(/^ERROR\s*/, "");
        reject(new Error(detail));
        return;
      }
      resolve(out);
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

const AVAILABILITY_TEXT = {
  Available: "可用",
  DeviceNotPresent: "这台设备没有可用的 Hello 硬件",
  NotConfiguredForUser: "还没有为当前账户设置 Windows Hello",
  DisabledByPolicy: "被组策略关闭了",
  DeviceBusy: "设备正忙，稍后再试",
};

const RESULT_TEXT = {
  Verified: "已通过",
  DeviceNotPresent: "没有可用的 Hello 硬件",
  NotConfiguredForUser: "还没有设置 Windows Hello",
  DisabledByPolicy: "被组策略关闭了",
  Canceled: "已取消",
  RetriesExhausted: "重试次数用完了",
  DeviceBusy: "设备正忙",
};

async function helloAvailability() {
  try {
    const raw = await runPowerShell("windows-hello.ps1", ["-Mode", "availability"], null, {
      timeoutMs: 30000,
    });
    return { ok: raw === "Available", code: raw, text: AVAILABILITY_TEXT[raw] || raw };
  } catch (error) {
    return { ok: false, code: "Error", text: String(error.message || error) };
  }
}

async function helloVerify(message) {
  try {
    const raw = await runPowerShell(
      "windows-hello.ps1",
      ["-Mode", "verify", "-Message", message || "Unlock Cyrene Keyring"],
      null,
      { timeoutMs: 120000, interactive: true }
    );
    return { ok: raw === "Verified", code: raw, text: RESULT_TEXT[raw] || raw };
  } catch (error) {
    return { ok: false, code: "Error", text: String(error.message || error) };
  }
}

async function dpapiProtect(base64) {
  const out = await runPowerShell("dpapi.ps1", ["-Mode", "protect"], base64, { timeoutMs: 30000 });
  if (!out || out.startsWith("ERROR")) throw new Error(out || "DPAPI 加密失败");
  return out;
}

async function dpapiUnprotect(base64) {
  const out = await runPowerShell("dpapi.ps1", ["-Mode", "unprotect"], base64, { timeoutMs: 30000 });
  if (!out || out.startsWith("ERROR")) throw new Error(out || "DPAPI 解密失败");
  return out;
}

module.exports = {
  helloAvailability,
  helloVerify,
  dpapiProtect,
  dpapiUnprotect,
};
