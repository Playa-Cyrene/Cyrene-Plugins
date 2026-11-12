import { trajRecord } from './record.js';
/** 给返回对象裹一层记录：this 仍指向原对象（内部 this.xxx() 不会重复记账） */
export function createTrajectoryWrapper(deps) {
    const TRAJ_SKIP = new Set(['metrics', 'status', 'protocol', 'sceneEpoch']);
    return function withTrajectory(obj) {
        const out = {};
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'function') {
                out[k] = function (...a) {
                    const t0 = Date.now();
                    const rawOp = a.length ? a[0] : null;
                    const opArg = typeof rawOp === 'string' || typeof rawOp === 'number' ? rawOp : null;
                    const argsArg = a.length > 1 ? a[1] : a[0];
                    const errMsg = (e) => e !== null && typeof e === 'object' && 'message' in e
                        ? e.message
                        : e;
                    const rec = (ok, err, res) => {
                        if (TRAJ_SKIP.has(k))
                            return;
                        const resRec = res !== null && typeof res === 'object' ? res : null;
                        const hinted = !!(resRec &&
                            (resRec.hint_shown ||
                                (typeof resRec.result === 'string' && resRec.result.indexOf('CMD_HINT') === 0)));
                        trajRecord(deps, k, opArg, argsArg, Date.now() - t0, ok, err, { hint_shown: hinted });
                    };
                    let r;
                    try {
                        r = v.apply(obj, a);
                    }
                    catch (e) {
                        rec(false, errMsg(e));
                        throw e;
                    }
                    if (r !== null &&
                        typeof r === 'object' &&
                        'then' in r &&
                        typeof r.then === 'function') {
                        return r.then((x) => {
                            rec(true, null, x);
                            return x;
                        }, (e) => {
                            rec(false, errMsg(e), null);
                            throw e;
                        });
                    }
                    rec(true, null, r);
                    return r;
                };
            }
            else if (v && typeof v === 'object' && !Array.isArray(v)) {
                out[k] = withTrajectory(v);
            }
            else {
                out[k] = v;
            }
        }
        return out;
    };
}
//# sourceMappingURL=read.js.map