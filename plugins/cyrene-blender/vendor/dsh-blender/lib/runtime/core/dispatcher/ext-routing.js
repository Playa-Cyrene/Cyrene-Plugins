import { EXT_ROUTES } from './routes.generated.js';
import { handleRoute, hit, miss, routeMatches } from './plan-call.js';
/** EXT 表按 config/routing.json 的顺序匹配：21 个模块前缀 → gui_ → render_ → contract 兜底。 */
export async function routeExtRouting(E, o, payload) {
    for (const route of EXT_ROUTES) {
        if (!routeMatches(route, o))
            continue;
        return hit(handleRoute(E, route, o, payload));
    }
    return miss();
}
//# sourceMappingURL=ext-routing.js.map