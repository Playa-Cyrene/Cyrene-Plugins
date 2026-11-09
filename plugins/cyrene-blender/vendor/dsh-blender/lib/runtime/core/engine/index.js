import { assembleEngine, createEngineContext } from './assemble.js';
/**
 * 装配引擎。参数只有 opts.address（addon 地址覆盖）。
 * 这里不实现任何业务；只负责把各个工厂接到同一个 deps 对象上，
 * 保证闭包共享同一份 addon / metrics / ledger / jobs。
 */
export function createEngine(opts = {}) {
    const ctx = createEngineContext(opts);
    const { surface, trajectory } = assembleEngine(ctx);
    return trajectory.withTrajectory(surface);
}
//# sourceMappingURL=index.js.map