import { objArg } from './deps.js';
import { errorMessage, errorField } from '../../core/json.js';
// HTTP 路由 /commands：命令清单 / 透传
export function createCommandsRoutes(E) {
    const { engine, json, leaseGate, readBody, stats } = E;
    return {
        async commands(req, res, _url, _p) {
            try {
                const c = objArg(await engine.commands());
                json(res, 200, { ok: true, ...c });
            }
            catch (e) {
                json(res, 200, {
                    ok: false,
                    error: errorMessage(e),
                    diagnosis: errorField(e, 'diagnosis') || null,
                });
            }
            return;
        },
        async cmd(req, res, _url, _p) {
            const raw = await readBody(req);
            let payload;
            try {
                payload = JSON.parse(raw);
            }
            catch (e) {
                payload = {};
            }
            const gate = leaseGate(payload);
            if (gate) {
                json(res, 409, gate);
                return;
            }
            const t0 = Date.now();
            stats.cmds++;
            try {
                const out = await engine.cmd(String(payload.name || ''), objArg(payload.params), Number(payload.timeoutMs) || 120000);
                json(res, 200, { ok: true, ms: Date.now() - t0, result: out });
            }
            catch (e) {
                stats.lastError = errorMessage(e);
                json(res, 200, {
                    ok: false,
                    ms: Date.now() - t0,
                    error: stats.lastError,
                    diagnosis: errorField(e, 'diagnosis') || null,
                });
            }
            return;
        },
    };
}
//# sourceMappingURL=commands.js.map