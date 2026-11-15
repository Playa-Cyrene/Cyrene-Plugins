// 运行台账入口：内存 store + 磁盘对账组合
import { createLedgerStore } from './state.js';
import { createLedgerRecover } from './recover.js';
export function createLedger(_E) {
    const store = createLedgerStore();
    const recover = createLedgerRecover();
    const api = {
        runs: store.runs,
        LEDGER: store.LEDGER,
        ledgerAppend: store.ledgerAppend,
        ledgerState: store.ledgerState,
        ledgerList: store.ledgerList,
        runSnapshot: recover.runSnapshot,
        reconcileLedger: recover.reconcileLedger,
    };
    return api;
}
//# sourceMappingURL=index.js.map