"use strict";
/**
 * local-asr 内置引擎工作进程（v0.4.6）
 *
 * 为什么单独一个进程：
 *   宿主 Electron 主进程启动即加载 onnxruntime-node 的 onnxruntime.dll
 *   （bge-reranker 等内置 AI 使用）。Windows 加载器按模块名去重，
 *   sherpa-onnx.node 静态导入的同名 DLL 会绑到宿主那份不兼容版本上，
 *   推理瞬间 abort（0xc0000409）连带宿主整个闪退。
 *   本进程由 index.cjs 以 ELECTRON_RUN_AS_NODE=1 拉起 —— 纯 Node 环境，
 *   进程内只有 sherpa 自己的引擎文件，无冲突；崩溃只损失当次识别，
 *   宿主下次调用自动重启本进程。
 *
 * 协议（IPC，serialization: advanced，Float32Array 走 structured clone）：
 *   主 → 子 : { id: number, sampleRate: number, samples: Float32Array }
 *             { cmd: "shutdown" }
 *   子 → 主 : { ready: true }
 *             { id, text }              识别成功
 *             { id, error }             当次识别失败
 *             { fatal }                 初始化失败（模型/词表/二进制问题）
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createHash } = require("node:crypto");

const ENGINE_ROOT = process.env.ASR_ENGINE_ROOT || "";
const ENGINE_JS = path.join(ENGINE_ROOT, "sherpa-onnx-node", "sherpa-onnx.js");
// v0.4.9：主进程在安装时记录的引擎脚本哈希（env 下发）；加载前复验，防安装后被替换
const EXPECTED_JS_SHA = process.env.ASR_ENGINE_JS_SHA || "";

function verifyEngineJs() {
  if (!EXPECTED_JS_SHA) return; // 旧安装未记录哈希：跳过（下载时 tgz 已验）
  const actual = createHash("sha256").update(fs.readFileSync(ENGINE_JS)).digest("hex");
  if (actual.toLowerCase() !== EXPECTED_JS_SHA.toLowerCase()) {
    throw new Error(`引擎脚本 SHA-256 不符（${actual.slice(0, 12)}… ≠ ${EXPECTED_JS_SHA.slice(0, 12)}…），疑似安装后被替换，拒绝加载`);
  }
}

let recognizer = null;
let loading = null;

function getRecognizer() {
  if (recognizer) return Promise.resolve(recognizer);
  if (!loading) {
    if (!ENGINE_ROOT) {
      return Promise.reject(new Error("ASR_ENGINE_ROOT 未设置"));
    }
    // 唯一的引擎加载点：路径与来源校验见 index.cjs 顶部 ENGINE_PARTS / MODEL_SOURCES
    verifyEngineJs();
    const sherpa = require(ENGINE_JS);
    loading = sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: path.join(ENGINE_ROOT, "models", "model.int8.onnx") },
        tokens: path.join(ENGINE_ROOT, "models", "tokens.txt"),
        numThreads: 2,
        debug: false,
        provider: "cpu",
      },
    }).then((r) => {
      recognizer = r;
      return r;
    });
  }
  return loading;
}

process.on("message", async (msg) => {
  if (!msg) return;
  if (msg.cmd === "shutdown") process.exit(0);
  if (typeof msg.id !== "number") return;
  try {
    const rec = await getRecognizer();
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: msg.sampleRate || 16000, samples: msg.samples });
    await rec.decodeAsync(stream);
    const text = (rec.getResult(stream).text || "").trim();
    if (process.connected) process.send({ id: msg.id, text });
  } catch (e) {
    if (process.connected) process.send({ id: msg.id, error: String((e && e.message) || e) });
  }
});

getRecognizer()
  .then(() => { if (process.connected) process.send({ ready: true }); })
  .catch((e) => {
    if (process.connected) process.send({ fatal: String((e && e.message) || e) });
    process.exit(1);
  });
