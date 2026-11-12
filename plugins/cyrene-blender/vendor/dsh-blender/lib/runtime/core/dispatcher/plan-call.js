// plan/qc/audit 前缀路由（由 config/routing.json 生成表驱动）
import { WIN_TMP, blenderJoin } from '../../paths.js';
import { extractLoop } from '../output/index.js';
import { KERNEL_BOOTSTRAP } from '../kernel/index.js';
import { MAIN_ROUTES, MODULE_ROUTES } from './routes.generated.js';
export const hit = (result) => ({
    matched: true,
    result: Promise.resolve(result),
});
export const miss = () => ({ matched: false });
/** evidence：先注入默认 view.path 再走契约层 */
export async function prepareEvidencePayload(E, o, payload) {
    if (o !== 'evidence')
        return payload;
    await E.ensureView();
    const { SESSION_NAME } = E;
    const p = payload !== null && typeof payload === 'object' ? payload : {};
    const viewRec = p.view !== null && typeof p.view === 'object' ? p.view : {};
    if (!viewRec.path)
        viewRec.path = blenderJoin(WIN_TMP, 'dsh_evidence_' + SESSION_NAME.replace(/[^A-Za-z0-9_.-]/g, '_') + '.png');
    p.view = viewRec;
    return p;
}
/** 通用：把 op 派给 Blender 侧内核模块的 dispatch(op, json) */
export async function dispatchViaKernelModule(E, ensure, api, subOp, payload, timeoutMs) {
    await ensure();
    const body = 'print("LOOP " + K.' +
        api +
        '["dispatch"](' +
        JSON.stringify(subOp) +
        ', _json.dumps(_json.loads(' +
        JSON.stringify(JSON.stringify(payload || {})) +
        '))))';
    return extractLoop(await E.addon.send('execute_code', { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body }, timeoutMs));
}
/** 生成表共用的匹配/切片口径：exact 行按 op 全等，prefix 行按前缀命中。 */
export function routeMatches(route, o) {
    return route.match === 'exact' ? o === route.op : o.indexOf(route.prefix) === 0;
}
/** 固定 sub（别名）优先；否则按表里的 strip 长度从 op 上切掉前缀。 */
function routeSubOp(route, o) {
    return route.sub === null ? o.slice(route.strip) : route.sub;
}
async function handleQcRender(E, route, o, payload) {
    const p = payload !== null && typeof payload === 'object' ? payload : {};
    if (p.asJob) {
        const { preloadChunk, jobStart } = E;
        const mods = String(route.preload || 'qc,qc_render')
            .split(',')
            .map(preloadChunk)
            .join(String.fromCharCode(10));
        const driver = 'import json as _json' +
            String.fromCharCode(10) +
            'print("HEADLESS " + K.' +
            route.api +
            '["render_views"](_json.loads(' +
            JSON.stringify(JSON.stringify(p)) +
            ')))';
        const j = jobStart({
            file: p.file,
            outdir: p.outdir || WIN_TMP,
            engine: p.engine && String(p.engine) !== 'keep' ? String(p.engine) : 'eevee',
            timeoutMs: Number(p.timeoutMs) || 3600000,
            script: mods + String.fromCharCode(10) + driver,
        });
        return {
            ok: true,
            mode: 'job',
            jobId: j.id,
            ms: 0,
            outdir: j.outdir,
            logDir: j.logDir,
            jsonl: blenderJoin(String(p.outdir || WIN_TMP), 'render_views.jsonl'),
            job: j,
            hint: '长活已转作业层：blender_run(action=""status"/"collect", id="' +
                j.id +
                '") 跟进；产物与日志在 outdir/jobs/ 下',
        };
    }
    return dispatchViaKernelModule(E, E[route.ensure], route.api, routeSubOp(route, o), p, route.timeoutMs);
}
async function handleMontage(E, route, payload) {
    await E[route.ensure]();
    const body = 'print("LOOP " + K.' +
        route.api +
        '["montage"](_json.loads(' +
        JSON.stringify(JSON.stringify(payload || {})) +
        ')))';
    return extractLoop(await E.addon.send('execute_code', { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body }, route.timeoutMs));
}
/** motion_/deliver_ 的模块 API 不是统一 dispatch，需要按函数名直调。 */
async function handleModuleAlias(E, route, o, payload) {
    await E[route.ensure]();
    const name = o.slice(route.strip);
    const body = [
        'import json as _json',
        'A = K.' + route.api,
        'P = _json.loads(' + JSON.stringify(JSON.stringify(payload || {})) + ')',
        'if isinstance(P, dict) and isinstance(P.get("args"), dict): P = P["args"]',
        'print("LOOP " + (A["dispatch"](' +
            JSON.stringify(name) +
            ', _json.dumps(P)) if A.get("dispatch") else A[' +
            JSON.stringify(name) +
            '](**P)))',
    ].join(String.fromCharCode(10));
    return extractLoop(await E.addon.send('execute_code', { code: KERNEL_BOOTSTRAP + '\n' + body }, route.timeoutMs));
}
/** gui_* 走 dsh_view_api 的直调入口（名字固定带 gui_ 前缀）。 */
async function handleView(E, route, o, payload) {
    await E[route.ensure]();
    const name = 'gui_' + o.slice(route.strip);
    const body = 'print("LOOP " + K.' +
        route.api +
        '[' +
        JSON.stringify(name) +
        '](**_json.loads(' +
        JSON.stringify(JSON.stringify(payload || {})) +
        ')))';
    return extractLoop(await E.addon.send('execute_code', { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body }, route.timeoutMs));
}
/** render_* 的锁查询别名（render_lock_status -> status）在 routing.json 里显式声明。 */
async function handleRender(E, route, o, payload) {
    await E[route.ensure]();
    const rest = o.slice(route.strip);
    const sub = route.subAliases[rest] || rest;
    const body = 'print("LOOP " + K.' +
        route.api +
        '["dispatch"](' +
        JSON.stringify(sub) +
        ', _json.dumps(_json.loads(' +
        JSON.stringify(JSON.stringify(payload || {})) +
        '))))';
    return extractLoop(await E.addon.send('execute_code', { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body }, route.timeoutMs));
}
/** 按生成行的 kind 选择调用形态；api/strip/sub/preload/timeout 一律来自 config/routing.json。 */
export async function handleRoute(E, route, o, payload) {
    switch (route.kind) {
        case 'qc-render':
            return handleQcRender(E, route, o, payload);
        case 'montage':
            return handleMontage(E, route, payload);
        case 'motion':
        case 'deliver':
            return handleModuleAlias(E, route, o, payload);
        case 'view':
            return handleView(E, route, o, payload);
        case 'render':
            return handleRender(E, route, o, payload);
        default:
            return dispatchViaKernelModule(E, E[route.ensure], route.api, routeSubOp(route, o), payload, route.timeoutMs);
    }
}
async function routeTable(E, o, payload, routes) {
    for (const route of routes) {
        if (!routeMatches(route, o))
            continue;
        return hit(handleRoute(E, route, o, payload));
    }
    return miss();
}
export async function routeMainPlanOps(E, o, payload) {
    return routeTable(E, o, payload, MAIN_ROUTES);
}
export async function routeModulePlanOps(E, o, payload) {
    return routeTable(E, o, payload, MODULE_ROUTES);
}
//# sourceMappingURL=plan-call.js.map