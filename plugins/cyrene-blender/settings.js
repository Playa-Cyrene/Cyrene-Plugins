(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const bridge = window.CyrenePanel;
  const activeStatuses = new Set(["queued", "pending", "assigned", "running", "starting", "rendering", "processing", "in_progress"]);
  const statusLabels = { queued: "排队中", pending: "等待中", assigned: "分派中", running: "渲染中", starting: "启动中", rendering: "渲染中", processing: "处理中", in_progress: "进行中", completed: "已完成", complete: "已完成", success: "已完成", succeeded: "已完成", finished: "已完成", failed: "失败", error: "失败", cancelled: "已取消", canceled: "已取消", cancelling: "正在取消", cancel_requested: "等待取消" };
  const configIds = ["node-path", "blender-path", "gateway-port", "output-dir"];
  const actionIds = ["start-gateway", "stop-gateway", "refresh", "save-config", "inspect-scene", "capture-preview", "submit-render"];
  let state = null;
  let selectedInstanceId = "";
  let configDirty = false;
  let busy = false;
  let started = false;
  let disposed = false;
  let pollTimer = 0;
  let stateRequest = null;
  let previewSource = "";
  const cancellingJobs = new Set();

  function text(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
  }

  function errorMessage(error) {
    return (error instanceof Error ? error.message : text(error, "操作失败，请刷新诊断后重试。")).slice(0, 1500);
  }

  function setText(id, value) { byId(id).textContent = text(value); }

  function log(message, isError = false) {
    const row = document.createElement("li");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const detail = document.createElement("span");
    detail.textContent = text(message).slice(0, 1500);
    if (isError) detail.className = "log-error";
    row.append(time, detail);
    const list = byId("operation-log");
    list.prepend(row);
    while (list.childElementCount > 30) list.lastElementChild.remove();
    setText("log-count", list.childElementCount);
  }

  function showError(error) {
    const message = errorMessage(error);
    setText("error-message", message);
    byId("error-message").hidden = false;
    log(message, true);
  }

  function clearError() { byId("error-message").hidden = true; }

  async function invoke(channel, ...args) {
    if (!bridge || typeof bridge.invoke !== "function") throw new Error("请从 Cyrene 的插件设置中打开此面板。");
    const timeoutMs = channel === "capture-preview" ? 90000 : channel === "start-gateway" ? 60000 : 30000;
    let timer;
    try {
      return await Promise.race([
        bridge.invoke(channel, ...args),
        new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error("请求等待超时。操作可能仍在进行，请先刷新诊断确认结果，避免重复提交。")), timeoutMs); }),
      ]);
    } finally { window.clearTimeout(timer); }
  }

  function instanceId(instance) { return text(instance.instanceId ?? instance.id ?? instance.instance_id); }
  function instanceName(instance) { return text(instance.name ?? instance.displayName ?? instance.display_name ?? instance.blendFile ?? instance.blend_file, "Blender") + " · " + instanceId(instance); }
  function jobId(job) { return text(job.id ?? job.jobId ?? job.job_id); }
  function jobStatus(job) { return text(job.status ?? job.state, "unknown").toLowerCase(); }
  function isState(value) { return value && typeof value === "object" && value.config && value.gateway; }

  function renderControls() {
    const gateway = state?.gateway || {};
    const instances = Array.isArray(state?.instances) ? state.instances : [];
    const readyInstances = instances.filter((item) => item.ready === true || item.status === "ready");
    const canOperate = Boolean(gateway.running && readyInstances.length === 1 && selectedInstanceId && instanceId(readyInstances[0]) === selectedInstanceId);
    actionIds.forEach((id) => { byId(id).disabled = busy || !bridge; });
    byId("start-gateway").disabled = busy || !state || Boolean(gateway.running);
    byId("stop-gateway").disabled = busy || !gateway.running || !gateway.owned;
    byId("save-config").disabled = busy || !state || !configDirty || Boolean(gateway.running);
    if (configDirty) setText("config-hint", gateway.running ? "有未保存的修改，请先停止网关再保存。" : "有未保存的修改。");
    ["inspect-scene", "capture-preview", "submit-render"].forEach((id) => { byId(id).disabled = busy || !canOperate; });
    byId("instance-select").disabled = busy || !gateway.running || instances.length === 0;
    configIds.forEach((id) => { byId(id).disabled = busy; });
    byId("panel").setAttribute("aria-busy", String(busy));
  }

  function renderConfig(config) {
    if (configDirty) return;
    byId("node-path").value = text(config.nodePath);
    byId("blender-path").value = text(config.blenderPath);
    byId("gateway-port").value = text(config.port, "39878");
    byId("output-dir").value = text(config.outputDir);
  }

  function renderGateway(gateway) {
    const status = byId("gateway-status");
    status.textContent = gateway.error ? "连接需检查" : gateway.running ? "网关已连接" : "网关未启动";
    status.dataset.tone = gateway.error ? "error" : gateway.running ? "success" : "neutral";
    setText("gateway-detail", text(gateway.error) || (gateway.running ? (gateway.owned ? "由本插件管理" : "已连接外部网关") : "先保存配置，再启动网关"));
    byId("gateway-detail").dataset.tone = gateway.error ? "error" : "neutral";
    setText("ownership-note", gateway.running && !gateway.owned ? "当前网关由其他程序启动，本插件不会将其停止。" : "本面板只停止由当前插件启动的网关。");
    byId("stop-gateway").title = gateway.running && !gateway.owned ? "不能停止由其他程序启动的网关" : "停止本插件启动的网关";
  }

  function renderInstances(instances, incoming) {
    const explicit = text(incoming.selectedInstanceId ?? incoming.config?.instanceId ?? incoming.selectedInstance?.id);
    const ids = new Set(instances.map(instanceId));
    if (explicit && ids.has(explicit)) selectedInstanceId = explicit;
    if (!ids.has(selectedInstanceId)) selectedInstanceId = "";
    const select = byId("instance-select");
    const options = [];
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = instances.length ? "请选择 Blender 实例" : "暂无可用实例";
    options.push(blank);
    for (const instance of instances) {
      const id = instanceId(instance);
      if (!id) continue;
      const option = document.createElement("option");
      option.value = id;
      option.textContent = instanceName(instance);
      options.push(option);
    }
    select.replaceChildren(...options);
    select.value = selectedInstanceId;
    setText("instance-hint", instances.length ? "已发现 " + instances.length + " 个实例，场景操作只发送给所选实例。" : "打开 Blender 并启用桥接插件后，点击刷新诊断。");
  }

  function renderScene() {
    const scene = state?.scene;
    const rawObjects = Array.isArray(scene?.objects) ? scene.objects : Array.isArray(scene) ? scene : [];
    const objects = rawObjects.filter((object) => typeof object === "string" || (object && typeof object === "object"));
    const query = byId("object-filter").value.trim().toLocaleLowerCase();
    const filtered = objects.filter((object) => text(typeof object === "string" ? object : object.name).toLocaleLowerCase().includes(query));
    const nodes = filtered.slice(0, 300).map((object) => {
      const item = document.createElement("li");
      item.className = "object-item";
      const name = document.createElement("span");
      name.className = "object-name";
      name.textContent = text(typeof object === "string" ? object : object.name, "未命名对象");
      name.title = name.textContent;
      const type = document.createElement("span");
      type.className = "object-type";
      type.textContent = text(object.type ?? object.objectType);
      item.append(name, type);
      return item;
    });
    byId("object-list").replaceChildren(...nodes);
    byId("scene-empty").hidden = nodes.length > 0;
    setText("scene-empty", scene ? (query ? "没有匹配的对象。" : "场景中没有可显示的对象。") : "选择实例后读取场景。");
    const total = Number.isInteger(scene?.object_count) ? scene.object_count : objects.length;
    setText("object-count", scene ? (query ? filtered.length + " / " + objects.length : total + " 个对象") + (scene.truncated ? "，已读取 " + objects.length + " 个" : "") + (filtered.length > 300 ? "，显示前 300 个" : "") : "尚未读取");
    const file = text(scene?.filePath ?? scene?.filepath ?? scene?.blendFile);
    byId("scene-file").hidden = !file;
    setText("scene-file", file);
  }

  function previewUrl(preview) {
    const candidate = text(typeof preview === "string" ? preview : preview?.dataUrl ?? preview?.data_url ?? preview?.url);
    if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/i.test(candidate)) return candidate;
    if (!candidate) return "";
    try {
      const url = new URL(candidate, window.location.href);
      if (url.protocol === "cyrene-plugin:" && url.host === "cyrene-blender") return url.href;
    } catch (_) { /* 文件路径只作为文字展示，不能作为面板可执行资源。 */ }
    return "";
  }

  function renderPreview() {
    const preview = state?.preview;
    const source = previewUrl(preview);
    const image = byId("preview-image");
    if (source !== previewSource) {
      previewSource = source;
      if (source) image.src = source;
      else image.removeAttribute("src");
    }
    image.hidden = !source;
    byId("preview-empty").hidden = Boolean(source);
    setText("preview-empty", preview ? "截图已返回，暂无可显示的预览图。" : "获取截图后在这里预览。");
    const path = text(preview?.filePath ?? preview?.path);
    byId("preview-path").hidden = !path;
    setText("preview-path", path);
    const at = preview?.capturedAt ?? preview?.timestamp;
    const date = at ? new Date(at) : null;
    setText("preview-time", date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour12: false }) : "");
  }

  function renderJobs(jobs) {
    setText("job-count", jobs.filter((job) => activeStatuses.has(jobStatus(job))).length);
    byId("jobs-empty").hidden = jobs.length > 0;
    const nodes = jobs.slice(0, 30).map((job) => {
      const id = jobId(job), status = jobStatus(job);
      const card = document.createElement("article");
      card.className = "job-card";
      const top = document.createElement("div");
      top.className = "job-top";
      const title = document.createElement("span");
      title.className = "job-title";
      const kind = job.renderKind ?? job.kind;
      title.textContent = kind === "animation" || (kind !== "still" && job.frameEnd > job.frameStart) ? "动画渲染" : "单帧渲染";
      const label = document.createElement("span");
      label.className = "job-state";
      label.textContent = statusLabels[status] || "状态待确认";
      label.dataset.tone = ["failed", "error"].includes(status) ? "error" : ["completed", "complete", "success", "succeeded", "finished"].includes(status) ? "success" : "neutral";
      top.append(title, label);
      if (id && activeStatuses.has(status)) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "job-cancel";
        cancel.textContent = cancellingJobs.has(id) ? "正在请求取消" : "取消任务";
        cancel.disabled = cancellingJobs.has(id);
        cancel.setAttribute("aria-label", "取消渲染任务 " + id);
        cancel.addEventListener("click", () => cancelJob(id));
        top.append(cancel);
      }
      card.append(top);
      const meta = document.createElement("p");
      meta.className = "job-meta";
      const parts = [id || "任务编号待确认"];
      if (Number.isFinite(job.frameStart) && Number.isFinite(job.frameEnd)) parts.push("帧 " + job.frameStart + "–" + job.frameEnd);
      if (Number.isFinite(job.currentFrame)) parts.push("当前帧 " + job.currentFrame);
      meta.textContent = parts.join(" · ");
      card.append(meta);
      const rawProgress = typeof job.percentage === "number" ? job.percentage : typeof job.progress === "number" ? (job.progress <= 1 ? job.progress * 100 : job.progress) : null;
      if (rawProgress !== null && Number.isFinite(rawProgress)) {
        const progress = document.createElement("progress");
        progress.max = 100;
        progress.value = Math.max(0, Math.min(100, rawProgress));
        progress.setAttribute("aria-label", "渲染进度 " + Math.round(progress.value) + "%");
        card.append(progress);
      }
      const error = text(job.error?.message ?? job.error ?? job.message);
      if (error) {
        const detail = document.createElement("p");
        detail.className = ["failed", "error"].includes(status) ? "job-error" : "job-meta";
        detail.textContent = error.slice(0, 1500);
        card.append(detail);
      }
      const output = text(job.outputPath ?? job.outputDir ?? job.filePath);
      if (output) {
        const path = document.createElement("p");
        path.className = "file-path";
        path.textContent = output;
        card.append(path);
      }
      return card;
    });
    byId("job-list").replaceChildren(...nodes);
    setText("jobs-updated", "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
  }

  function render(next) {
    if (!isState(next)) throw new Error("插件返回的状态格式不完整，请刷新诊断。");
    state = next;
    renderConfig(next.config);
    renderGateway(next.gateway);
    renderInstances(Array.isArray(next.instances) ? next.instances : [], next);
    renderScene();
    renderPreview();
    renderJobs(Array.isArray(next.jobs) ? next.jobs : []);
    renderControls();
    bridge?.ready?.();
  }

  async function readState(refresh = false) {
    if (stateRequest) return stateRequest;
    stateRequest = (async () => {
      let next = await invoke(refresh ? "refresh" : "get-state");
      if (!isState(next) && refresh) next = await invoke("get-state");
      if (!disposed) render(next);
      return next;
    })();
    try { return await stateRequest; } finally { stateRequest = null; }
  }

  async function action(label, operation) {
    if (busy) return;
    busy = true;
    clearError();
    setText("feedback", label + "…");
    renderControls();
    try {
      // 等待先前的轮询结束，避免旧快照覆盖刚保存的配置或实例选择。
      if (stateRequest) await stateRequest.catch(() => {});
      await operation();
      await readState();
      setText("feedback", label + "完成");
      log(label + "完成");
    } catch (error) {
      setText("feedback", "操作未完成");
      showError(error);
    } finally { busy = false; renderControls(); }
  }

  function numberField(id, min, max, label) {
    const value = Number(byId(id).value);
    if (!byId(id).value.trim() || !Number.isInteger(value) || value < min || value > max) throw new Error(label + "必须是 " + min + " 到 " + max + " 之间的整数。");
    return value;
  }

  async function cancelJob(id) {
    if (cancellingJobs.has(id)) return;
    cancellingJobs.add(id);
    renderJobs(Array.isArray(state?.jobs) ? state.jobs : []);
    clearError();
    try {
      await invoke("cancel-job", { id });
      log("已发送取消请求：" + id);
      setText("feedback", "已发送取消请求，等待任务状态更新。");
      await readState(true);
    } catch (error) { showError(error); }
    finally { cancellingJobs.delete(id); renderJobs(Array.isArray(state?.jobs) ? state.jobs : []); }
  }

  function setTab(name, focus = false) {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      byId("view-" + button.dataset.tab).hidden = !active;
      if (active && focus) button.focus();
    });
    bridge?.ready?.();
  }

  function renderKind() {
    const animation = byId("render-kind").value === "animation";
    document.querySelectorAll(".animation-field").forEach((field) => {
      field.hidden = !animation;
      field.querySelector("input").disabled = !animation;
    });
    setText("submit-render", animation ? "提交动画渲染" : "渲染当前帧");
    const start = Number(byId("frame-start").value), end = Number(byId("frame-end").value), fps = Number(byId("render-fps").value);
    setText("render-hint", animation && fps > 0 && end >= start ? "共 " + (end - start + 1) + " 帧，约 " + ((end - start + 1) / fps).toFixed(2) + " 秒。输出 PNG 序列，每个任务最多 3600 帧。" : "使用当前场景的相机和渲染设置。");
    bridge?.ready?.();
  }

  byId("config-form").addEventListener("input", () => {
    configDirty = true;
    setText("config-hint", state?.gateway?.running ? "有未保存的修改，请先停止网关再保存。" : "有未保存的修改。");
    renderControls();
  });
  byId("config-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let config;
    try {
      config = { nodePath: byId("node-path").value.trim(), blenderPath: byId("blender-path").value.trim(), port: numberField("gateway-port", 1024, 65535, "网关端口"), outputDir: byId("output-dir").value.trim() };
    } catch (error) { showError(error); return; }
    void action("保存配置", async () => {
      await invoke("save-config", config);
      configDirty = false;
      setText("config-hint", "配置已保存，可以启动网关。");
    });
  });
  byId("start-gateway").addEventListener("click", () => {
    if (configDirty) { showError(new Error("请先保存配置，再启动网关。")); return; }
    void action("启动网关", () => invoke("start-gateway"));
  });
  byId("stop-gateway").addEventListener("click", () => { void action("停止网关", () => invoke("stop-gateway")); });
  byId("refresh").addEventListener("click", () => { void action("刷新诊断", () => readState(true)); });
  byId("instance-select").addEventListener("change", () => {
    const id = byId("instance-select").value;
    if (!id) { byId("instance-select").value = selectedInstanceId; return; }
    void action("选择 Blender 实例", async () => {
      try {
        await invoke("select-instance", { instanceId: id });
        selectedInstanceId = id;
      } catch (error) {
        byId("instance-select").value = selectedInstanceId;
        throw error;
      }
    });
  });
  byId("inspect-scene").addEventListener("click", () => { void action("读取场景", () => invoke("inspect-scene")); });
  byId("capture-preview").addEventListener("click", () => { void action("获取视口截图", () => invoke("capture-preview")); });
  byId("object-filter").addEventListener("input", renderScene);
  byId("preview-image").addEventListener("error", () => {
    byId("preview-image").hidden = true;
    byId("preview-empty").hidden = false;
    setText("preview-empty", "预览图片无法显示，请重新获取截图。");
  });
  byId("render-kind").addEventListener("change", renderKind);
  ["frame-start", "frame-end", "render-fps"].forEach((id) => byId(id).addEventListener("input", renderKind));
  byId("render-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let request;
    try {
      request = { kind: byId("render-kind").value, resolutionPercentage: numberField("resolution", 1, 100, "分辨率比例") };
      if (request.kind === "animation") {
        request.frameStart = numberField("frame-start", 0, 100000, "开始帧");
        request.frameEnd = numberField("frame-end", 0, 100000, "结束帧");
        request.fps = numberField("render-fps", 1, 120, "每秒帧数");
        if (request.frameEnd < request.frameStart) throw new Error("结束帧不能小于开始帧。");
        if (request.frameEnd - request.frameStart + 1 > 3600) throw new Error("每个动画任务最多渲染 3600 帧，请缩短帧范围。");
      }
    } catch (error) { showError(error); return; }
    void action("提交渲染任务", () => invoke("submit-render", request));
  });
  const tabs = Array.from(document.querySelectorAll("[data-tab]"));
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      setTab(tabs[next].dataset.tab, true);
    });
  });

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    if (disposed) return;
    const active = (Array.isArray(state?.jobs) ? state.jobs : []).some((job) => activeStatuses.has(jobStatus(job)));
    pollTimer = window.setTimeout(async () => {
      if (!busy && document.visibilityState !== "hidden") {
        try { await readState(Boolean(state?.gateway?.running)); }
        catch (error) { setText("feedback", "自动更新暂不可用，请点击刷新诊断。"); }
      }
      schedulePoll();
    }, active ? 3000 : 8000);
  }

  async function start() {
    if (started || disposed) return;
    started = true;
    try { await readState(); setText("feedback", "状态已更新"); }
    catch (error) { showError(error); setText("feedback", "未能读取插件状态"); }
    finally { renderControls(); schedulePoll(); }
  }

  if (bridge?.onTheme) bridge.onTheme(() => { void start(); });
  window.addEventListener("load", () => { window.setTimeout(() => { void start(); }, 150); });
  window.addEventListener("pagehide", () => { disposed = true; window.clearTimeout(pollTimer); });
  renderKind();
})();
