"use strict";

// 取消网络请求不能撤回已经完成的 Promise，因此还要用会话身份拒绝迟到的结果。
// 凭据写入共用串行队列，让退出删除排在进行中的保存之后，避免旧登录复活。
function createSession(ctx, key = "token") {
  let controller;
  let current;
  let writes = Promise.resolve();
  const isCurrent = (snapshot) => snapshot === current && !snapshot.signal.aborted;
  function renew() {
    if (controller) controller.abort();
    controller = new AbortController();
    // 局部取消和宿主停用都应终止请求；新会话不能绕过已中止的宿主生命周期。
    current = { signal: AbortSignal.any([controller.signal, ctx.signal]) };
    return current;
  }
  function enqueue(operation) {
    const result = writes.then(operation);
    // 只修复队列尾部，避免一次失败阻塞后续删除；调用者仍通过 result 收到原错误。
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
          // 保存等待期间可能取消登录：在下一次写入或删除前恢复原凭据。
          // 宿主停用后不再允许 secrets 调用，此时不能承诺仍能执行回滚。
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
