import { handleHost } from './routes.js';
export function createHostRoutes(E) {
    return {
        async host(req, res, url, p) {
            try {
                await handleHost(E, req, res, url, p);
            }
            catch (e) {
                try {
                    E.hostJson(res, 500, { ok: false, error: E.hostErrText(e) }, req.headers.origin || null);
                }
                catch (e2) {
                    try {
                        res.end();
                    }
                    catch (e3) {
                        /* 已经断了就算了 */
                    }
                }
            }
            return;
        },
    };
}
//# sourceMappingURL=index.js.map