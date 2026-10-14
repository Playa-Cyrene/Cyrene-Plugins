"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");

function createGlass(onStatus, launch = spawn, onLuminance = () => {}, onPower = () => {}, onRaise = () => {}) {
  let child, timer, status = "off", settings, disposed = false, drawing, lastStyle;
  const update = value => { status = value; onStatus(value); };
  function stop() {
    clearTimeout(timer);
    const previous = child; child = undefined;
    lastStyle = undefined;
    if (previous) previous.kill();
    status = "off";
    onLuminance(null);
  }
  function sync(force = true) {
    if (child && status === "ready") {
      const canvas = Number.isFinite(settings.canvasWidth) ? ` ${settings.offsetX} ${settings.offsetY} ${settings.canvasWidth} ${settings.scale} ${settings.sampleWidth}` : "";
      const style = `style ${settings.radius} ${settings.width} ${settings.height} ${settings.background}${canvas}\n`;
      if (force || style !== lastStyle) { child.stdin.write(style); lastStyle = style; }
    }
  }
  return {
    get status() { return status; },
    set(config, handle, moved = false) {
      settings = config;
      if (disposed) return;
      if (config.background === "solid") { stop(); return; }
      const nextDrawing = config.background === "acrylic";
      if (drawing !== nextDrawing) { stop(); drawing = nextDrawing; }
      if (child) { sync(moved); return; }
      if (status === "failed") return;
      status = "starting";
      const current = launch(path.join(__dirname, "GlassHost.exe"), drawing ? [handle] : [handle, "--sample-only"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      child = current;
      const fail = () => { if (child === current) { stop(); update("failed"); } };
      current.on("error", fail); current.on("exit", fail); current.stdin.on("error", fail);
      timer = setTimeout(fail, 8000);
      let pending = "";
      current.stdout.on("data", chunk => {
        if (child !== current) return;
        pending += chunk;
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          if (child !== current) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.ready && status === "starting") { clearTimeout(timer); update("ready"); sync(); }
            if (Number.isFinite(message.luminance) && message.luminance >= 0 && message.luminance <= 255) onLuminance(message.luminance);
            if (typeof message.powerPaused === "boolean") onPower(message.powerPaused);
            if (message.needsRaise === true) onRaise();
          } catch {}
        }
      });
    },
    sync,
    dispose() { disposed = true; stop(); },
  };
}
module.exports = { createGlass };
