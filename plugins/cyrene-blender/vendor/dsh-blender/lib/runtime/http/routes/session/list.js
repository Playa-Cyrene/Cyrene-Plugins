import { currentCaller } from '../../caller.js';
export function createWhoHandler(E) {
    const { PORT, describeConfig, engine, json, leaseView, reqCounts, sessionRegistry, stats } = E;
    return async function who(req, res, _url, _p) {
        const caller = currentCaller();
        json(res, 200, {
            ok: true,
            sessions: !sessionRegistry
                ? []
                : caller
                    ? sessionRegistry.listFor(caller)
                    : sessionRegistry.list(),
            lease: leaseView(),
            metrics: engine.metrics(),
            stats: stats,
            config: describeConfig({ httpPort: PORT }),
            requests: Object.fromEntries(reqCounts),
        });
        return;
    };
}
//# sourceMappingURL=list.js.map