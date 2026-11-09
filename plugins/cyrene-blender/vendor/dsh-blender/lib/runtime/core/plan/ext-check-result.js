/** open3d result: the checker's own JSON plus the routing trace. */
export function open3dResult(parsed, run) {
    return Object.assign({ tool: 'open3d', used: run.used, tried: run.tried }, parsed || {});
}
//# sourceMappingURL=ext-check-result.js.map
