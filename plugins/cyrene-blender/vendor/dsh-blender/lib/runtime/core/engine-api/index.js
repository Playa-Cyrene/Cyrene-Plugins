import { createMetricsApi } from './metrics.js';
import { createDoctorApi } from './doctor.js';
import { createActApi } from './act.js';
import { createLoopApi } from './loop.js';
import { createFrameApi } from './frame.js';
import { createViewApi } from './view.js';
import { createHostApi } from './host.js';
export function createEngineApi(E) {
    return {
        ...createMetricsApi(E),
        ...createDoctorApi(E),
        ...createActApi(E),
        ...createLoopApi(E),
        ...createFrameApi(E),
        ...createViewApi(E),
        ...createHostApi(E),
    };
}
//# sourceMappingURL=index.js.map