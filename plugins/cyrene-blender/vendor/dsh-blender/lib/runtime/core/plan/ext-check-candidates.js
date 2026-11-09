// ext-check candidates: WSL path mapping, interpreter routing and the spawn loop
// (continuation of runtime/core/plan/ext-check.ts).
import path from 'node:path';
import { errorMessage } from '../json.js';
/** Windows drive path -> WSL /mnt path; anything else is passed through. */
export function toWslPath(winPath) {
    return /^[A-Za-z]:[\\/]/.test(winPath)
        ? '/mnt/' + winPath[0].toLowerCase() + winPath.slice(2).replace(/\\/g, '/')
        : winPath;
}
/**
 * Candidate command chains. The backend may run in WSL while node runs on Windows
 * (or the other way round), so the native path comes first and the alternate
 * representation is the fallback; WSL always gets the WSL path.
 */
export function extCandidates(input) {
    const { op, extDir, runner, winPath, wslPath, isWin } = input;
    const first = isWin ? winPath : wslPath;
    const second = isWin ? wslPath : winPath;
    if (op === 'gltf_validate') {
        return [
            ['node', runner, first],
            ['node', runner, second],
            ['wsl.exe', '-e', 'node', runner, wslPath],
        ];
    }
    const venvBin = path.join(extDir, 'venv', 'bin', 'python');
    return [
        [venvBin, runner, first],
        [venvBin, runner, second],
        ['wsl.exe', '-e', venvBin, runner, wslPath],
        [path.join(extDir, 'venv', 'Scripts', 'python.exe'), runner, winPath],
    ];
}
/** Run candidates until one prints a RAW/EXT line; no candidate => raw=null. */
export function runExtCandidates(cp, cands) {
    const tried = [];
    let raw = null;
    let used = null;
    for (const c of cands) {
        try {
            const r = cp.spawnSync(c[0], c.slice(1), {
                encoding: 'utf8',
                timeout: 120000,
                windowsHide: true,
            });
            const out = String((r.stdout || '') + (r.stderr || ''));
            tried.push({
                cmd: c.slice(0, 2).join(' '),
                status: r.status,
                err: r.error && r.error.message ? String(r.error.message).slice(0, 80) : null,
            });
            const m = out.match(/^(RAW|EXT) (.+)$/m);
            if (m) {
                raw = m[2];
                used = c.slice(0, 2).join(' ');
                break;
            }
        }
        catch (e) {
            tried.push({ cmd: c.slice(0, 2).join(' '), err: String(errorMessage(e)).slice(0, 80) });
        }
    }
    return { raw, used, tried };
}
/**
 * Actionable local-install hint. It must stay a directly pasteable absolute path:
 * a relative 'runtime/ext/venv' hint re-nests when the user happens to run it in
 * runtime/ext (field report).
 */
export function extInstallHint(input) {
    const { op, extDir, winPath, isWin, tried } = input;
    const extAbs = path.resolve(extDir);
    const installCmd = op === 'gltf_validate'
        ? 'cd ' + (isWin ? '/d "' : '"') + extAbs + '" && npm i gltf-validator'
        : isWin
            ? 'cd /d "' + extAbs + '" && py -3 -m venv venv && venv\\Scripts\\pip install open3d'
            : 'cd "' + extAbs + '" && python3 -m venv venv && venv/bin/pip install open3d';
    return {
        ok: false,
        installed: false,
        path: winPath,
        tried: tried,
        install: installCmd,
        hint: '依赖必须装在 ' +
            extAbs +
            ' 下（上面那条自带绝对路径与 cd，在哪个目录执行都一样）；' +
            '两种解释器都试过了 —— 后端在 Windows 时会用 wsl.exe 调 Linux venv',
    };
}
//# sourceMappingURL=ext-check-candidates.js.map