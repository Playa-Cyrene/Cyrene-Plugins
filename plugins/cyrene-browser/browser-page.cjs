"use strict";

function snapshotInPage(options) {
  const maxElements = options.maxElements;
  const maxText = options.maxText;
  const includeOffscreen = options.scope === "document";
  const normalize = (value, limit = 180) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  let tracker = globalThis.__cyreneBrowserTrackerV2;
  if (!tracker || !(tracker.observedRoots instanceof WeakSet)) {
    tracker = {
      domRevision: 0,
      snapshotSerial: 0,
      snapshotToken: "",
      refs: new Map(),
      observedRoots: new WeakSet(),
      observer: null,
    };
    globalThis.__cyreneBrowserTrackerV2 = tracker;
  }
  if (!tracker.observer) {
    tracker.observer = new MutationObserver(() => { tracker.domRevision += 1; });
  }

  const observeRoot = (root) => {
    if (!root || tracker.observedRoots.has(root)) return;
    try {
      tracker.observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      tracker.observedRoots.add(root);
    } catch {
      // Some detached frame documents cannot be observed while navigating.
    }
  };

  const topRect = (element, frameChain) => {
    const local = element.getBoundingClientRect();
    let left = local.left;
    let top = local.top;
    let width = local.width;
    let height = local.height;
    for (let index = frameChain.length - 1; index >= 0; index -= 1) {
      const frameElement = frameChain[index];
      const frameRect = frameElement.getBoundingClientRect();
      const scaleX = frameRect.width / (frameElement.offsetWidth || frameRect.width || 1);
      const scaleY = frameRect.height / (frameElement.offsetHeight || frameRect.height || 1);
      left = frameRect.left + ((frameElement.clientLeft || 0) + left) * scaleX;
      top = frameRect.top + ((frameElement.clientTop || 0) + top) * scaleY;
      width *= scaleX;
      height *= scaleY;
    }
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    };
  };

  const visibleRect = (element, frameChain = [], allowOffscreen = false) => {
    if (!element || element.nodeType !== 1 || !element.isConnected) return null;
    const localWindow = element.ownerDocument?.defaultView;
    if (!localWindow) return null;
    const style = localWindow.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    const localRect = element.getBoundingClientRect();
    if (localRect.width <= 0 || localRect.height <= 0) return null;
    if (!allowOffscreen
      && (localRect.bottom < 0 || localRect.right < 0 || localRect.top > localWindow.innerHeight || localRect.left > localWindow.innerWidth)) return null;
    for (const frameElement of frameChain) {
      if (!frameElement?.isConnected) return null;
      const frameWindow = frameElement.ownerDocument?.defaultView;
      const frameStyle = frameWindow?.getComputedStyle(frameElement);
      const frameRect = frameElement.getBoundingClientRect();
      if (!frameStyle || frameStyle.display === "none" || frameStyle.visibility === "hidden" || frameRect.width <= 0 || frameRect.height <= 0) return null;
    }
    const rect = topRect(element, frameChain);
    if (!allowOffscreen
      && (rect.bottom < 0 || rect.right < 0 || rect.top > viewport.height || rect.left > viewport.width)) return null;
    return rect;
  };

  const labelFor = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ownerDocument = element.ownerDocument || document;
      const text = labelledBy.split(/\s+/).map((id) => ownerDocument.getElementById(id)?.textContent || "").join(" ");
      if (normalize(text)) return normalize(text);
    }
    const direct = element.getAttribute("aria-label")
      || element.getAttribute("alt")
      || element.getAttribute("title")
      || element.getAttribute("placeholder");
    if (normalize(direct)) return normalize(direct);
    if (element.labels?.length) {
      const text = Array.from(element.labels).map((label) => label.innerText || label.textContent || "").join(" ");
      if (normalize(text)) return normalize(text);
    }
    return normalize(element.innerText || element.textContent || element.getAttribute("name") || "");
  };

  const roleFor = (element) => {
    const explicit = normalize(element.getAttribute("role"), 40);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || type === "button" || type === "submit" || type === "reset") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "interactive";
  };

  const selector = [
    "a[href]", "button", "input:not([type='hidden'])", "textarea", "select", "summary",
    "[contenteditable='true']", "[role]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const refs = new Map();
  const interactive = [];
  const seen = new Set();
  const frames = [];
  const contexts = [{ root: document, frameChain: [], frame: "main" }];
  let shadowRoots = 0;
  let scannedElements = 0;

  for (let contextIndex = 0; contextIndex < contexts.length && contextIndex < 48; contextIndex += 1) {
    const context = contexts[contextIndex];
    const root = context.root;
    observeRoot(root);

    let candidates = [];
    try { candidates = Array.from(root.querySelectorAll(selector)); } catch { candidates = []; }
    for (const element of candidates) {
      if (interactive.length >= maxElements || seen.has(element)) continue;
      seen.add(element);
      const rect = visibleRect(element, context.frameChain, includeOffscreen);
      if (!rect) continue;
      const ref = `e${interactive.length + 1}`;
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      const password = tag === "input" && type === "password";
      let value = "";
      if (!password && (tag === "input" || tag === "textarea" || tag === "select")) {
        value = normalize(element.value, 120);
      }
      refs.set(ref, { element, frameChain: context.frameChain, frame: context.frame });
      interactive.push({
        ref,
        role: roleFor(element),
        name: labelFor(element),
        value,
        password,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        checked: typeof element.checked === "boolean" ? element.checked : undefined,
        href: tag === "a" ? normalize(element.href, 300) : "",
        frame: context.frame,
        offscreen: rect.bottom < 0 || rect.right < 0 || rect.top > viewport.height || rect.left > viewport.width,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        options: tag === "select"
          ? Array.from(element.options || []).slice(0, 30).map((option) => ({
            value: normalize(option.value, 120),
            label: normalize(option.label || option.textContent, 120),
            selected: Boolean(option.selected),
          }))
          : undefined,
      });
    }

    let allElements = [];
    try { allElements = Array.from(root.querySelectorAll("*")); } catch { allElements = []; }
    let frameNumber = 0;
    for (const element of allElements) {
      scannedElements += 1;
      if (scannedElements > 20_000) break;
      if (element.shadowRoot) {
        shadowRoots += 1;
        contexts.push({ root: element.shadowRoot, frameChain: context.frameChain, frame: context.frame });
      }
      const tag = element.tagName?.toLowerCase();
      if (tag !== "iframe" && tag !== "frame") continue;
      frameNumber += 1;
      const frame = `${context.frame}/iframe[${frameNumber}]`;
      const frameUrl = normalize(element.src || element.getAttribute("src") || "about:blank", 500);
      try {
        const childDocument = element.contentDocument;
        if (!childDocument?.documentElement) throw new Error("frame document unavailable");
        frames.push({ frame, url: frameUrl, accessible: true });
        contexts.push({
          root: childDocument,
          frameChain: [...context.frameChain, element],
          frame,
        });
      } catch {
        frames.push({ frame, url: frameUrl, accessible: false });
      }
    }
  }

  const textParts = [];
  let textLength = 0;
  let visited = 0;
  for (const context of contexts) {
    if (visited >= 8000 || textLength >= maxText) break;
    const root = context.root?.nodeType === 9
      ? (context.root.body || context.root.documentElement)
      : context.root;
    if (!root) continue;
    const ownerDocument = root.ownerDocument || context.root;
    const walker = ownerDocument.createTreeWalker(root, 4);
    let node;
    while ((node = walker.nextNode()) && visited < 8000 && textLength < maxText) {
      visited += 1;
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) continue;
      if (!visibleRect(parent, context.frameChain)) continue;
      const text = normalize(node.nodeValue, 500);
      if (!text) continue;
      textParts.push(text);
      textLength += text.length + 1;
    }
  }

  const snapshotToken = `${Date.now().toString(36)}-${(++tracker.snapshotSerial).toString(36)}`;
  tracker.refs = refs;
  tracker.snapshotToken = snapshotToken;
  tracker.snapshotAt = Date.now();

  return {
    title: document.title,
    url: location.href,
    interactive,
    text: textParts.join("\n").slice(0, maxText),
    frames,
    shadowRoots,
    scope: includeOffscreen ? "document" : "viewport",
    domRevision: tracker.domRevision,
    snapshotToken,
    viewport: {
      width: viewport.width,
      height: viewport.height,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      documentWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
      documentHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
    },
    capturedAt: tracker.snapshotAt,
  };
}

function locateRefInPage(ref, purpose, snapshotToken, snapshotDomRevision) {
  return (async () => {
    const tracker = globalThis.__cyreneBrowserTrackerV2;
    const refs = tracker?.refs;
    if (!(refs instanceof Map)) return { ok: false, error: "请先获取新的页面快照" };
    if (snapshotToken && tracker.snapshotToken !== snapshotToken) {
      return { ok: false, error: "页面版本与当前快照不一致，请重新获取页面快照" };
    }
    if (Number.isFinite(snapshotDomRevision) && tracker.domRevision !== snapshotDomRevision) {
      return { ok: false, error: "页面 DOM 已在快照后发生变化，请重新获取页面快照" };
    }
    const record = refs.get(ref);
    const element = record?.element || record;
    const frameChain = Array.isArray(record?.frameChain) ? record.frameChain : [];
    if (!element || element.nodeType !== 1 || !element.isConnected) {
      return { ok: false, error: "元素引用已失效，请重新获取页面快照" };
    }
    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "元素当前不可用" };
    }
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const password = tag === "input" && type === "password";
    const editable = element.isContentEditable
      || tag === "textarea"
      || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image", "range", "color"].includes(type));
    if (purpose === "fill" && password) return { ok: false, error: "密码框必须由用户手动填写" };
    if (purpose === "fill" && !editable) return { ok: false, error: "该元素不是可填写的文本控件" };
    if (purpose === "fill" && (element.readOnly || element.getAttribute("aria-readonly") === "true")) {
      return { ok: false, error: "该文本控件是只读的" };
    }

    for (const frameElement of frameChain) {
      frameElement.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await new Promise((resolve) => {
      let finished = false;
      let fallbackTimer;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallbackTimer);
        resolve();
      };
      fallbackTimer = setTimeout(finish, 120);
      requestAnimationFrame(finish);
    });
    if (Number.isFinite(snapshotDomRevision) && tracker.domRevision !== snapshotDomRevision) {
      return { ok: false, error: "页面 DOM 在定位元素时发生变化，请重新获取页面快照" };
    }
    if (purpose === "fill") {
      try { element.focus({ preventScroll: true }); } catch { element.focus(); }
    }
    const rect = element.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    for (let index = frameChain.length - 1; index >= 0; index -= 1) {
      const frameElement = frameChain[index];
      const frameRect = frameElement.getBoundingClientRect();
      const scaleX = frameRect.width / (frameElement.offsetWidth || frameRect.width || 1);
      const scaleY = frameRect.height / (frameElement.offsetHeight || frameRect.height || 1);
      x = frameRect.left + ((frameElement.clientLeft || 0) + x) * scaleX;
      y = frameRect.top + ((frameElement.clientTop || 0) + y) * scaleY;
    }
    x = Math.round(x);
    y = Math.round(y);
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
      return { ok: false, error: "元素当前不在可操作区域" };
    }
    const localX = Math.round(rect.left + rect.width / 2);
    const localY = Math.round(rect.top + rect.height / 2);
    const rootNode = element.getRootNode?.();
    const pointRoot = rootNode && typeof rootNode.elementFromPoint === "function"
      ? rootNode
      : element.ownerDocument;
    const top = pointRoot?.elementFromPoint(localX, localY);
    const shadowHost = rootNode?.host;
    if (top && top !== element && top !== shadowHost && !element.contains(top) && !top.contains(element)) {
      return { ok: false, error: "元素被其他内容遮挡，请重新获取页面快照" };
    }
    return {
      ok: true,
      x,
      y,
      tag,
      type,
      editable,
      password,
      checked: typeof element.checked === "boolean" ? element.checked : undefined,
      value: password ? "" : String(element.value ?? "").slice(0, 1000),
      frame: record?.frame || "main",
      snapshotToken: tracker.snapshotToken,
      name: String(element.getAttribute("aria-label") || element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    };
  })();
}

function pageSignalInPage() {
  let tracker = globalThis.__cyreneBrowserTrackerV2;
  if (!tracker || !(tracker.observedRoots instanceof WeakSet)) {
    tracker = {
      domRevision: 0,
      snapshotSerial: 0,
      snapshotToken: "",
      refs: new Map(),
      observedRoots: new WeakSet(),
      observer: null,
    };
    globalThis.__cyreneBrowserTrackerV2 = tracker;
  }
  if (!tracker.observer) {
    tracker.observer = new MutationObserver(() => { tracker.domRevision += 1; });
  }
  if (!tracker.observedRoots.has(document)) {
    try {
      tracker.observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      tracker.observedRoots.add(document);
    } catch {
      // The document can be between navigation commits.
    }
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    domRevision: tracker.domRevision,
    snapshotToken: tracker.snapshotToken,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
  };
}

function waitConditionInPage(condition, value) {
  const normalize = (input, limit = 1000) => String(input ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  if (condition === "url") {
    return { matched: location.href.includes(value), summary: location.href, url: location.href };
  }
  if (condition === "load") {
    return {
      matched: document.readyState === "complete",
      summary: document.readyState,
      url: location.href,
    };
  }

  const roots = [document];
  const visible = (element) => {
    if (!element || element.nodeType !== 1 || !element.isConnected) return false;
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow) return false;
    const style = ownerWindow.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  let firstMatch = "";
  let found = false;
  let scanned = 0;

  for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 48; rootIndex += 1) {
    const root = roots[rootIndex];
    if (condition === "selector" || condition === "hidden") {
      let matches;
      try { matches = root.querySelectorAll(value); } catch {
        return { matched: false, error: "无效的 CSS 选择器", url: location.href };
      }
      for (const element of matches) {
        if (!visible(element)) continue;
        found = true;
        firstMatch = normalize(element.getAttribute?.("aria-label") || element.innerText || element.textContent || element.tagName, 180);
        break;
      }
    } else if (condition === "text") {
      const textRoot = root.nodeType === 9 ? (root.body || root.documentElement) : root;
      const text = normalize(textRoot?.innerText || textRoot?.textContent || "", 200_000);
      if (text.includes(value)) {
        found = true;
        firstMatch = value;
      }
    }
    if (found && condition !== "hidden") break;

    let elements = [];
    try { elements = Array.from(root.querySelectorAll("*")); } catch { elements = []; }
    for (const element of elements) {
      scanned += 1;
      if (scanned > 20_000) break;
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const tag = element.tagName?.toLowerCase();
      if (tag !== "iframe" && tag !== "frame") continue;
      try {
        if (element.contentDocument?.documentElement) roots.push(element.contentDocument);
      } catch {
        // Cross-origin frames are intentionally not pierced from page script.
      }
    }
  }

  return {
    matched: condition === "hidden" ? !found : found,
    summary: firstMatch || (found ? "matched" : "not matched"),
    url: location.href,
  };
}

function selectRefInPage(ref, snapshotToken, snapshotDomRevision, desiredValue) {
  const tracker = globalThis.__cyreneBrowserTrackerV2;
  if (!(tracker?.refs instanceof Map)) return { ok: false, error: "请先获取新的页面快照" };
  if (snapshotToken && tracker.snapshotToken !== snapshotToken) {
    return { ok: false, error: "页面版本与当前快照不一致，请重新获取页面快照" };
  }
  if (Number.isFinite(snapshotDomRevision) && tracker.domRevision !== snapshotDomRevision) {
    return { ok: false, error: "页面 DOM 已在快照后发生变化，请重新获取页面快照" };
  }
  const record = tracker.refs.get(ref);
  const element = record?.element || record;
  if (!element || element.nodeType !== 1 || !element.isConnected) {
    return { ok: false, error: "元素引用已失效，请重新获取页面快照" };
  }
  if (element.tagName?.toLowerCase() !== "select") {
    return { ok: false, error: "该元素不是下拉选择框" };
  }
  if (element.disabled || element.getAttribute("aria-disabled") === "true") {
    return { ok: false, error: "元素当前不可用" };
  }
  const wanted = String(desiredValue ?? "");
  const option = Array.from(element.options || []).find((item) => (
    String(item.value) === wanted || String(item.label || item.textContent || "").trim() === wanted
  ));
  if (!option) return { ok: false, error: "下拉框中找不到指定的 value 或标签" };
  element.value = option.value;
  const EventConstructor = element.ownerDocument?.defaultView?.Event || Event;
  element.dispatchEvent(new EventConstructor("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new EventConstructor("change", { bubbles: true, composed: true }));
  tracker.domRevision += 1;
  return {
    ok: true,
    value: String(option.value),
    label: String(option.label || option.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
  };
}

function readRefStateInPage(ref, snapshotToken) {
  const tracker = globalThis.__cyreneBrowserTrackerV2;
  if (!(tracker?.refs instanceof Map)) return { ok: false, error: "请先获取新的页面快照" };
  if (snapshotToken && tracker.snapshotToken !== snapshotToken) {
    return { ok: false, error: "页面版本与当前快照不一致，请重新获取页面快照" };
  }
  const record = tracker.refs.get(ref);
  const element = record?.element || record;
  if (!element || element.nodeType !== 1 || !element.isConnected) {
    return { ok: false, error: "元素引用已失效" };
  }
  const tag = element.tagName?.toLowerCase() || "";
  const type = String(element.getAttribute?.("type") || "").toLowerCase();
  return {
    ok: true,
    tag,
    type,
    checked: typeof element.checked === "boolean" ? element.checked : undefined,
    value: type === "password" ? "" : String(element.value ?? "").slice(0, 1000),
    selectedLabel: tag === "select"
      ? String(element.selectedOptions?.[0]?.label || element.selectedOptions?.[0]?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180)
      : "",
  };
}

function scrollInPage(deltaX, deltaY) {
  window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    documentWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
    documentHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
  };
}

module.exports = Object.freeze({
  snapshotInPage,
  locateRefInPage,
  pageSignalInPage,
  waitConditionInPage,
  selectRefInPage,
  readRefStateInPage,
  scrollInPage,
});
