/** glTF-Validator result: bounded message list, validator info and pass rule. */
export function gltfResult(parsed, winPath, run) {
    const iss = ((parsed && parsed.issues) || {});
    const rawMsgs = Array.isArray(iss.messages) ? iss.messages : [];
    const msgs = rawMsgs.slice(0, 12).map((m) => {
        const mm = m;
        return {
            code: mm.code,
            severity: mm.severity,
            pointer: mm.pointer,
            message: String(mm.message || '').slice(0, 160),
        };
    });
    return {
        ok: Number(iss.numErrors) === 0 && !!(parsed && parsed.issues),
        tool: 'gltf-validator',
        validatorVersion: parsed && parsed.validatorVersion,
        path: winPath,
        errors: iss.numErrors,
        warnings: iss.numWarnings,
        infos: iss.numInfos,
        hints: iss.numHints,
        messages: msgs,
        used: run.used,
        info: parsed && parsed.info
            ? (() => {
                const pi = parsed.info;
                return {
                    version: pi.version,
                    generator: pi.generator,
                    drawCallCount: pi.drawCallCount,
                    totalVertexCount: pi.totalVertexCount,
                    totalTriangleCount: pi.totalTriangleCount,
                    maxUVs: pi.maxUVs,
                };
            })()
            : null,
        note: '规则码（messages[].code）可直接写进 gate spec 的 pass_if；numErrors==0 才算过',
    };
}
/** open3d result: the checker's own JSON plus the routing trace. */
export function open3dResult(parsed, run) {
    return Object.assign({ tool: 'open3d', used: run.used, tried: run.tried }, parsed || {});
}
//# sourceMappingURL=ext-check-result.js.map