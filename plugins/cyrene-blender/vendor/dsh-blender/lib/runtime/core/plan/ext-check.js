import fs from 'node:fs';
import path from 'node:path';
import { PY_ROOT } from '../../paths.js';
import { extCandidates, extInstallHint, runExtCandidates, toWslPath, } from './ext-check-candidates.js';
import { open3dResult } from './ext-check-result.js';
const PACKAGE_ROOT = path.dirname(PY_ROOT);
/** 解析随包提供的外部网格检查脚本位置。 */
export function resolveExtPaths() {
    const extDir = path.join(PACKAGE_ROOT, 'runtime', 'ext');
    const open3dRunner = path.join(PY_ROOT, 'py', 'export', 'open3d_check.py');
    return {
        extDir,
        open3dRunner,
        open3dRunnerExists: fs.existsSync(open3dRunner),
    };
}
/** 外部网格检查在本机执行，不往返调用 Blender。 */
export async function extMeshCheckOp(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const cp = await import('node:child_process');
    const { extDir, open3dRunner } = resolveExtPaths();
    const winPath = String(p.path || '');
    const wslPath = toWslPath(winPath);
    const runner = open3dRunner;
    const isWin = process.platform === 'win32';
    const cands = extCandidates({ extDir, runner, winPath, wslPath, isWin });
    const run = runExtCandidates(cp, cands);
    if (!run.raw)
        return extInstallHint({ extDir, winPath, isWin, tried: run.tried });
    let parsed;
    try {
        parsed = JSON.parse(run.raw);
    }
    catch (e) {
        parsed = { parse_error: String(e).slice(0, 120), raw: run.raw.slice(0, 400) };
    }
    return open3dResult(parsed, run);
}
//# sourceMappingURL=ext-check.js.map
