// 作业脚本构建入口（拆分）：参数 / 前导 / 写盘
import { prepareJobArgs } from './args.js';
import { buildJobParts, finalizeJobArgs } from './preload.js';
export function buildJobScript(E, opts = {}) {
    const a = prepareJobArgs(E, opts);
    const built = buildJobParts(E, opts, a);
    finalizeJobArgs(a, built, opts);
    return {
        ...a,
        sp: built.sp,
        timeoutMs: built.timeoutMs,
    };
}
//# sourceMappingURL=index.js.map