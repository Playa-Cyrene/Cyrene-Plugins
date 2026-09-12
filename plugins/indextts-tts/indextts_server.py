#!/usr/bin/env python3
"""IndexTTS thin HTTP server (bundled resource of the indextts-tts plugin).

This script is spawned by the plugin's index.cjs (register -> startServer) so
the user never has to run a PowerShell command themselves — they only point the
plugin at an IndexTTS model dir + a Python interpreter that has index-tts and
torch installed.

Dependency note: we deliberately use ONLY the Python standard library
`http.server` on top of what `index-tts` + `torch` already install, so the
bundled server adds ZERO extra pip packages (no FastAPI / uvicorn / flask).

HTTP contract (GPT-SoVITS compatible, so Cyrene's built-in GPT-SoVITS channel
can talk to it directly — the user selects "GPT-SoVITS" in Cyrene and points the
API address at http://127.0.0.1:<port>):

  GET  /health  -> 200 {"status":"ok","engine":...}
                   (used by the plugin to probe readiness)
  POST /tts     -> JSON in  {text, ref_audio_path, prompt_text,
                             speed_factor, text_lang, prompt_lang, media_type}
                   raw WAV bytes out by default (GPT-SoVITS api_v2 compatible:
                   Cyrene's GPT-SoVITS channel reads it via resp.arrayBuffer())
                   (append ?json=1 or header X-Json-Audio: 1 to get JSON {audio_base64, format:"wav"})

The audio is ALWAYS WAV: index-tts inference writes a .wav file and this thin
server has no mp3 encoder, so the response truthfully reports format "wav"
rather than mislabelling wav bytes as mp3.

CLI:  python indextts_server.py --model-dir <dir> --port <port>
                                [--engine v2|v2_5] [--host 127.0.0.1] [--no-fp16] [--emotion] [--nonce <s>]

--emotion 开启「文本情感引导」：构造时加载 QwenEmotion 情感模型，并在每次合成时
按 emo_text（缺省用正文）推断情感向量。它要多加载一个模型，故默认关闭。

--download-only 只把模型仓库下载到 --model-dir 后退出（供插件的一键引导调用），
不加载模型、不监听端口；再加 --download-aux 会连同推理必需的辅助模型
（w2v-bert-2.0 / BigVGAN / semantic_codec / campplus）一起下到 hf_cache/。
"""

import argparse
import base64
import inspect
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Engine state: loaded once, guarded by a lock because IndexTTS2 is not
# thread-safe for concurrent inference.
# ---------------------------------------------------------------------------
_LOCK = threading.Lock()
_TTS = None
_MODEL_DIR = ""
_ENGINE = "v2"
_USE_FP16 = True
# 文本情感引导（use_emo_text）：开启才会加载 QwenEmotion 情感模型。
# 默认关闭——它要额外加载一个 Qwen 模型（且 device_map="auto" 在显存紧张时会卸到内存），
# 只在用户需要按文本情感改变语气时才开。
_USE_EMOTION = False
# 插件启动时传入的一次性 nonce，回显在 /health 上，用于确认应答来自本进程。
_NONCE = ""
# 推理排队等待上限（秒）：超过就回 503，避免请求无限堆积（宿主侧 180s 超时）。
MAX_QUEUE_WAIT_S = 30


def _rss_bytes():
    """进程 RSS（工作集）字节数；取不到返回 None。"""
    try:
        import psutil  # 装了就用它，最省事
        return psutil.Process().memory_info().rss
    except Exception:  # noqa: BLE001
        pass
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class _PMC(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            pmc = _PMC()
            pmc.cb = ctypes.sizeof(pmc)
            fn = getattr(ctypes.windll.kernel32, "K32GetProcessMemoryInfo", None)
            if fn is None:
                fn = ctypes.windll.psapi.GetProcessMemoryInfo
            fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PMC), wintypes.DWORD]
            fn.restype = wintypes.BOOL
            if fn(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                return int(pmc.WorkingSetSize)
        except Exception:  # noqa: BLE001
            return None
        return None
    try:
        with open("/proc/self/statm", "r") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except Exception:  # noqa: BLE001
        return None


def _mem_parts() -> str:
    """拼出 "rss=..MB cuda_alloc=..MB cuda_reserved=..MB" 诊断串。"""
    parts = []
    try:
        rss = _rss_bytes()
        if rss is not None:
            parts.append("rss=%.0fMB" % (rss / 1048576))
    except Exception:  # noqa: BLE001
        pass
    try:
        import torch
        if torch.cuda.is_available():
            parts.append("cuda_alloc=%.0fMB" % (torch.cuda.memory_allocated() / 1048576))
            parts.append("cuda_reserved=%.0fMB" % (torch.cuda.memory_reserved() / 1048576))
    except Exception:  # noqa: BLE001
        pass
    return "  ".join(parts)


def _trim_working_set() -> None:
    """把已释放、但未归还给操作系统的页还给系统（Windows: EmptyWorkingSet）。

    只降低 RSS（工作集）读数，不释放仍被引用的内存；换出的页下次访问会按需换回。
    """
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.psapi.EmptyWorkingSet(ctypes.windll.kernel32.GetCurrentProcess())
        except Exception:  # noqa: BLE001
            pass


def _memlog(tag: str) -> None:
    """可选内存诊断：设 CYRENE_INDEXTTS_MEMLOG=1 时打印 RSS / CUDA 占用。

    再设 CYRENE_INDEXTTS_TRIM=1 时，会先做一次工作集回收，再打一行回收后的对比。
    """
    if not os.environ.get("CYRENE_INDEXTTS_MEMLOG"):
        return
    print("[memlog] " + tag + "  " + _mem_parts(), flush=True)
    if os.environ.get("CYRENE_INDEXTTS_TRIM"):
        _trim_working_set()
        print("[memlog] " + tag + " (after trim)  " + _mem_parts(), flush=True)


def _load_engine(force: bool = False):
    """Lazily construct the IndexTTS2 model. Default engine is IndexTTS 2.0."""
    global _TTS
    if _TTS is not None and not force:
        return _TTS

    cfg_path = os.path.join(_MODEL_DIR, "config.yaml")
    if not os.path.exists(cfg_path):
        raise FileNotFoundError(f"IndexTTS config.yaml not found in {_MODEL_DIR}")

    if _ENGINE == "v2_5":
        # IndexTTS 2.5: infer_v2_5 module. Flags differ across builds, so we
        # fall back to a minimal {cfg_path, model_dir} set if the signature
        # rejects them. This is best-effort; the primary target is 2.0.
        from indextts.infer_v2_5 import IndexTTS2  # type: ignore
        kwargs = dict(
            cfg_path=cfg_path, model_dir=_MODEL_DIR, use_cuda_kernel=False,
            use_deepspeed=False, use_qwen_emo=_USE_EMOTION,
        )
        if _USE_FP16:
            kwargs["use_bf16"] = True
    else:
        # IndexTTS 2.0: infer_v2 uses `use_fp16` (NOT use_bf16).
        # use_qwen_emo 跟随 --emotion 开关：infer_v2 默认 True，会白加载一个
        # Qwen 情感模型；只有开启文本情感引导时才需要它。
        from indextts.infer_v2 import IndexTTS2
        kwargs = dict(
            cfg_path=cfg_path,
            model_dir=_MODEL_DIR,
            use_fp16=_USE_FP16,
            use_cuda_kernel=False,
            use_deepspeed=False,
            use_qwen_emo=_USE_EMOTION,
        )

    # 只传构造签名接受的参数（不同构建的 IndexTTS2 参数不一致）。
    # 不用 `except TypeError` 兜底——那会把构造过程内部的 TypeError 也误判成签名不符而重载模型。
    try:
        accepted = set(inspect.signature(IndexTTS2.__init__).parameters)
        call_kwargs = {k: v for k, v in kwargs.items() if k in accepted}
    except (TypeError, ValueError):
        call_kwargs = kwargs
    _TTS = IndexTTS2(**call_kwargs)

    print(f">> IndexTTS engine ready: {_ENGINE} (device={getattr(_TTS, 'device', '?')})", flush=True)
    _memlog("model_loaded")
    return _TTS


# v2_5 的 infer 必填 lang（v2.0 的 infer 没有该参数，下面的判定对它等同死代码，仅作兼容保留）。
SUPPORTED_LANGS = ("zh", "en", "ja", "es", "ar", "yue")


def _detect_decisive_script(text: str) -> str:
    """只认「一眼可辨」的非中文脚本：假名 → ja、阿拉伯文 → ar；其余返回空串。

    不能只查 CJK 表意文字：日文正文通常混着汉字，但纯假名（ひらがな／カタカナ）不带汉字，
    旧实现会把「纯假名 + text_lang=ja」改判成 en。
    """
    if re.search(r"[\u3040-\u30ff]", text):  # 平假名 + 片假名
        return "ja"
    if re.search(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]", text):  # 阿拉伯文（含补充区）
        return "ar"
    return ""


def _resolve_lang(text: str, host_lang: str) -> str:
    """决定合成用的 lang：只在正文脚本一眼可辨时压过宿主，否则尊重宿主的 text_lang。

    宿主（Cyrene）目前把 text_lang 硬编码成 "zh"，所以「正文完全没有 CJK」时才按英文兜底。
    """
    decisive = _detect_decisive_script(text)
    if decisive and decisive != host_lang:
        return decisive
    if host_lang in SUPPORTED_LANGS:
        if host_lang == "zh" and not re.search(r"[\u4e00-\u9fff]", text):
            return "en"
        return host_lang
    return "zh" if re.search(r"[\u4e00-\u9fff]", text) else "en"


def _synthesize(payload: dict, as_json: bool):
    """Synthesize audio from a payload dict; returns (status, raw-wav-bytes-or-json-dict)."""
    text = (payload.get("text") or "").strip()
    ref_audio = (payload.get("ref_audio_path") or "").strip()
    if not text:
        return 400, {"error": "missing text"}
    if not ref_audio or not os.path.exists(ref_audio):
        return 400, {"error": f"missing or invalid ref_audio_path: {ref_audio}"}

    # 本服务只产出 WAV（无 mp3 编码器）。调用方要求 mp3 时直接拒绝，
    # 避免把 WAV 字节标成 mp3 返回、让宿主缓存成 .mp3。
    media_type = (payload.get("media_type") or "wav").strip().lower()
    if media_type != "wav":
        return 400, {"error": "本服务只产出 wav，不支持 media_type=" + media_type}

    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        # 推理持锁串行（IndexTTS2 非线程安全）；等待超限则回 503，避免请求无限堆积。
        if not _LOCK.acquire(timeout=MAX_QUEUE_WAIT_S):
            return 503, {"error": "busy: 已有合成任务在进行中，请稍后重试"}
        try:
            tts = _load_engine()
            # lang 只对 v2_5 真正生效（infer_v2_5.infer 必填 lang）；
            # v2（2.0）的 infer 没有 lang 参数，下面的判定对它等同死代码，仅作兼容保留。
            # 仅当 infer 签名里有 lang 参数才传，避免 TypeError。
            host_lang = (payload.get("text_lang") or payload.get("prompt_lang") or "").strip().lower()
            lang = _resolve_lang(text, host_lang)
            infer_kwargs = dict(spk_audio_prompt=ref_audio, text=text, output_path=wav_path, verbose=False)
            if "lang" in inspect.signature(tts.infer).parameters:
                infer_kwargs["lang"] = lang
            # 文本情感引导：开启后按 emo_text（缺省用正文文本）推断情感向量，
            # 让语气跟随文本情感。需要构造时 use_qwen_emo=True。
            if _USE_EMOTION and "use_emo_text" in inspect.signature(tts.infer).parameters:
                infer_kwargs["use_emo_text"] = True
                emo_text = (payload.get("emo_text") or "").strip()
                if emo_text:
                    infer_kwargs["emo_text"] = emo_text
            tts.infer(**infer_kwargs)
            # 释放 CUDA 缓存 + 回收，防反复合成累积显存/内存。
            # 注：合成期间 host 内存会短暂冲高（中间张量 + 显存吃紧时的溢出），
            # 结束后应回落到基线；这里的回收是为了让每次请求都尽快归还。
            try:
                import gc
                import torch
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    # 回收 CUDA 跨进程共享内存残留（复用显存 / 多上下文场景）
                    try:
                        torch.cuda.ipc_collect()
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
        finally:
            _LOCK.release()
        _memlog("after_infer")
        with open(wav_path, "rb") as f:
            audio = f.read()
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass

    if not audio:
        return 500, {"error": "IndexTTS produced empty audio"}

    if as_json:
        # 可选 JSON 形态（?json=1），供调试 / 非 GPT-SoVITS 客户端使用。
        return 200, {"audio_base64": base64.b64encode(audio).decode("ascii"), "format": "wav"}

    # 默认返回原始 WAV 字节：GPT-SoVITS api_v2 的契约，Cyrene 的 GPT-SoVITS 通道
    # 用 resp.arrayBuffer() 直接读字节，不解析 JSON。推理只产出 wav，故如实是 wav。
    return 200, audio


class _Server(ThreadingHTTPServer):
    """HTTP 服务端：Windows 上关闭端口复用。

    Windows 的 SO_REUSEADDR 允许第二个进程绑定同一端口，会掩盖「旧进程仍在服务」：
    实测第二个实例 bind 成功后请求仍全部落到旧进程，导致改了端口/配置却没生效。
    """

    allow_reuse_address = os.name != "nt"


class _Handler(BaseHTTPRequestHandler):
    server_version = "CyreneIndexTTS/1.0"

    def log_message(self, fmt, *args):  # quieter than default
        """Log a request line to stderr only when CYRENE_INDEXTTS_VERBOSE is set."""
        if os.environ.get("CYRENE_INDEXTTS_VERBOSE"):
            sys.stderr.write("[indextts] %s\n" % (fmt % args))

    def _send_json(self, status, obj):
        """Serialize obj as UTF-8 JSON and write it with the given status code."""
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status, data, content_type):
        """Write raw data bytes to the response with the given status and content type."""
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        """Handle GET requests: return health status on /health, 404 otherwise."""
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/health":
            # nonce 由插件在 spawn 时传入并回显，用于确认应答来自「我们自己拉起的进程」，
            # 避免端口上已有别的服务时误判为就绪。
            self._send_json(200, {"status": "ok", "engine": _ENGINE, "nonce": _NONCE})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        """Handle POST /tts requests: synthesize audio and return JSON or raw wav bytes."""
        parsed = urlparse(self.path)
        # 路径精确匹配：旧实现用 endswith("/tts")，/foo/tts 也会被当成合法端点。
        if parsed.path.rstrip("/") != "/tts":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            self._send_json(400, {"error": "invalid Content-Length"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("body must be a JSON object")
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": f"invalid JSON: {exc}"})
            return
        # ?json=1 按 query 参数解析：旧实现用子串匹配，?x=json=1 也会被当成 JSON 模式。
        params = parse_qs(parsed.query)
        as_json = params.get("json", [""])[0].strip().lower() in ("1", "true", "yes") \
            or self.headers.get("X-Json-Audio") == "1"
        try:
            status, result = _synthesize(payload, as_json)
            if isinstance(result, bytes):
                self._send_bytes(status, result, "audio/wav")
            else:
                self._send_json(status, result)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("[indextts] /tts error: %s\n" % exc)
            self._send_json(500, {"error": str(exc)})

    def do_HEAD(self) -> None:
        """HEAD：只回状态行与头、不回正文（给 curl -I / 探活用）。"""
        parsed = urlparse(self.path)
        status = 200 if parsed.path.rstrip("/") == "/health" else 404
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported_method(self) -> None:
        """其余方法统一回 JSON 501：否则会漏出 BaseHTTPRequestHandler 默认的 HTML 501。"""
        self._send_json(501, {"error": "unsupported method: " + (self.command or "?")})

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = _unsupported_method


def _download_model(model_dir: str, engine: str) -> None:
    """Download the IndexTTS main model repo into model_dir (HuggingFace/ModelScope, auto).

    供插件的一键引导使用：仓库自带的下载器会按网络环境自动选择 HF / ModelScope，
    把整个模型仓库（config.yaml / *.pth / bpe.model 等）拉到 model_dir。
    """
    os.makedirs(model_dir, exist_ok=True)
    repo = "IndexTeam/IndexTTS-2.5" if engine == "v2_5" else "IndexTeam/IndexTTS-2"
    print(f">> downloading {repo} -> {model_dir}", flush=True)
    try:
        from indextts.utils.model_download import snapshot_download
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            "无法导入 indextts（请确认依赖已安装，例如在 IndexTTS 目录执行 uv sync）：%s" % exc
        )
    snapshot_download(repo, model_dir)
    print(">> model download complete", flush=True)


def _download_aux(model_dir: str) -> None:
    """下载 IndexTTS 推理必需的辅助模型到 model_dir/hf_cache/。

    IndexTTS2.__init__ 在未传 aux_paths 时会调用 ensure_models_available()，
    首次构造即触发数 GB 下载（w2v-bert-2.0 / BigVGAN / semantic_codec / campplus）；
    放在安装阶段做，避免首次启动被插件的 240s 就绪窗口掐断。
    """
    os.makedirs(model_dir, exist_ok=True)
    print(">> downloading auxiliary models -> %s" % os.path.join(model_dir, "hf_cache"), flush=True)
    try:
        from indextts.utils.model_download import ensure_models_available
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            "无法导入 indextts（请确认依赖已安装，例如在 IndexTTS 目录执行 uv sync）：%s" % exc
        )
    ensure_models_available(model_dir)
    print(">> auxiliary models ready", flush=True)


def main():
    """Parse CLI arguments, preload the engine, and serve HTTP requests."""
    global _MODEL_DIR, _ENGINE, _USE_FP16, _USE_EMOTION, _NONCE
    parser = argparse.ArgumentParser(description="Cyrene IndexTTS thin server")
    parser.add_argument("--model-dir", required=True, help="IndexTTS model checkpoint directory")
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--engine", choices=["v2", "v2_5"], default="v2")
    parser.add_argument("--fp16", dest="fp16", action="store_true", default=True, help="Use FP16/BF16 if available")
    parser.add_argument("--no-fp16", dest="fp16", action="store_false", help="Disable FP16/BF16")
    parser.add_argument("--emotion", action="store_true", default=False, help="Load QwenEmotion and use text-emotion guidance (extra model)")
    parser.add_argument("--nonce", default="", help="回显到 /health，供插件确认应答来自本进程")
    parser.add_argument("--download-only", action="store_true", default=False, help="Download the model repo into --model-dir and exit")
    parser.add_argument("--download-aux", action="store_true", default=False,
                        help="连同辅助模型（w2v-bert-2.0 / BigVGAN / semantic_codec / campplus）一起下载")
    args = parser.parse_args()

    if args.download_only:
        _download_model(args.model_dir, args.engine)
        if args.download_aux:
            _download_aux(args.model_dir)
        return

    if not os.path.isdir(args.model_dir):
        print(f"[indextts] model dir does not exist: {args.model_dir}", flush=True)
        sys.exit(1)

    _MODEL_DIR = args.model_dir
    _ENGINE = args.engine
    _USE_FP16 = args.fp16
    _USE_EMOTION = args.emotion
    _NONCE = args.nonce

    # 先 bind 端口再加载模型：端口被占用时立刻失败退出，不会白加载几 GB 模型进显存。
    # _Server 构造即 bind+listen，但 serve_forever() 之前不处理请求，
    # 因此 /health 仍然只在模型就绪后才可能被应答，就绪语义不变。
    server = _Server((args.host, args.port), _Handler)

    # 模型加载在 bind 之后：就绪探测（/health）只在推理可用后才成功。
    _load_engine()

    print(f"[indextts] serving http://{args.host}:{args.port} engine={_ENGINE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[indextts] shutting down", flush=True)


if __name__ == "__main__":
    main()
