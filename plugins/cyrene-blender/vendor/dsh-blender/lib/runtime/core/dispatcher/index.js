import { prepareEvidencePayload, routeMainPlanOps, routeModulePlanOps } from './plan-call.js';
import { routeExtRouting } from './ext-routing.js';
async function routePlanCall(E, op, payload) {
    const o = String(op || 'status');
    const withEvidence = await prepareEvidencePayload(E, o, payload);
    const main = await routeMainPlanOps(E, o, withEvidence);
    if (main.matched)
        return main.result;
    const moduleRoute = await routeModulePlanOps(E, o, withEvidence);
    if (moduleRoute.matched)
        return moduleRoute.result;
    const ext = await routeExtRouting(E, o, withEvidence);
    if (!ext.matched)
        return { ok: false, op: o, error: 'no route for ' + o };
    return ext.result;
}
export function createPlanCallInner(E) {
    return {
        planCallInner: (op, payload) => routePlanCall(E, op, payload),
    };
}
//# sourceMappingURL=index.js.map