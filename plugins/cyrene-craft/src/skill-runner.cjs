"use strict";

/**
 * 技能执行器（L1 里层出口）
 *
 * 职责：
 *   1. 把技能步骤按参数展开
 *   2. 通过 bridge 的 sequence 命令一次性执行
 *   3. 更新统计
 *   4. 失败时给出明确的「建议回退」信号，让模型改走原始多步流程
 *
 * 为什么走 sequence：
 *   子进程已有 doSequence 直接调 dispatch(cmd, args)，
 *   是技能执行的现成锚点。这里不重写引擎，只负责展开与统计。
 *
 * 设计纪律：
 *   - 执行前先检查技能是否存在、步骤是否为空
 *   - 失败不吞掉细节，把哪一步失败、错误是什么如实返回
 *   - 统计更新失败不影响技能本身的执行结果
 */

/** sequence 单次最多几步，防止一个坏技能把子进程拖死 */
const MAX_STEPS = 60;

class SkillRunner {
  /**
   * @param {object} opts
   * @param {import("./skill-store.cjs").SkillStore} opts.store
   * @param {(cmd:string, args:object, kind?:string)=>Promise<any>} opts.request
   *        桥接请求函数，签名与 bridge.request 一致
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    this.store = opts.store;
    this.request = opts.request;
    this.log = opts.log || (() => {});
  }

  /**
   * 执行一个技能。
   *
   * @param {string} name 技能名
   * @param {object} overrides 参数覆盖
   * @param {object} opts
   * @param {(steps:Array)=>Promise<any>} [opts.runSteps] 自定义执行器（测试用）
   * @returns {Promise<object>} 结构化结果
   */
  async run(name, overrides = {}, opts = {}) {
    const skill = this.store.get(name);
    if (!skill) {
      return {
        ok: false,
        name,
        error: `技能不存在：${name}`,
        fallback: true,
        reason: "技能未找到，请改用原始多步流程",
      };
    }

    if (!skill.steps.length) {
      return {
        ok: false,
        name,
        error: `技能 ${name} 没有任何步骤`,
        fallback: true,
        reason: "技能为空，请重新编译",
      };
    }

    if (skill.steps.length > MAX_STEPS) {
      return {
        ok: false,
        name,
        error: `技能步骤过多（${skill.steps.length}），上限 ${MAX_STEPS}`,
        fallback: true,
        reason: "技能过大，请拆分",
      };
    }

    // 延迟加载，避免循环依赖
    const { resolveSteps } = require("./skill-compiler.cjs");
    const steps = resolveSteps(skill.steps, skill.params, overrides);

    const startedAt = Date.now();
    let result;
    let ok = false;

    try {
      if (typeof opts.runSteps === "function") {
        result = await opts.runSteps(steps);
      } else {
        result = await this.request("sequence", { steps }, "sequence");
      }
      // sequence 返回 { total, done, failed, results }
      ok = Boolean(result && Number(result.failed) === 0 && Number(result.done) > 0);
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      // 统计失败不影响错误返回
      try {
        this.store.recordRun(name, false, durationMs);
      } catch (err) {
        this.log(`[skill] 统计更新失败：${err.message}`);
      }
      return {
        ok: false,
        name,
        error: e && e.message ? e.message : String(e),
        durationMs,
        fallback: true,
        reason: "技能执行抛错，建议回退原始多步流程",
      };
    }

    const durationMs = Date.now() - startedAt;

    // 失败细节留给 L2 归因：第几步、哪条命令、什么错。只在失败时记。
    const failureDetail = ok
      ? null
      : (() => {
          const rows = Array.isArray(result && result.results) ? result.results : [];
          const firstBad = rows.find((r) => r && r.ok === false);
          if (firstBad) {
            return {
              error: firstBad.error || "步骤失败但没有错误信息",
              step: Number(firstBad.index),
              cmd: firstBad.cmd,
            };
          }
          return { error: "整体判定失败但没定位到具体步骤", step: null, cmd: null };
        })();

    try {
      this.store.recordRun(name, ok, durationMs, failureDetail);
    } catch (e) {
      this.log(`[skill] 统计更新失败：${e.message}`);
    }

    return {
      ok,
      name,
      durationMs,
      steps: steps.length,
      total: result && result.total,
      done: result && result.done,
      failed: result && result.failed,
      results: result && result.results,
      fallback: !ok,
      reason: ok ? null : "技能部分步骤失败，建议检查参数后回退原始流程",
    };
  }

  /**
   * 把执行结果渲染成给模型看的短文本。
   * 长度可控，不把整包 results 塞进上下文。
   */
  format(result) {
    if (!result) return "技能执行结果为空。";

    if (!result.ok) {
      const head = `技能 ${result.name} 执行失败：${result.error || result.reason || "未知原因"}`;
      const hint = result.fallback ? "\n建议改用原始多步流程完成这次任务。" : "";
      return head + hint;
    }

    const rate = result.done != null && result.total ? `成功 ${result.done}/${result.total} 步` : `${result.steps} 步`;
    const lines = [`技能 ${result.name} 执行成功：${rate}，耗时 ${Math.round(result.durationMs / 1000)} 秒。`];

    // 只列出失败的步骤，成功的不啰嗦
    const fails = Array.isArray(result.results) ? result.results.filter((r) => r && r.ok === false) : [];
    for (const f of fails.slice(0, 3)) {
      lines.push(`✘ 第 ${Number(f.index) + 1} 步 ${f.cmd}：${f.error}`);
    }

    return lines.join("\n");
  }
}

module.exports = { SkillRunner, MAX_STEPS };
