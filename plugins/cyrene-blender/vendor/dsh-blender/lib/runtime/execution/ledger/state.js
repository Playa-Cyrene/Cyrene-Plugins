// 运行台账（内存 runs + 磁盘 JSONL + 可写性自证）
import path from 'node:path';
import { winToWsl } from '../../config.js';
import { WIN_TMP, WSL_TMP } from '../../paths.js';
import fs from 'node:fs';
import { errorCode, errorMessage } from '../../core/json.js';
import { PLUGIN_VERSION } from '../../core/evidence.js';
export function createLedgerStore() {
    const runs = new Map();
    const LEDGER = path.join(winToWsl(WIN_TMP), 'jobs', 'index.jsonl');
    // ---- v0.9.3（同源）：workDir 可写性 —— 旧版台账/日志写失败是**静默**的
    // （实测：workDir 落在只读挂载上时，磁盘台账一条都写不进去，而 op=list/status 只会说"没有记录"）。
    let ledgerWarn = null;
    let workdirProbeCache = null;
    function workdirProbe() {
        if (workdirProbeCache)
            return workdirProbeCache;
        const out = { wsl: WSL_TMP, win: WIN_TMP, writable: false, error: null };
        try {
            fs.mkdirSync(WSL_TMP, { recursive: true });
            const probe = path.join(WSL_TMP, '.dsh_write_probe_' + process.pid);
            fs.writeFileSync(probe, 'ok', 'utf8');
            fs.unlinkSync(probe);
            out.writable = true;
        }
        catch (e) {
            out.error = errorCode(e) || errorMessage(e).slice(0, 200);
        }
        workdirProbeCache = out;
        return out;
    }
    function ledgerAppend(rec) {
        try {
            fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
            fs.appendFileSync(LEDGER, JSON.stringify(Object.assign({ pluginVersion: PLUGIN_VERSION, at: Date.now() }, rec)) +
                String.fromCharCode(10), 'utf8');
            ledgerWarn = null;
        }
        catch (e) {
            // 静默失败是这一版要消灭的东西：记下来，让 /status 与 op=list 能说出来
            ledgerWarn = {
                path: LEDGER,
                error: errorCode(e) || errorMessage(e).slice(0, 200),
                hint: 'workDir 不可写 → 磁盘台账/日志落不下去（内存台账与产物不受影响）。改 dsh-blender.config.json 的 workDir 或 DSH_BLENDER_WORKDIR 到一个两端都可写的目录（WSL 路径也可，如 /home/<user>/dsh-blender-work）。',
            };
        }
    }
    function ledgerState() {
        const p = workdirProbe();
        return {
            path: LEDGER,
            writable: !!p.writable && !ledgerWarn,
            workDir: p,
            lastError: ledgerWarn ? ledgerWarn.error : p.writable ? null : p.error,
            hint: ledgerWarn
                ? ledgerWarn.hint
                : p.writable
                    ? null
                    : 'workDir 不可写（' +
                        String(p.error) +
                        '）：台账/日志会静默失败 —— 换一个可写 workDir（WSL 路径也行）。',
        };
    }
    function ledgerList(limit = 40) {
        try {
            const lines = fs
                .readFileSync(LEDGER, 'utf8')
                .trim()
                .split(String.fromCharCode(10))
                .filter(Boolean)
                .slice(-limit * 4);
            const by = new Map();
            for (const l of lines) {
                try {
                    const o = JSON.parse(l);
                    const id = String(o.id);
                    by.set(id, Object.assign(by.get(id) || {}, o));
                }
                catch (e) {
                    /* skip */
                }
            }
            return Array.from(by.values())
                .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))
                .slice(0, limit);
        }
        catch (e) {
            return [];
        }
    }
    return { runs, LEDGER, ledgerAppend, ledgerState, ledgerList };
}
//# sourceMappingURL=state.js.map