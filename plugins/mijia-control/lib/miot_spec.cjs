"use strict";
/**
 * MIoT-Spec 能力层 —— 自包含，纯 Node，无第三方依赖。
 *
 * 作用：给定设备 model，读出它「到底能做什么」，产出一份与 UI 无关的
 *   「控件描述符」（哪些开关 / 滑块 / 下拉 / 数值 / 文本 / 动作按钮）。
 *   面板据此自动渲染，不再靠「猜 siid=2/piid=1」。
 *
 * 数据源（小米官方公开的 MIoT-Spec 站点，Home Assistant / python-miio 同源）：
 *   1) model → urn： https://miot-spec.org/miot-spec-v2/instances?status=released （全量，约 1.9MB，一次拉取后缓存）
 *   2) urn  → spec： https://miot-spec.org/miot-spec-v2/instance?type=<urn>       （逐型号，按 urn 缓存）
 *
 * 缓存经宿主 ctx.storage 落盘（每键一个 <key>.json）：
 *   - 索引：键 "spec-index"（{fetchedAt, map:{model:urn}}），TTL 24h；
 *   - 单型号 spec：键 "spec-<sha1(urn)前16位>"（urn 含冒号不适合做文件名，故哈希）。
 * 仅依赖 node:crypto 与 Node 全局 fetch。任何网络失败都安全降级为「无 spec」。
 */

const crypto = require("node:crypto");

const INSTANCES_URL = "https://miot-spec.org/miot-spec-v2/instances?status=released";
const INSTANCE_URL = "https://miot-spec.org/miot-spec-v2/instance";
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

// ── 小工具 ────────────────────────────────────────────────────────
function urnName(urn, kind) {
  // urn:miot-spec-v2:property:brightness:0000000D:model:1 → "brightness"
  const parts = String(urn || "").split(":");
  const i = parts.indexOf(kind);
  return i >= 0 && parts[i + 1] ? parts[i + 1] : "";
}
function sha1short(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
}
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── 中文词典（MIoT-Spec 的属性/动作/枚举值/服务名都是英文）─────────
// 翻译发生在 extractControls 读取后，缓存里存的是原始 spec JSON，
// 因此词典更新不需要清缓存，重启即生效。
const ZH_PROP = {
  "on": "电源", "off": "关闭", "power": "电源",
  "mode": "模式", "fan-mode": "风扇模式", "air-conditioner-mode": "空调模式",
  "brightness": "亮度", "screen-brightness": "屏幕亮度",
  "color": "颜色", "color-temperature": "色温", "saturability": "饱和度", "flow": "情景灯效",
  "fan-level": "风速", "wind-level": "风速", "wind-speed": "风速", "speed-level": "速度档", "level": "档位", "speed": "速度",
  "temperature": "温度", "target-temperature": "目标温度", "current-temperature": "当前温度",
  "relative-humidity": "相对湿度", "humidity": "湿度", "target-humidity": "目标湿度",
  "pm2.5-density": "PM2.5 浓度", "tvoc-density": "TVOC 浓度", "co2-density": "CO₂ 浓度", "hcho-density": "甲醛浓度",
  "illumination": "光照度", "battery-level": "电量", "battery": "电量",
  "status": "状态", "fault": "故障", "alarm": "警报", "mute": "静音", "volume": "音量",
  "timer": "定时", "countdown": "倒计时", "time": "时间",
  "physical-controls-locked": "按键锁定", "child-lock": "童锁",
  "swing-mode": "摆风", "swing-left-right": "左右摆风", "swing-up-down": "上下摆风",
  "heater": "加热", "dry": "干燥", "ionizer": "负离子", "uv": "紫外线杀菌", "anion": "负离子",
  "motor-control": "电机控制", "target-position": "目标位置", "current-position": "当前位置", "position": "位置",
  "direction": "方向", "angle": "角度", "sweep": "清扫", "charge": "充电",
  "filter-life": "滤芯寿命", "filter-left-time": "滤芯剩余时间",
  "no-disturb": "勿扰模式", "do-not-disturb": "勿扰模式", "sleep-state": "睡眠状态",
  "charging-state": "充电状态", "device-wearing-status": "佩戴状态", "wearing-status": "佩戴状态",
  "steps": "步数", "heart-rate": "心率", "spo2": "血氧饱和度",
};
const ZH_ACTION = {
  "turn-on": "打开", "turn-off": "关闭", "toggle": "电源切换",
  "fan-speed-up": "风速 +", "fan-speed-down": "风速 -", "speed-up": "速率 +", "speed-down": "速率 -",
  "play": "播放", "pause": "暂停", "stop": "停止", "mute": "静音", "unmute": "取消静音",
  "reset": "重置", "reset-filter-life": "复位滤芯",
  "start-charge": "开始充电", "stop-charge": "停止充电",
  "start-sweep": "开始清扫", "stop-sweep": "停止清扫", "pause-sweep": "暂停清扫",
  "sweep-on": "开始清扫", "sweep-off": "结束清扫",
  "start-sport": "开始运动", "end-sport": "结束运动", "pause-sport": "暂停运动", "continue-sport": "继续运动",
  "measure-heatrate": "测量心率", "end-measure-heatrate": "结束心率测量", // spec 官方拼写就是 heatrate
  "measure-heartrate": "测量心率", "end-measure-heartrate": "结束心率测量",
  "measure-spo2": "测量血氧", "end-measure-spo2": "结束血氧测量",
  "measure-heart-rate": "测量心率", "end-measure-heart-rate": "结束心率测量",
  "vibration": "震动", "end-vibration": "结束震动", "start-voice-linkage": "开始语音联动", "end-voice-linkage": "结束语音联动",
};
const ZH_VALUE = {
  "idle": "待机", "auto": "自动", "manual": "手动", "normal": "标准",
  "silent": "静音", "low": "低风", "medium": "中风", "middle": "中风", "mid": "中风", "high": "高风", "higher": "高档", "lower": "低档",
  "strong": "强风", "turbo": "强劲", "fan": "送风", "natural": "自然风", "sleep": "睡眠", "baby": "柔和",
  "cool": "制冷", "heat": "制热", "dry": "除湿", "warm": "制热", "cooling": "制冷", "heating": "制热",
  "off": "关", "on": "开", "none": "无",
  "day": "日光", "daylight": "日光", "night": "夜间", "color": "彩色", "colour": "彩色", "warm-white": "暖白", "cold-white": "冷白", "white": "白光",
  "rainbow": "彩虹", "rgb": "彩色", "tv": "观影", "reading": "阅读", "computer": "办公", "hospitality": "会客", "entertainment": "娱乐", "wakeup": "唤醒",
};
const ZH_SVC = {
  "light": "灯光", "lamp": "灯", "fan": "风扇", "air-conditioner": "空调", "air-condition": "空调",
  "air-purifier": "空气净化器", "humidifier": "加湿器", "dehumidifier": "除湿机",
  "curtain": "窗帘", "cleaner": "扫地机", "vacuum": "扫地机", "environment": "环境", "illumination-sensor": "光照",
  "battery": "电源", "power": "电源", "alarm": "告警", "clock": "时钟", "player": "播放器", "speaker": "音箱", "tv": "电视",
  "temperature-sensor": "温度", "humidity-sensor": "湿度", "switch": "开关", "outlet": "插座", "plug": "插座", "ptc-bath-heater": "浴霸",
  "indicator-light": "指示灯", "usb": "USB", "physical-controls-locked": "按键锁", "scene": "场景",
};
function zhLookup(dict, word) {
  const key = String(word || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : "";
}
// 通用词级兑底：词典未命中的长标签拆成单词逐词翻译，全部命中才拼接；
// 保证新设备/冷门属性也能大概率得到中文，而非残留英文。
const ZH_WORD = {
  "set": "设置", "get": "读取", "read": "读取", "write": "写入", "query": "查询",
  "current": "当前", "target": "目标", "max": "最大", "min": "最小", "upper": "上", "lower": "下",
  "up": "上", "down": "下", "left": "左", "right": "右", "middle": "中", "center": "中",
  "temperature": "温度", "humidity": "湿度", "level": "档位", "speed": "速度", "step": "步进", "steps": "步数",
  "time": "时间", "timer": "定时", "delay": "延迟", "countdown": "倒计时", "duration": "时长",
  "status": "状态", "state": "状态", "error": "错误", "fault": "故障", "code": "代码", "value": "值",
  "battery": "电池", "charging": "充电", "charge": "充电", "full": "满", "empty": "空",
  "motor": "电机", "switch": "开关", "toggle": "切换", "open": "开", "close": "关",
  "start": "开始", "stop": "停止", "pause": "暂停", "resume": "继续", "exit": "退出", "enter": "进入",
  "display": "显示", "screen": "屏幕", "light": "灯光", "brightness": "亮度", "color": "颜色", "colour": "颜色",
  "white": "白光", "warm": "暖", "cold": "冷", "night": "夜间", "day": "日间", "sleep": "睡眠", "wake": "唤醒",
  "volume": "音量", "mute": "静音", "vibration": "震动", "alarm": "警报", "clock": "时钟",
  "hours": "小时", "minutes": "分钟", "seconds": "秒", "days": "天", "percent": "百分比", "percentage": "百分比",
  "density": "浓度", "concentration": "浓度", "purify": "净化", "sterilize": "杀菌", "dry": "干燥", "wet": "加湿",
  "heat": "制热", "cool": "制冷", "fan": "风扇", "wind": "风", "ion": "离子", "anion": "负离子", "uv": "紫外",
  "angle": "角度", "position": "位置", "direction": "方向", "oscillation": "摆动", "swing": "摆动", "rotation": "旋转",
  "sensitivity": "灵敏度", "induction": "感应", "detect": "检测", "detection": "检测", "measure": "测量", "end": "结束",
  "rate": "频率", "frequency": "频率", "power": "电源", "energy": "电量", "work": "工作", "mode": "模式",
  "fast": "快速", "slow": "慢速", "eco": "节能", "boost": "增压", "child": "儿童", "lock": "锁定", "key": "按键",
  "clean": "清洁", "cleaning": "清洁", "wash": "清洗", "filter": "滤网", "life": "寿命", "left": "剩余",
  "vertical": "上下", "horizontal": "左右", "match": "配对", "matching": "配对中", "ac": "空调", "outlet": "插座",
  "electric": "电", "without": "无", "model": "型号", "ctrl": "控制", "info": "信息", "out": "退出",
};
// 虚词：拼接时直接跳过，不产生译文也不导致整条失败
const ZH_SKIP = new Set(["of", "the", "a", "an", "to", "for", "with"]);
function zhWords(label) {
  const text = String(label || "").trim();
  if (!text || !/^[\x20-\x7e]+$/.test(text)) return ""; // 仅处理纯 ASCII 英文
  // 驼峰转连字符后拆词，全命中才拼接
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().split(/[-\s_]+/).filter(Boolean);
  if (!words.length) return "";
  const parts = [];
  for (const w of words) {
    if (ZH_SKIP.has(w)) continue; // 虚词跳过
    // 先查整词词典（含短语），再查通用词表
    const zh = zhLookup(ZH_VALUE, w) || zhLookup(ZH_PROP, w) || zhLookup(ZH_WORD, w);
    if (!zh) return "";
    parts.push(zh);
  }
  return parts.join("");
}
function hasCJK(s) {
  return /[㐀-䶿一-鿿豈-﫿]/.test(String(s || ""));
}
// 属性/动作 label：优先词典，其次小米官方 comment（中文，去尾部括号注释），再英文逐词兑底，都不中退回原文。
function zhLabel(dict, name, description, fallback, comment) {
  const cmt = hasCJK(comment)
    ? String(comment).replace(/[（(][^）)]*[)）]\s*$/g, "").trim()
    : "";
  return zhLookup(dict, name) || cmt || zhLookup(dict, description)
    || zhWords(description) || String(comment || description || fallback);
}

// ── spec → 控件描述符（纯函数，可离线单测）───────────────────────────
// 输入：MIoT-Spec instance JSON + model；输出：{model, urn, controls[], actions[], power, hasControl, noSpec}
function extractControls(spec, model) {
  const out = {
    model: String(model || ""),
    urn: String(spec && spec.type ? spec.type : ""),
    description: String((spec && spec.description) || ""),
    controls: [],
    actions: [],
    power: null,
    hasControl: false,
    noSpec: false,
  };
  const devCat = urnName(out.urn, "device"); // "watch" / "band" / "light" ...
  const wearable = /watch|band|wearable/.test(devCat) || /watch|band|wearable/.test(String(model || "").toLowerCase());
  const services = spec && Array.isArray(spec.services) ? spec.services : null;
  if (!services) {
    out.noSpec = true;
    return out;
  }
  for (const svc of services) {
    const siid = Number(svc.iid);
    const svcName = urnName(svc.type, "service");
    if (svcName === "device-information") continue; // 固件/型号等元信息，非操控项
    for (const p of Array.isArray(svc.properties) ? svc.properties : []) {
      const piid = Number(p.iid);
      const name = urnName(p.type, "property");
      const label = zhLabel(ZH_PROP, name, p.description, `siid${siid}.piid${piid}`, p.comment);
      const fmt = String(p.format || "");
      const access = Array.isArray(p.access) ? p.access : [];
      const explicitReadable = access.includes("read");
      let writable = access.includes("write");
      let readable = explicitReadable;
      // 遗留/厂商私有 spec（如 urn:als1-spec:...）常省略 access；若因此丢弃会让整台设备无控件。
      // 缺 access 时按「可读写」best-effort 渲染成米家风控件（读不到值时面板显示 —）。
      if (access.length === 0) {
        writable = true;
        readable = true;
      }
      const unit = String(p.unit || "");
      const vlist = Array.isArray(p["value-list"]) ? p["value-list"] : null;
      const vrange = Array.isArray(p["value-range"]) ? p["value-range"] : null;
      const base = { siid, piid, name, label, format: fmt, unit, readable, writable, explicitReadable, svcName };
      if (!writable) {
        // 只读属性：作为状态展示，不生成可写控件
        if (readable) out.controls.push(Object.assign({ kind: "readonly" }, base));
        continue;
      }
      if (vlist && vlist.length) {
        out.controls.push(
          Object.assign({ kind: "select" }, base, {
            options: vlist.map((o) => ({ value: o.value, label: zhLookup(ZH_VALUE, o.description) || zhWords(o.description) || String(o.description != null ? o.description : o.value) })),
          })
        );
      } else if (fmt === "bool") {
        out.controls.push(Object.assign({ kind: "switch" }, base));
      } else if (vrange && vrange.length >= 2) {
        out.controls.push(
          Object.assign({ kind: "slider" }, base, {
            min: Number(vrange[0]),
            max: Number(vrange[1]),
            step: Number(vrange[2] != null ? vrange[2] : 1) || 1,
          })
        );
      } else if (fmt === "float" || /^u?int\d*$/.test(fmt)) {
        out.controls.push(Object.assign({ kind: "number" }, base));
      } else {
        out.controls.push(Object.assign({ kind: "text" }, base));
      }
    }
    for (const a of Array.isArray(svc.actions) ? svc.actions : []) {
      const aiid = Number(a.iid);
      const name = urnName(a.type, "action");
      const label = zhLabel(ZH_ACTION, name, a.description, `siid${siid}.aiid${aiid}`, a.comment);
      const rawIn = Array.isArray(a.in) ? a.in : [];
      const inArgs = rawIn
        .map((x, idx) => ({
          piid: Number(x && x.iid != null ? x.iid : idx + 1),
          name: urnName(x && x.type, "argument"),
          label: (() => {
            const desc = String((x && x.description) || "");
            if (desc) return zhWords(desc) || desc;
            const argName = urnName(x && x.type, "argument");
            return (argName && (zhWords(argName) || argName)) || `参数${idx + 1}`;
          })(),
          format: String((x && x.format) || ""),
          "value-list": x && Array.isArray(x["value-list"]) ? x["value-list"] : null,
          "value-range": x && Array.isArray(x["value-range"]) ? x["value-range"] : null,
        }))
        // 保留能向用户有意义地输入的参数（有 format / 取值域 / 值列表）。
        .filter((x) => x.format || (x["value-list"] && x["value-list"].length) || (x["value-range"] && x["value-range"].length));
      // 只有「无需入参」或「全部入参都能描述」的动作才可可靠触发；否则云会因缺类型报 -8 data type not valid。
      // 厂商/遗留 spec 里 action.in 常只是一串裸整数 piid（无类型）→ 无法描述 → 丢弃该动作（不做注定失败的一键按钮）。
      if (inArgs.length < rawIn.length) continue;
      out.actions.push({ siid, aiid, name, label, svcName, in: inArgs });
    }
  }
  // 穿戴类（手表/手环）一律「仅展示」：属性写（静音/勿扰等）云下发失败；动作（测心率/
  // 震动等）需带类型参数而公开 spec 未提供→盲发必被拒。故只保留显式可读的状态，丢弃全部动作。
  if (wearable) {
    out.controls = out.controls
      .map((c) =>
        c.kind === "readonly" ? c : c.explicitReadable ? Object.assign({}, c, { kind: "readonly" }) : null
      )
      .filter(Boolean);
    out.actions = [];
  }
  // 电源：优先取名为 on / power / main-switch 等可写布尔（或中文标签含「电源/总开关」）
  const isPowerCtl = (c) =>
    c.kind === "switch" &&
    (/^(on|power|main-switch|switch)$/.test(c.name) || /电源|总开关/.test(c.label));
  const on = out.controls.find(isPowerCtl);
  out.power = on ? { siid: on.siid, piid: on.piid } : null;
  out.hasControl = out.controls.some((c) => c.kind !== "readonly") || out.actions.length > 0;
  // 同名控件（如多个服务都有 mode）用服务名前缀区分：灯光·模式 / 风扇·模式
  const seen = new Map();
  for (const c of out.controls) seen.set(c.label, (seen.get(c.label) || 0) + 1);
  for (const a of out.actions) seen.set(a.label, (seen.get(a.label) || 0) + 1);
  const disambiguate = (item, svcName) => {
    if ((seen.get(item.label) || 0) <= 1) return;
    const svcZh = zhLookup(ZH_SVC, svcName) || svcName;
    item.label = `${svcZh}·${item.label}`;
  };
  for (const c of out.controls) disambiguate(c, c.svcName);
  for (const a of out.actions) disambiguate(a, a.svcName);
  for (const c of out.controls) delete c.svcName;
  for (const a of out.actions) delete a.svcName;
  for (const c of out.controls) delete c.explicitReadable; // 内部判定用，不下发给面板
  return out;
}

// ── spec 管理器（带落盘缓存）────────────────────────────────────────
function createSpecManager(opts) {
  const o = opts || {};
  const store = o.storage || {}; // {get(key), set(key,val)}
  const log = typeof o.log === "function" ? o.log : () => {};
  let index = null; // {fetchedAt, map:{model:urn}}
  const specs = new Map(); // urn → descriptor
  let refreshedForMiss = false; // 本次会话内，索引缺 model 时最多强制刷新一次

  let indexPromise = null; // 并发合流：同一时刻只允许一次索引下载

  async function doLoadIndex() {
    try {
      const data = await fetchJson(INSTANCES_URL);
      const map = {};
      for (const it of Array.isArray(data && data.instances) ? data.instances : []) {
        if (it && it.model && it.type) map[String(it.model)] = String(it.type);
      }
      index = { fetchedAt: Date.now(), map };
      try {
        if (store.set) await store.set("spec-index", index);
      } catch {
        /* 落盘失败不影响使用 */
      }
      log(`MIoT-Spec 索引已更新：${Object.keys(map).length} 个型号`);
      return index;
    } catch (err) {
      log(`MIoT-Spec 索引拉取失败，回退缓存：${err && err.message ? err.message : err}`);
      if (!index) {
        try {
          index = store.get ? store.get("spec-index") : null;
        } catch {
          index = null;
        }
        index = index || { fetchedAt: 0, map: {} };
      }
      return index;
    }
  }

  async function loadIndex(force) {
    if (index && !force && Date.now() - (index.fetchedAt || 0) < INDEX_TTL_MS) return index;
    if (indexPromise) return indexPromise; // 已有下载在途，复用同一个 promise
    indexPromise = doLoadIndex().finally(() => {
      indexPromise = null;
    });
    return indexPromise;
  }

  async function resolveUrn(model) {
    const idx = index || (await loadIndex());
    const hit = idx.map[String(model)];
    if (hit) return hit;
    // 仅当索引确已加载（非空）却缺该型号时，才强制刷新一次；空索引说明仍在加载/失败，不重复下载。
    if (!refreshedForMiss && Object.keys(idx.map).length > 0) {
      refreshedForMiss = true;
      await loadIndex(true);
      return index.map[String(model)] || null;
    }
    return null;
  }

  // 返回控件描述符；无 spec 时返回 {noSpec:true,...}，绝不抛异常。
  async function getSpec(model) {
    const m = String(model || "");
    if (!m) return extractControls(null, m);
    const urn = await resolveUrn(m);
    if (!urn) return extractControls(null, m);
    if (specs.has(urn)) return specs.get(urn);
    let spec = null;
    try {
      const ck = "spec-" + sha1short(urn);
      if (store.get) spec = store.get(ck);
      if (!spec || !Array.isArray(spec.services)) {
        spec = await fetchJson(`${INSTANCE_URL}?type=${encodeURIComponent(urn)}`);
        if (spec && Array.isArray(spec.services)) {
          try {
            if (store.set) await store.set(ck, spec);
          } catch {
            /* 忽略 */
          }
        }
      }
    } catch (err) {
      log(`MIoT-Spec 拉取失败 ${m}：${err && err.message ? err.message : err}`);
      spec = null;
    }
    const desc = extractControls(spec, m);
    specs.set(urn, desc);
    return desc;
  }

  async function init() {
    try {
      index = store.get ? store.get("spec-index") : null;
    } catch {
      index = null;
    }
    if (!index || Date.now() - (index.fetchedAt || 0) >= INDEX_TTL_MS) await loadIndex();
  }

  return { init, getSpec, loadIndex, extractControls };
}

module.exports = { createSpecManager, extractControls, __internals: { urnName, sha1short } };
