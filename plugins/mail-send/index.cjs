"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// 插件自带的脚本优先；旧的 CyreneMaintenance 路径作为回退，照顾已手动部署过的机器
const BUNDLED_SCRIPT = path.join(__dirname, "send_mail.ps1");
const LEGACY_SCRIPT = path.join(process.env.LOCALAPPDATA || "", "CyreneMaintenance", "send_mail.ps1");
const SCRIPT = fs.existsSync(BUNDLED_SCRIPT) ? BUNDLED_SCRIPT : LEGACY_SCRIPT;
const SETTINGS = path.join(process.env.APPDATA || "", "Cyrene", "app-settings.json");

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch (e) {
    return null;
  }
}

function runPowerShell(scriptPath, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true }
    );
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      reject(new Error(`发送超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    const onAbort = () => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      reject(new Error("已取消发送"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && signal.removeEventListener) signal.removeEventListener("abort", onAbort);
      resolve({ code, out, err });
    });
  });
}

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "mail-send_send",
      name: "发送邮件",
      description:
        "用本机 Cyrene 已配置的 SMTP 账号静默发送一封邮件（无需用户确认）。" +
        "适用场景：用户说「发我邮箱」「把结果邮件给我」「发到我的邮箱」，或需要把生成的文件作为附件寄出。" +
        "参数：to 收件人地址；subject 主题；body 纯文本正文；attach 附件绝对路径数组（可多个）；" +
        "bodyFile 从 UTF-8 文件读正文（正文很长或含大量中文时优先用它）。返回 SENT_OK 表示服务器已接收。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "收件人邮箱地址" },
          subject: { type: "string", description: "邮件主题" },
          body: { type: "string", description: "纯文本正文；与 bodyFile 二选一" },
          bodyFile: { type: "string", description: "UTF-8 文本文件绝对路径，正文从文件读取（优先于 body）" },
          attach: {
            type: "array",
            items: { type: "string" },
            description: "附件绝对路径列表，可为空",
          },
          timeoutSeconds: { type: "number", description: "超时秒数，默认 180" },
        },
        required: ["to"],
      },
      async execute(args, execCtx) {
        const signal = execCtx && execCtx.signal;
        const to = String(args.to || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          throw new Error(`收件人地址不合法：${to}`);
        }
        if (!fs.existsSync(SCRIPT)) {
          throw new Error(`发信脚本不存在：${SCRIPT}`);
        }
        const st = readSettings();
        if (!st || !st.emailSmtpHost || !st.emailSmtpUser || !st.emailSmtpPass) {
          throw new Error("Cyrene 未配置 SMTP（app-settings.json 缺少 emailSmtpHost / emailSmtpUser / emailSmtpPass）");
        }

        const attach = Array.isArray(args.attach) ? args.attach.map(String) : [];
        const missing = attach.filter((p) => !fs.existsSync(p));
        if (missing.length) {
          throw new Error("附件不存在：" + missing.join("；"));
        }

        let bodyPath = args.bodyFile ? String(args.bodyFile) : "";
        if (bodyPath && !fs.existsSync(bodyPath)) {
          throw new Error(`正文文件不存在：${bodyPath}`);
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mail-"));
        try {
          if (!bodyPath) {
            bodyPath = path.join(tmpDir, "body.txt");
            // PowerShell 5.1 的 -Encoding UTF8 对无 BOM 文件会按 ANSI 解，必须带 BOM
            fs.writeFileSync(bodyPath, "\uFEFF" + String(args.body || ""), "utf8");
          }

          const lines = [
            "$ErrorActionPreference = 'Stop'",
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
            "& " + psQuote(SCRIPT) + " `",
            "  -To " + psQuote(to) + " `",
            "  -Subject " + psQuote(args.subject || "Cyrene Mail") + " `",
            "  -BodyFile " + psQuote(bodyPath) +
              (attach.length
                ? " `\n  -Attach " + attach.map(psQuote).join(", ")
                : ""),
          ];
          const wrapper = path.join(tmpDir, "send.ps1");
          fs.writeFileSync(wrapper, "\uFEFF" + lines.join("\n") + "\n", "utf8");

          const timeoutMs = Math.max(30, Number(args.timeoutSeconds) || 180) * 1000;
          const r = await runPowerShell(wrapper, timeoutMs, signal);
          const text = (r.out || "").trim();
          const errText = (r.err || "").trim();

          if (r.code !== 0 || !/SENT_OK/.test(text)) {
            const detail = [text, errText].filter(Boolean).join("\n").slice(0, 1200);
            throw new Error(`发送失败（退出码 ${r.code}）\n${detail || "无输出"}`);
          }

          const sizeMb = attach.reduce((n, p) => n + fs.statSync(p).size, 0) / 1048576;
          return (
            `已发送 → ${to}\n` +
            `主题：${args.subject || "Cyrene Mail"}\n` +
            `附件：${attach.length} 个${attach.length ? `（合计 ${sizeMb.toFixed(2)} MB）` : ""}\n` +
            `服务器返回：${text.split("\n").pop()}`
          );
        } finally {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        }
      },
    });

    ctx.registerTool({
      id: "mail-send_status",
      name: "邮件配置自检",
      description:
        "检查 Cyrene 的 SMTP 发信配置是否可用（不返回密码）。用户问「邮件能不能发」「发信配置好了吗」，或发送失败需要排查时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const lines = [];
        lines.push(`脚本：${SCRIPT} ${fs.existsSync(SCRIPT) ? "存在" : "缺失"}`);
        const st = readSettings();
        if (!st) {
          lines.push(`配置：读取失败（${SETTINGS}）`);
          return lines.join("\n");
        }
        lines.push(`SMTP 主机：${st.emailSmtpHost || "（未设置）"}`);
        lines.push(`端口：${st.emailSmtpPort || "（未设置）"}`);
        lines.push(`账号：${st.emailSmtpUser || "（未设置）"}`);
        lines.push(`密码：${st.emailSmtpPass ? "已设置" : "（未设置）"}`);
        lines.push(`发件人显示名：${st.emailFromName || "（未设置）"}`);
        const ready = Boolean(st.emailSmtpHost && st.emailSmtpUser && st.emailSmtpPass && fs.existsSync(SCRIPT));
        lines.push(`结论：${ready ? "可以发送" : "配置不完整，无法发送"}`);
        return lines.join("\n");
      },
    });

    ctx.log("mail-send 已注册：mail-send_send / mail-send_status");
  },

  async unregister() {},
};
