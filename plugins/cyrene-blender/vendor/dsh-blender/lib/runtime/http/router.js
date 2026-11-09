import { json } from './response.js';
import { errorDetail } from '../core/json.js';
import { callerFromRequest, runWithCaller } from './caller.js';
export function createRouter(E) {
    const routes = E.routes;
    return async function router(req, res) {
        if (req.headers.origin || req.headers['sec-fetch-site'] || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''))) {
            json(res, 403, { ok: false, error: 'browser_or_non_loopback_request_denied' });
            return;
        }
        const url = new URL(req.url || '/', 'http://' + E.HOST + ':' + String(E.PORT));
        const p = url.pathname;
        E.bump(p);
        try {
            for (const r of routes) {
                if (r.method && req.method !== r.method)
                    continue;
                const matched = r.paths
                    ? r.paths.indexOf(p) >= 0
                    : p === r.exact || (r.prefix && p.startsWith(r.prefix));
                if (!matched)
                    continue;
                await runWithCaller(callerFromRequest(req), () => r.fn(req, res, url, p));
                return;
            }
            json(res, 404, { ok: false, error: 'not found', path: p });
        }
        catch (e) {
            json(res, 500, { ok: false, error: errorDetail(e) });
        }
    };
}
//# sourceMappingURL=router.js.map