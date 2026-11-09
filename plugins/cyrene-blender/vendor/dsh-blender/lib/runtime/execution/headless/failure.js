import { enrichError } from '../../core/errors.js';
export function extractFailureContext(stderr, script) {
    let traceback = null;
    let lastException = null;
    let hint = null;
    const tbIdx = stderr.lastIndexOf('Traceback (most recent call last)');
    if (tbIdx >= 0)
        traceback = stderr.slice(tbIdx, tbIdx + 3000);
    const em = stderr.match(/^[\w.]*(?:Error|Exception|Warning)\b.*$/gm);
    if (em && em.length)
        lastException = enrichError(em[em.length - 1].slice(0, 300), traceback);
    if (lastException &&
        /line continuation character|invalid syntax/i.test(lastException) &&
        /\\n/.test(script)) {
        hint =
            '脚本里出现字面量 \\n（两个字符）而不是真正换行 —— 在 JSON/TS 里请写成 \\n，或用 String.fromCharCode(10) 拼。';
    }
    return { traceback, lastException, hint };
}
export function classifyFailure(res, gpuFailed, lastException) {
    // ---- v0.9.1（93-A4）：失败语义分档 —— "客户端超时"不等于"任务失败"，且要能按 runId 回收
    return res.spawnErr
        ? 'blender_exe_missing'
        : res.timedOut
            ? 'timeout'
            : gpuFailed
                ? 'gpu_required_missing'
                : res.exitCode !== 0
                    ? 'blender_error'
                    : lastException
                        ? 'script_error'
                        : 'finished';
}
export function failureHint(failureClass) {
    const FAIL_HINT = {
        finished: null,
        script_error: '脚本抛异常了（退出码可能仍是 0）—— 看 traceback/lastException 指的那一行；结构化结果可能不存在',
        blender_error: 'Blender 进程退出码非 0（崩溃/参数错）—— 看 stderr 尾巴与日志路径',
        timeout: '超时被 SIGKILL：脚本没跑完。改小批量、或 asJob=true 转作业层（不占客户端连接）',
        gpu_required_missing: '要求 GPU 但设备不可用（gpu="true"/engine="cycles" 时）—— 见 gpu 段回执',
        blender_exe_missing: '起不来 Blender 进程：先配 blenderExe / DSH_BLENDER_EXE',
    };
    return FAIL_HINT[failureClass] || null;
}
//# sourceMappingURL=failure.js.map