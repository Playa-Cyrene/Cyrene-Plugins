import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { headlessLogNames } from '../../file_guard.js';
import { wslToWin } from '../../config.js';
import { makeStageScanner } from '../../core/progress.js';
import { errorMessage } from '../../core/json.js';
import { BLENDER_EXE } from '../../paths.js';
/**
 * Open the per-run stdout/stderr logs. Returning null streams is intentional: a read-only
 * outdir must not fail the run, it only loses live logging (the caller has a fallback).
 */
export function createHeadlessLogStreams(logDirWsl, t0, runId) {
    const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
    let logs;
    let soStream = null;
    let seStream = null;
    try {
        fs.mkdirSync(logDirWsl, { recursive: true });
        const logNames = headlessLogNames(stamp, runId); // F-09：同毫秒两个 run 不再互写同一个 log
        const soPath = path.join(logDirWsl, logNames.stdout);
        const sePath = path.join(logDirWsl, logNames.stderr);
        soStream = fs.createWriteStream(soPath);
        seStream = fs.createWriteStream(sePath);
        logs = {
            stdout: wslToWin(soPath),
            stderr: wslToWin(sePath),
            stdoutWsl: soPath,
            stderrWsl: sePath,
        };
    }
    catch (e) {
        logs = null;
    }
    return { logs, soStream, seStream, stamp };
}
/**
 * Spawn Blender and capture its streams until close. The function never rejects for a
 * spawn error: it returns spawnErr so the caller can classify it into a receipt.
 */
export async function spawnHeadless(args, childEnv, timeoutMs, runRec, streams) {
    return new Promise((resolve) => {
        let so = '', se = '';
        let exitCode = null;
        let signal = null;
        let spawnErr = null;
        let timedOut = false;
        const CAP = 262144;
        let child;
        const { soStream, seStream } = streams;
        try {
            child = spawn(BLENDER_EXE, args, {
                env: childEnv,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            runRec.child = child;
            runRec.pid = child.pid;
        }
        catch (e) {
            return resolve({
                so: so,
                se: se,
                exitCode: null,
                signal: null,
                spawnErr: e instanceof Error ? e : new Error(errorMessage(e)),
                timedOut: false,
            });
        }
        // v0.9.3：stage 心跳扫描 + 增量落盘（run 运行期间 op=status.stage / 日志就有内容）
        const scanOut = makeStageScanner(runRec), scanErr = makeStageScanner(runRec);
        const push = (buf, which) => {
            const t = buf.toString('utf8');
            if (which === 'o') {
                so += t;
                if (so.length > CAP)
                    so = so.slice(-CAP);
                scanOut(t);
                try {
                    if (soStream)
                        soStream.write(t);
                }
                catch (e) {
                    /* ignore */
                }
            }
            else {
                se += t;
                if (se.length > CAP)
                    se = se.slice(-CAP);
                scanErr(t);
                try {
                    if (seStream)
                        seStream.write(t);
                }
                catch (e) {
                    /* ignore */
                }
            }
        };
        const proc = child;
        if (!proc)
            return resolve({
                so: so,
                se: se,
                exitCode: null,
                signal: null,
                spawnErr: new Error('spawn 未返回进程'),
                timedOut: false,
            });
        proc.stdout?.on('data', (d) => push(d, 'o'));
        proc.stderr?.on('data', (d) => push(d, 'e'));
        proc.on('error', (e) => {
            spawnErr = e;
        });
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill('SIGKILL');
            }
            catch (e) {
                /* ignore */
            }
        }, timeoutMs);
        proc.on('close', (code, sig) => {
            clearTimeout(timer);
            exitCode = code;
            signal = sig;
            resolve({
                so: so,
                se: se,
                exitCode: exitCode,
                signal: signal,
                spawnErr: spawnErr,
                timedOut: timedOut,
            });
        });
    });
}
//# sourceMappingURL=process.js.map