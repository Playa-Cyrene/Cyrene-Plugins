"use strict";
async function readStatus(invoke) {
  try {
    const [state, config] = await Promise.all([invoke("runtime-state:get"), invoke("model-config:get")]);
    return { available: true, enabled: config?.runtimeSync === "local" || config?.runtimeSync === "llm", connected: config?.connected === true, status: typeof state?.status === "string" ? state.status.slice(0, 30) : "", feeling: typeof state?.feeling === "string" ? state.feeling.slice(0, 30) : "" };
  } catch { return { available: false, enabled: false, connected: false, status: "", feeling: "" }; }
}
module.exports = { readStatus };
