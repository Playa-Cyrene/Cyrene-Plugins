// /host 状态视图 + @ 提及数据源
import { stats } from '../config.js';
import { leaseView } from '../lease.js';
import { clampItemsLimit } from '../response.js';
/**
 * v2.6.1：GET /host/state 的响应体（纯内存，零 Blender 往返；任何一块取不到都给保守默认值，不抛）。
 * 「AI 已暂停」只能在 addon 拒掉一条命令之后才知道（后端不为它轮询 Blender），成功一次就清空。
 */
export function hostStateView(E) {
    const { engine } = E;
    const now = Date.now();
    const age = (t) => (typeof t === 'number' && t ? now - t : null);
    let m;
    try {
        m = (engine.metrics() || {});
    }
    catch (e) {
        m = {};
    }
    let render = {
        busy: false,
        ageMs: null,
        scene: null,
    };
    try {
        const g = engine.renderFlag();
        if (g && g.present)
            render = {
                busy: !g.stale,
                ageMs: g.ageMs,
                scene: g.info?.['scene'] || null,
            };
    }
    catch (e) {
        /* 读不到标记 = 不在渲染 */
    }
    let running;
    try {
        running = (engine.job.list() || []).filter((j) => j && j.status === 'running').length;
    }
    catch (e) {
        running = 0;
    }
    return {
        ok: true,
        channel: {
            lastOkAgeMs: age(m.lastOkAt),
            lastCmd: m.lastCmd || null,
            lastCmdAgeMs: age(m.lastCmdAt),
            inflight: Number(m.inflight) || 0,
            lastError: m.lastError ? String(m.lastError).slice(0, 200) : null,
            lastErrorAgeMs: age(m.lastErrorAt),
            diagnosis: m.lastDiagnosis && m.lastDiagnosis.kind
                ? String(m.lastDiagnosis.kind)
                : null,
            aiPaused: !!m.aiPausedAt,
        },
        lease: leaseView(),
        render: render,
        jobs: { running: running },
        backend: { pid: process.pid, uptimeMs: now - stats.startedAt },
    };
}
/** 契约 §1.6 @ 提及数据源（GET /host/scene-items） */
export async function handleSceneItems(E, url, res, origin) {
    const { engine, hostJson, hostErrText } = E;
    let out;
    try {
        out = (await engine.hostSceneItems({
            q: url.searchParams.get('q') || '',
            limit: clampItemsLimit(url.searchParams.get('limit')),
        }));
    }
    catch (e) {
        stats.lastError = hostErrText(e);
        hostJson(res, 502, { ok: false, error: hostErrText(e) }, origin);
        return;
    }
    hostJson(res, 200, {
        ok: true,
        objects: out.objects || [],
        materials: out.materials || [],
        collections: out.collections || [],
    }, origin);
}
//# sourceMappingURL=scene-items.js.map