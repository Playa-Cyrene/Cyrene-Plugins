// shape-search 请求解析/归一化
import { searchAxisValues } from './axes.js';
export const SHAPE_SEARCH_SKELETON = 'blender_op(op="shape_search", args={objective:"silhouette_iou", ' +
    'ref:"D:/ref/side.png", view:{from:[0,-6,1.0], look_at:[0,0,0.5], lens:50}, ' +
    "apply:\"ob.location.y = p['dy_mm']/1000.0\\n    ob.location.z = p['dz_mm']/1000.0\\n" +
    '    bpy.context.view_layer.update()", ' +
    'params:{dy_mm:{min:-30,max:30,step:5}, dz_mm:{min:-20,max:20,step:5}}, ' +
    'iterations:200, budget_ms:30000, top_k:10})';
function validatePayload(payload) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};
    const OBJECTIVES = ['silhouette_iou', 'profile_err', 'aabb_err'];
    const objective = String(p.objective || 'silhouette_iou');
    if (OBJECTIVES.indexOf(objective) < 0) {
        return {
            ok: false,
            op: 'shape_search',
            stage: 'validate',
            error: 'objective 只支持 ' + OBJECTIVES.join(' / '),
            got: objective,
            skeleton: SHAPE_SEARCH_SKELETON,
        };
    }
    const rawParams = p.params;
    if (!rawParams ||
        typeof rawParams !== 'object' ||
        Array.isArray(rawParams) ||
        Object.keys(rawParams).length === 0) {
        return {
            ok: false,
            op: 'shape_search',
            stage: 'validate',
            error: 'params 必填：{参数名: {min,max(,step)} 或 {values:[...]}}',
            got: rawParams === undefined ? null : rawParams,
            skeleton: SHAPE_SEARCH_SKELETON,
        };
    }
    const norm = {};
    const problems = [];
    const rawParamsRec = rawParams;
    for (const key of Object.keys(rawParamsRec)) {
        const v = rawParamsRec[key];
        if (!v || typeof v !== 'object') {
            problems.push(key + ': 要 {min,max} 或 {values:[...]}');
            continue;
        }
        const vv = v;
        if (Array.isArray(vv.values)) {
            if (!vv.values.length) {
                problems.push(key + ': values 为空');
                continue;
            }
            norm[key] = { kind: 'enum', values: vv.values.slice(0, 500) };
            continue;
        }
        const lo = Number(vv.min), hi = Number(vv.max);
        if (!isFinite(lo) || !isFinite(hi) || hi < lo) {
            problems.push(key + ': min/max 不合法（' + String(vv.min) + ',' + String(vv.max) + '）');
            continue;
        }
        const step = Number(vv.step);
        norm[key] = {
            kind: 'range',
            min: lo,
            max: hi,
            step: isFinite(step) && step > 0 ? step : 0,
            integer: !!vv.integer,
        };
    }
    if (problems.length)
        return {
            ok: false,
            op: 'shape_search',
            stage: 'validate',
            error: '参数区间有问题',
            problems: problems,
            skeleton: SHAPE_SEARCH_SKELETON,
        };
    return { ok: true, p, objective, norm };
}
function parseLimits(p) {
    const iterationsReq = Math.max(1, Math.min(200000, Number(p.iterations) || 200));
    const budgetMs = Math.max(1000, Math.min(600000, Number(p.budget_ms) || 30000));
    const topK = Math.max(0, Math.min(200, p.top_k === undefined ? 10 : Number(p.top_k)));
    const patience = Math.max(0, Number(p.patience) || 0);
    const minimize = p.minimize === undefined ? true : !!p.minimize;
    const interval = Math.max(0, Number(p.interval) || 0);
    const measureEvery = Math.max(1, Number(p.measure_every) || 1);
    return { iterationsReq, budgetMs, topK, patience, minimize, interval, measureEvery };
}
function parseStrategy(p, norm, limits) {
    const { iterationsReq } = limits;
    const axes = Object.keys(norm).map((k) => ({
        k: k,
        spec: norm[k],
        vals: searchAxisValues(norm[k], 600),
    }));
    let combos = 1;
    for (const a of axes)
        combos *= a.vals.length;
    let strategy = String(p.strategy || 'auto');
    if (strategy === 'auto')
        strategy = combos <= iterationsReq ? 'grid' : 'random';
    if (strategy !== 'grid' && strategy !== 'random') {
        return {
            ok: false,
            op: 'shape_search',
            stage: 'validate',
            error: 'strategy 只支持 auto / grid / random',
            got: strategy,
            skeleton: SHAPE_SEARCH_SKELETON,
        };
    }
    if (strategy === 'grid' && combos > 20000) {
        return {
            ok: false,
            op: 'shape_search',
            stage: 'validate',
            error: 'grid 组合数 ' + combos + ' 太大（>20000）→ 用 strategy:"random" 或缩小 step',
            combos: combos,
            skeleton: SHAPE_SEARCH_SKELETON,
        };
    }
    const iterations = strategy === 'grid' ? Math.min(iterationsReq, combos) : iterationsReq;
    return { axes, combos, strategy, iterations };
}
function parseTargets(p, objective) {
    const renderObjective = objective !== 'aabb_err';
    const views = [];
    if (Array.isArray(p.views) && p.views.length) {
        for (const v of p.views)
            views.push(v);
    }
    else if (p.view && typeof p.view === 'object')
        views.push(p.view);
    const ref = p.ref ? String(p.ref) : '';
    const refBox = p.ref_box === undefined || p.ref_box === null ? null : p.ref_box;
    const bins = Math.max(2, Number(p.bins) || 24);
    const target = p.target ? String(p.target) : '';
    const targetSize = Array.isArray(p.target_size) ? p.target_size.slice(0, 3) : null;
    const warnings = [];
    if (renderObjective) {
        if (!views.length)
            return {
                ok: false,
                op: 'shape_search',
                stage: 'validate',
                error: objective + ' 需要 view 或 views（机位）',
                skeleton: SHAPE_SEARCH_SKELETON,
            };
        if (!ref)
            return {
                ok: false,
                op: 'shape_search',
                stage: 'validate',
                error: objective + ' 需要 ref（参考图路径）',
                skeleton: SHAPE_SEARCH_SKELETON,
            };
    }
    else {
        if (!target)
            return {
                ok: false,
                op: 'shape_search',
                stage: 'validate',
                error: 'aabb_err 需要 target（对象名）',
                skeleton: SHAPE_SEARCH_SKELETON,
            };
        if (!targetSize || targetSize.length !== 3)
            return {
                ok: false,
                op: 'shape_search',
                stage: 'validate',
                error: 'aabb_err 需要 target_size:[x,y,z]',
                skeleton: SHAPE_SEARCH_SKELETON,
            };
    }
    const applyBody = p.apply ? String(p.apply) : '';
    if (renderObjective && !applyBody && !p.measure) {
        return {
            ok: false,
            op: 'shape_search',
            stage: 'validate',
            error: '渲染类目标需要 apply：每轮把 ns["params"] 落到场景上的代码（改完记得 view_layer.update()）',
            skeleton: SHAPE_SEARCH_SKELETON,
        };
    }
    if (!applyBody && !p.measure)
        warnings.push('没有给 apply：每轮只改 ns["params"]，场景不动 —— 目标必须是纯几何量（如 aabb_err）');
    return {
        renderObjective,
        views,
        ref,
        refBox,
        bins,
        target,
        targetSize,
        applyBody,
        warnings,
    };
}
export function parseShapeSearchPayload(payload) {
    const basic = validatePayload(payload);
    if ('ok' in basic && basic.ok === false)
        return basic;
    const { p, objective, norm } = basic;
    const limits = parseLimits(p);
    const strategy = parseStrategy(p, norm, limits);
    if ('ok' in strategy && strategy.ok === false)
        return strategy;
    const targets = parseTargets(p, objective);
    if ('ok' in targets && targets.ok === false)
        return targets;
    return {
        ok: true,
        input: {
            p,
            objective,
            norm,
            limits,
            strategy: strategy,
            targets: targets,
        },
    };
}
//# sourceMappingURL=parse.js.map