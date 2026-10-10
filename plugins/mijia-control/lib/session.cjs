"use strict";

// Each login/logout boundary invalidates both network requests and their results.
// Serializing credential writes also orders logout behind an in-flight save.
function createSession(ctx, key = "token") {
  let controller;
  let current;
  let writes = Promise.resolve();
  const isCurrent = (snapshot) => snapshot === current && !snapshot.signal.aborted;
  function renew() {
    if (controller) controller.abort();
    controller = new AbortController();
    current = { signal: AbortSignal.any([controller.signal, ctx.signal]) };
    return current;
  }
  function enqueue(operation) {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }
  renew();
  return {
    capture: () => current,
    isCurrent,
    renew,
    stop: () => controller.abort(),
    drain: () => writes,
    save(token, snapshot) {
      return enqueue(async () => {
        if (!isCurrent(snapshot)) return false;
        const secrets = ctx.deps.secrets;
        const previous = await secrets.get(key);
        if (!isCurrent(snapshot)) return false;
        await secrets.set(key, JSON.stringify(token));
        if (!isCurrent(snapshot)) {
          // Cancel/logout while a save was awaiting disk: restore before the
          // next queued write/delete. A stopped host disallows secrets calls.
          if (!ctx.signal.aborted) {
            if (previous === undefined || previous === null) await secrets.delete(key);
            else await secrets.set(key, previous);
          }
          return false;
        }
        return true;
      });
    },
    clear: () => enqueue(() => ctx.deps.secrets.delete(key)),
  };
}

module.exports = { createSession };
