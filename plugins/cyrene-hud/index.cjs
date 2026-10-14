"use strict";
const path = require("node:path");
const { normalizeSettings, hudBounds, supportsMaterial } = require("./settings.cjs");
const { createCollector } = require("./collector.cjs");
const { createGlass } = require("./glass.cjs");
const { createNotifications } = require("./notifications.cjs");
const edition = require("./edition.cjs");
const { DETAIL_WIDTH, measure, compose, ease } = require("./motion.cjs");
let openSettings;

module.exports = {
  async register(ctx) {
    const { BrowserWindow, screen } = require("electron");
    const materialSupported = supportsMaterial(process.platform, require("node:os").release());
    const collector = createCollector();
    ctx.onDispose(() => collector.dispose());
    let config = normalizeSettings(ctx.storage.get("settings")), hud, panel, timer;
    let performanceSnapshot = {}, performanceFailed = false, performanceBusy = false, nextPerformanceSample = 0;
    ctx.registerIpc("snapshot", () => {
      if (performanceFailed) throw Error("性能数据暂不可用");
      return performanceSnapshot;
    });
    let stopped = false, ready = false, hideAt = 0, hot = false, hoverSince = null, avatarHovered = false, backdropLuminance = null, powerPaused = false;
    let base, rest, scale = 1, inset = 0, frame, animation, reducedMotion = false, appliedBackground;
    let amounts = {}, transitions = {}, active = null, candidate = null, candidateSince = 0, leaveSince = null;
    const detailWidths = { ...DETAIL_WIDTH };
    let avatarWidth = 240;
    let lastPointer, mouseIgnored, nextRaise = 0;
    let expanded = false, revealAmount = 0, revealTransition;
    const notifications = createNotifications(ctx.storage);
    let noticeActive = false, noticeAmount = 0, noticeTransition, noticeUntil = 0;
    let demo;
    const notificationView = () => demo ? demo.notification : notifications.view();
    const glass = createGlass(refreshMaterial, undefined, value => {
      if (backdropLuminance === value) return;
      backdropLuminance = value;
      if (ready && !stopped && !hud.isDestroyed()) hud.webContents.send("plugin:cyrene-hud:changed", state());
    }, value => {
      if (powerPaused === value) return;
      powerPaused = value;
      refreshMaterial();
    }, () => { if (ready && !stopped && !hud.isDestroyed() && hud.isVisible()) raise(); });
    const selectedDisplay = () => screen.getAllDisplays().find(display => display.id === config.displayId) || screen.getPrimaryDisplay();
    const requestedBackground = () => config.background === "mica" && config.mode === "hover" ? "acrylic" : config.background;
    const background = () => (!materialSupported && ["acrylic", "mica"].includes(requestedBackground())) || (requestedBackground() === "acrylic" && glass.status === "failed") ? "solid" : requestedBackground() === "acrylic" && powerPaused ? "clear" : requestedBackground();
    const state = () => ({ config: demo ? demo.config : config, layout: frame, expanded, testing: !!demo, notification: notificationView(), edition, materialSupported, glassStatus: glass.status, backdropLuminance, powerPaused, effectiveBackground: background(), displays: screen.getAllDisplays().map(display => ({ id: display.id, label: display.label || `${display.size.width} × ${display.size.height}` })) });
    function notificationChanged() {
      if (!ready || stopped || hud.isDestroyed()) return;
      hud.webContents.send("plugin:cyrene-hud:changed", state());
      paintLayout(); syncMouse();
    }
    function overNotification(point) {
      if (!frame || !notificationView().count) return false;
      const x = (point.x - hud.getBounds().x) / scale, y = (point.y - hud.getBounds().y) / scale;
      if (expanded && revealAmount === 100) return x >= frame.offsetX + base.padding + 33 && x <= frame.offsetX + base.padding + 47 && y >= frame.offsetY + base.height / 2 - 25 && y <= frame.offsetY + base.height / 2 - 11;
      if (noticeActive && noticeAmount > 95) return overCard(point);
      return false;
    }
    function refreshMaterial() {
      if (!ready || stopped || hud.isDestroyed()) return;
      if (appliedBackground !== background()) apply(true);
      else for (const win of [hud, panel]) if (win && !win.isDestroyed()) win.webContents.send("plugin:cyrene-hud:changed", state());
    }
    function overCard(point) {
      const left = frame.bounds.x + inset * scale, top = frame.bounds.y + (inset ? 21 : 0) * scale;
      return point.x >= left && point.x < left + frame.width * scale && point.y >= top && point.y < top + frame.height * scale;
    }
    function syncMouse() {
      const point = screen.getCursorScreenPoint();
      const ignore = !hud.isVisible() || !overNotification(point) && (!expanded || revealAmount !== 100 || !(avatarHovered && config.avatarTarget !== "none") && (config.clickThrough || !overCard(point)));
      if (mouseIgnored !== ignore) { mouseIgnored = ignore; hud.setIgnoreMouseEvents(ignore, { forward: true }); }
    }
    const preferences = { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true };
    function lockNavigation(win) {
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", event => event.preventDefault());
    }
    function raise() {
      hud.setAlwaysOnTop(true, "floating");
      hud.moveTop();
      glass.sync();
      nextRaise = Date.now() + 1000;
    }
    function reveal() {
      if (ready && !stopped && !hud.isDestroyed()) {
        const changed = !expanded;
        expanded = true; hideAt = 0;
        if (changed) nextPerformanceSample = 0;
        noticeActive = false; noticeUntil = 0;
        hud.showInactive();
        raise();
        syncMouse();
        if (changed || config.mode === "persistent") hud.webContents.send("plugin:cyrene-hud:visibility", true);
        if (revealAmount !== 100 || noticeAmount !== 0) animate();
      }
    }
    function retract() {
      expanded = false; hideAt = 0; avatarHovered = false;
      active = candidate = null; leaveSince = null; lastPointer = undefined;
      hud.webContents.send("plugin:cyrene-hud:visibility", false);
      syncMouse(); animate();
    }
    function apply(preserveVisibility = false) {
      if (stopped || hud.isDestroyed()) return;
      if (preserveVisibility !== true) nextPerformanceSample = 0;
      const material = ["acrylic", "mica"].includes(background());
      appliedBackground = background();
      clearInterval(animation); animation = undefined;
      if (preserveVisibility !== true) { expanded = config.mode === "persistent"; revealAmount = expanded ? 100 : 0; revealTransition = null; if (expanded) { noticeActive = false; noticeAmount = noticeUntil = 0; noticeTransition = null; } }
      amounts = {}; transitions = {}; active = candidate = null; leaveSince = null; lastPointer = undefined;
      base = measure(config); inset = material ? 0 : 16;
      // Reserve room for the largest detail so zoom never changes during expansion.
      const area = selectedDisplay().workArea;
      const detailRoom = Math.max(328 - base.width, ...config.metrics.map(id => DETAIL_WIDTH[id]));
      // Reserve four DIP for rounding the centred start and animated width.
      scale = Math.min(config.scale, (area.width - 4) / (base.width + detailRoom * 2 + inset * 2), area.height / (base.height + (material ? 0 : 42)));
      rest = hudBounds({ ...config, width: base.width, scale }, selectedDisplay(), material).bounds;
      hud.webContents.setZoomFactor(scale);
      // A fixed transparent canvas avoids reallocating either native window's
      // backing surface on each animation frame. Only the card inside it animates.
      hud.setBounds(appliedBackground === "mica" ? rest : { x: area.x, y: config.mode === "hover" ? area.y : rest.y, width: area.width, height: rest.height + (config.mode === "hover" ? rest.y - area.y : 0) });
      paintLayout();
      if (materialSupported) hud.setBackgroundMaterial(background() === "mica" ? "mica" : "none");
      // Material updates replace the window backing color; restore per-pixel
      // transparency so CSS/composition can keep antialiased rounded edges.
      hud.setBackgroundColor("#00000000");
      hud.setOpacity(config.opacity);
      syncMouse();
      hud.setAlwaysOnTop(true, "floating");
      if (preserveVisibility !== true) {
        hot = false; hoverSince = null; hideAt = 0;
        hud.showInactive(); raise();
        hud.webContents.send("plugin:cyrene-hud:visibility", expanded);
      }
      if (revealAmount !== (expanded ? 100 : 0) || noticeAmount !== (noticeActive ? 100 : 0)) animate();
      for (const win of [hud, panel]) if (win && !win.isDestroyed()) win.webContents.send("plugin:cyrene-hud:changed", state());
    }
    function paintLayout() {
      // Keep animation state continuous, but paint geometry on the same physical
      // pixel grid as BrowserWindow so fractional sizes cannot shift the text.
      const painted = Object.fromEntries(config.metrics.map(id => [id, Math.round((amounts[id] || 0) * scale) / scale]));
      const widths = Object.fromEntries(config.metrics.map(id => [id, detailWidth(id)]));
      const avatarAmount = Math.round((amounts.avatar || 0) * scale) / scale, avatarDetailWidth = Math.max(detailWidth("avatar"), avatarAmount);
      frame = { ...compose(base, config.metrics, painted, widths), active, avatarProgress: avatarAmount / avatarDetailWidth, avatarDetailX: base.padding + 60, avatarDetailWidth };
      frame.width += Math.max(0, frame.avatarDetailX + avatarAmount + base.padding - base.width);
      frame.contentWidth = frame.width; frame.contentHeight = frame.height;
      const progress = Math.max(0, Math.min(1, revealAmount / 100)), area = selectedDisplay().workArea;
      const noticeProgress = Math.max(0, Math.min(1, noticeAmount / 100));
      const visibleNotice = Math.min(noticeProgress, 1 - progress);
      frame.revealProgress = progress;
      frame.noticeProgress = visibleNotice;
      frame.radius = 5 + (config.radius - 5) * progress + 16 * visibleNotice;
      if (progress !== 1) {
        frame.width = Math.round((48 + (frame.width - 48) * progress + 168 * visibleNotice) * scale) / scale;
        frame.height = Math.round((10 + (frame.height - 10) * progress + 32 * visibleNotice) * scale) / scale;
      }
      const width = Math.round((frame.width + inset * 2) * scale);
      frame.bounds = { ...rest, width };
      if (config.mode === "hover") {
        const pillLeft = area.x + (area.width - 48 * scale) / 2, pillTop = area.y + 4 * scale;
        frame.bounds.x = Math.round(pillLeft + (rest.x + inset * scale - pillLeft) * progress - 84 * scale * visibleNotice - inset * scale);
        frame.bounds.y = Math.round(pillTop - (inset ? 21 : 0) * scale);
        frame.bounds.height = Math.round((frame.height + (inset ? 42 : 0)) * scale);
      }
      // Electron's native mica fills its whole HWND; keep that mode bounded
      // to the card so transparent canvas margins do not acquire a material.
      if (appliedBackground === "mica") {
        const previous = hud.getBounds();
        if (Object.keys(frame.bounds).some(key => frame.bounds[key] !== previous[key])) hud.setBounds(frame.bounds);
      }
      const canvas = hud.getBounds();
      frame.offsetX = (frame.bounds.x - canvas.x) / scale + inset;
      frame.offsetY = (frame.bounds.y - canvas.y) / scale + (inset ? 21 : 0);
      // Both native composition and the renderer follow this one animation timeline.
      const handle = hud.getNativeWindowHandle();
      glass.set({ ...config, width: frame.width, height: frame.height, radius: frame.radius, sampleWidth: 48 + (base.width - 48) * progress + 168 * visibleNotice, scale, offsetX: frame.offsetX, offsetY: frame.offsetY, canvasWidth: canvas.width, background: materialSupported ? (requestedBackground() === "acrylic" && powerPaused ? "clear" : requestedBackground()) : "solid" }, (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString());
      hud.webContents.send("plugin:cyrene-hud:layout", frame);
    }
    function detailWidth(id) {
      const area = selectedDisplay().workArea;
      const rightSpace = (area.x + area.width - rest.x - 4) / scale - inset * 2;
      const limit = id === "avatar" ? rightSpace - (base.padding + 60) - base.padding : rightSpace - base.width;
      return Math.max(16 / scale, Math.floor(Math.min(id === "avatar" ? avatarWidth : detailWidths[id], limit) * scale) / scale);
    }
    function animate() {
      clearInterval(animation);
      const step = () => {
        if (stopped || !hud.isVisible()) { clearInterval(animation); animation = undefined; return; }
        const now = Date.now();
        let moving = false;
        const revealTarget = expanded ? 100 : 0;
        const nextReveal = reducedMotion ? { value: revealTarget, transition: null } : ease(revealAmount, revealTransition, revealTarget, now);
        revealAmount = nextReveal.value; revealTransition = nextReveal.transition;
        if (revealTransition) moving = true;
        const noticeTarget = noticeActive && !expanded ? 100 : 0;
        const nextNotice = reducedMotion ? { value: noticeTarget, transition: null } : ease(noticeAmount, noticeTransition, noticeTarget, now);
        noticeAmount = nextNotice.value; noticeTransition = nextNotice.transition;
        if (noticeTransition) moving = true;
        for (const id of [...config.metrics, "avatar"]) {
          const target = id === active ? detailWidth(id) : 0;
          const next = reducedMotion ? { value: target, transition: null } : ease(amounts[id] || 0, transitions[id], target, now);
          amounts[id] = next.value; transitions[id] = next.transition;
          if (next.transition) moving = true;
        }
        paintLayout();
        syncMouse();
        if (!moving) { clearInterval(animation); animation = undefined; }
      };
      animation = setInterval(step, 16);
      if (reducedMotion) step();
    }
    function expand(id) {
      if (active === id) return;
      active = id; animate();
    }
    function metricHover(point, now) {
      const moved = !lastPointer || point.x !== lastPointer.x || point.y !== lastPointer.y;
      lastPointer = { x: point.x, y: point.y };
      const bounds = frame.bounds, x = (point.x - bounds.x) / scale - inset, y = (point.y - bounds.y) / scale - (inset ? 21 : 0);
      const avatarEnd = frame.avatarDetailX + frame.avatarDetailWidth * frame.avatarProgress;
      const overAvatar = y >= (base.height - 44) / 2 && y <= (base.height + 44) / 2 && x >= base.padding && x <= (active === "avatar" ? Math.max(base.padding + 44, avatarEnd) : base.padding + 44);
      const hit = overAvatar ? { id: "avatar" } : y >= (base.height - base.ring) / 2 && y <= (base.height + base.ring) / 2 ? frame.items.find(item => !(frame.avatarProgress > .01 && item.x < avatarEnd && item.x + base.ring + item.amount > frame.avatarDetailX) && x >= item.x && x <= item.x + base.ring + item.amount) : null;
      // Layout movement alone must not start a new hover candidate.
      const item = hit && (moved || hit.id === active || hit.id === candidate) ? hit : null;
      if (item) {
        leaveSince = null;
        if (candidate !== item.id) { candidate = item.id; candidateSince = now; }
        if (now - candidateSince >= 150) expand(item.id);
      } else {
        candidate = null;
        if (active && leaveSince === null) leaveSince = now;
        if (active && now - leaveSince >= 200) expand(null);
      }
    }
    function stopDemo() {
      if (!demo) return;
      config = demo.config; demo = undefined;
      noticeActive = false; noticeAmount = noticeUntil = 0; noticeTransition = null;
      apply();
    }
    function demoAction(action) {
      if (action === "stop") { stopDemo(); return state(); }
      if (!["all", "leave", "notification", "avatar", ...config.metrics].includes(action)) throw Error("请选择可见的测试区域");
      if (!demo) {
        demo = { config, notification: { count: 0, preview: "" } };
        config = { ...config, mode: "hover" };
        noticeActive = false; noticeAmount = noticeUntil = 0; noticeTransition = null;
        apply();
      }
      demo.until = Date.now() + 60000;
      demo.queue = action === "all" ? ["avatar", ...config.metrics, "leave", "notification", "avatar", "stop"] : [action];
      demo.next = 0;
      return state();
    }
    function demoPointer(now) {
      if (now >= demo.until) { stopDemo(); return screen.getCursorScreenPoint(); }
      if (demo.queue.length && now >= demo.next) {
        const action = demo.queue.shift();
        if (action === "stop") { stopDemo(); return screen.getCursorScreenPoint(); }
        demo.action = action;
        candidate = null; lastPointer = undefined; expand(null);
        demo.next = now + (action === "notification" ? 5500 : action === "leave" ? config.displayDuration * 1000 + 1200 : 2200 + (!expanded ? config.hoverDelay * 1000 + 1200 : 0));
        if (action === "notification") { retract(); demo.pendingNotice = true; }
        else demo.pendingNotice = false;
      }
      if (demo.pendingNotice && revealAmount === 0) {
        demo.pendingNotice = false;
        demo.notification = { count: demo.notification.count + 1, preview: "这是一条模拟主动消息，记得休息一下哦。" };
        noticeActive = true; noticeUntil = 0; animate(); notificationChanged();
      }
      if (["leave", "notification"].includes(demo.action)) return { x: -100000, y: -100000 };
      // Let the previous detail uncover neighbouring rings before entering them.
      if (active !== demo.action && Object.values(amounts).some(value => value > 0)) return { x: -100000, y: -100000 };
      if (!expanded || revealAmount !== 100) { const area = selectedDisplay().workArea; return { x: area.x + area.width / 2, y: area.y + 4 * scale }; }
      const item = frame.items.find(item => item.id === demo.action);
      const x = demo.action === "avatar" ? base.padding + 22 : (item?.x ?? base.padding) + base.ring / 2;
      return { x: frame.bounds.x + (inset + x) * scale, y: frame.bounds.y + ((inset ? 21 : 0) + base.height / 2) * scale };
    }
    function samplePerformance(now) {
      if (stopped || demo || performanceBusy || now < nextPerformanceSample || !config.metrics.some(id => id !== "clock")) return;
      performanceBusy = true;
      nextPerformanceSample = now + (expanded && hud.isVisible() ? 1000 : 5000);
      Promise.resolve(collector.snapshot(0)).then(value => {
        if (stopped || demo) return;
        performanceSnapshot = value; performanceFailed = false;
        hud.webContents.send("plugin:cyrene-hud:snapshot", value);
      }, () => {
        if (stopped || demo) return;
        performanceFailed = true;
        hud.webContents.send("plugin:cyrene-hud:snapshot", null);
      }).finally(() => { performanceBusy = false; });
    }
    // The top-centre hot zone belongs to the chosen display; it never takes focus.
    function tick() {
      if (!ready) return;
      const point = demo ? demoPointer(Date.now()) : screen.getCursorScreenPoint(), area = selectedDisplay().workArea;
      const inside = Math.abs(point.x - (area.x + area.width / 2)) <= 32 * scale && point.y >= area.y && point.y <= area.y + 22 * scale;
      const now = Date.now();
      samplePerformance(now);
      if (noticeActive && noticeAmount === 100 && !noticeUntil) noticeUntil = now + 2000;
      if (noticeUntil && now >= noticeUntil) { noticeActive = false; noticeUntil = 0; animate(); }
      if (config.mode === "hover" && inside) {
        if (hoverSince === null) hoverSince = now;
        if (!hot && now - hoverSince >= config.hoverDelay * 1000) { if (!expanded) reveal(); hot = true; }
      } else { hoverSince = null; hot = false; }
      if (!hud.isVisible()) return;
      if ((background() === "solid" || glass.status !== "ready") && now >= nextRaise) raise();
      if (!expanded && revealAmount > 0 && (inside || overCard(point))) reveal();
      if (expanded && revealAmount === 100) metricHover(point, now);
      syncMouse();
      if (config.mode !== "hover" || !expanded) return;
      const overWindow = overCard(point) || overNotification(point);
      if (inside || overWindow) {
        hideAt = 0;
      } else if (!hideAt) hideAt = now + config.displayDuration * 1000;
      if (hideAt && now >= hideAt) {
        retract();
      }
    }
    ctx.onDispose(() => {
      stopped = true; clearInterval(timer); clearInterval(animation); openSettings = undefined;
      glass.dispose();
      for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.removeListener(event, apply);
      for (const win of [panel, hud]) if (win && !win.isDestroyed()) win.destroy();
    });
    ctx.registerIpc("state", state);
    ctx.registerIpc("notification-checkpoint", () => notifications.checkpoint());
    ctx.registerIpc("notification-batch", batch => {
      ctx.signal.throwIfAborted();
      const added = notifications.ingest(batch);
      if (!demo && added && !expanded && config.mode === "hover") { noticeActive = true; noticeUntil = 0; if (ready) animate(); }
      if (!demo && !notifications.view().count) { noticeActive = false; noticeUntil = 0; if (ready && noticeAmount) animate(); }
      notificationChanged();
    });
    ctx.registerIpc("notification-target", () => demo ? null : notifications.target());
    ctx.registerIpc("ui-test", action => { ctx.signal.throwIfAborted(); return demoAction(action); });
    const acknowledge = target => {
      ctx.signal.throwIfAborted(); notifications.acknowledge(target);
      if (!notifications.view().count) { noticeActive = false; noticeUntil = 0; if (noticeAmount) animate(); }
      notificationChanged();
    };
    ctx.registerIpc("notification-read", acknowledge);
    ctx.registerIpc("reduced-motion", value => { ctx.signal.throwIfAborted(); reducedMotion = value === true; if (animation) animate(); });
    ctx.registerIpc("detail-widths", value => {
      ctx.signal.throwIfAborted();
      let changed = false;
      for (const id of config.metrics) {
        const width = value?.metrics?.[id];
        if (Number.isFinite(width) && width >= 16 && width <= 2000 && detailWidths[id] !== width) { detailWidths[id] = width; changed = true; }
      }
      if (Number.isFinite(value?.avatar) && value.avatar >= 16 && value.avatar <= 2000 && avatarWidth !== value.avatar) { avatarWidth = value.avatar; changed = true; }
      if (changed && rest) { if (active) animate(); else paintLayout(); }
    });
    ctx.registerIpc("avatar-hover", value => {
      ctx.signal.throwIfAborted();
      avatarHovered = value === true && config.avatarTarget !== "none" && hud.isVisible() && expanded && revealAmount === 100;
      syncMouse();
    });
    if (edition === "local") {
      ctx.registerIpc("notification-open", async target => {
        ctx.signal.throwIfAborted();
        if (demo || !notifications.contains(target)) return;
        await ctx.deps.windowNavigation.open({ target: "chat", session: "existing", sessionId: target.sessionId });
        acknowledge(target);
      });
      ctx.registerIpc("list-sessions", mode => ctx.deps.windowNavigation.listSessions(mode));
      ctx.registerIpc("open-target", () => {
        ctx.signal.throwIfAborted();
        if (demo || config.avatarTarget === "none") return { sessionId: null };
        return ctx.deps.windowNavigation.open({ target: config.avatarTarget, session: config.avatarSession, sessionId: config.avatarSessionId });
      });
    }
    ctx.registerIpc("save", value => {
      ctx.signal.throwIfAborted();
      const next = normalizeSettings(value);
      stopDemo();
      ctx.storage.set("settings", next); config = next; apply(); return state();
    });
    ctx.registerIpc("preview", () => { ctx.signal.throwIfAborted(); stopDemo(); reveal(); hideAt = Date.now() + config.displayDuration * 1000; });
    hud = new BrowserWindow({ title: "Cyrene HUD", width: 440, height: 160, show: false, transparent: true, backgroundColor: "#00000000", frame: false, resizable: false, hasShadow: false, skipTaskbar: true, focusable: false, webPreferences: { ...preferences, partition: "cyrene-hud-overlay" } });
    lockNavigation(hud);
    hud.on("hide", () => { if (stopped || hud.isDestroyed()) return; avatarHovered = false; clearInterval(animation); animation = undefined; amounts = {}; transitions = {}; active = candidate = null; leaveSince = null; lastPointer = undefined; expanded = false; revealAmount = config.mode === "persistent" ? 100 : 0; revealTransition = null; if (rest) paintLayout(); syncMouse(); glass.sync(); hud.webContents.send("plugin:cyrene-hud:visibility", false); });
    await hud.loadFile(path.join(__dirname, "hud.html"));
    ctx.signal.throwIfAborted(); ready = true; apply();
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(event, apply);
    timer = setInterval(tick, 50);
    openSettings = async () => {
      ctx.signal.throwIfAborted();
      if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
      panel = new BrowserWindow({ title: "昔涟 · 桌面状态", width: 540, height: 860, minWidth: 480, minHeight: 650, show: false, autoHideMenuBar: true, backgroundColor: "#faf4f8", webPreferences: { ...preferences, partition: "cyrene-hud-settings" } });
      const current = panel;
      lockNavigation(current);
      current.on("closed", () => { if (panel === current) panel = undefined; if (!stopped) stopDemo(); });
      await current.loadFile(path.join(__dirname, "settings.html"));
      if (!stopped && !current.isDestroyed()) current.show();
    };
  },
  open() { return openSettings?.(); },
};

