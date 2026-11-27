/* Shared, bounded KaTeX rendering for the board, dialog, and review drawer. */
(function (root) {
  "use strict";

  const LIMIT = Object.freeze({
    formulaChars: 2048,
    commands: 128,
    nesting: 32,
    htmlChars: 128 * 1024,
    elements: 2048,
    calls: 256,
    inputChars: 16384,
    totalHtmlChars: 768 * 1024,
    totalElements: 12000,
    sizeEm: 64,
  });
  const ASSIGNMENTS = new Set([
    "def", "gdef", "edef", "xdef", "let", "futurelet", "global", "long",
    "globallong", "globallet", "globalfuture", "newcommand", "renewcommand",
    "providecommand",
  ]);
  const UNIT_IN_EM = Object.freeze({
    em: 1, ex: 0.5, px: 1 / 16, pt: 1 / 12, pc: 1, in: 6,
    cm: 6 / 2.54, mm: 6 / 25.4, mu: 1 / 18,
  });
  const NUMBER_WITH_UNIT = /([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(em|ex|px|pt|pc|in|cm|mm|mu|%)(?![\w-])/gi;

  function createBudget() {
    return { calls: 0, inputChars: 0, htmlChars: 0, elements: 0 };
  }

  function inputIsSafe(tex) {
    if (tex.length > LIMIT.formulaChars) return false;
    let depth = 0;
    let commands = 0;
    for (let i = 0; i < tex.length; i += 1) {
      const char = tex[i];
      if (char === "\\") {
        commands += 1;
        if (commands > LIMIT.commands) return false;
        let name = "";
        while (i + 1 < tex.length && /[A-Za-z@]/.test(tex[i + 1])) {
          name += tex[++i];
        }
        if (ASSIGNMENTS.has(name)) return false;
        if (!name) i += 1; // escaped brace or control symbol
      } else if (char === "{") {
        depth += 1;
        if (depth > LIMIT.nesting) return false;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
    return true;
  }

  function oversizedLayout(html) {
    // KaTeX's maxSize clamps positive dimensions, but negative \kern and
    // \raisebox can still emit huge margins/offsets. Inspect its generated CSS
    // before the HTML reaches the DOM. KaTeX emits double-quoted attributes.
    const styles = /\bstyle="([^"]*)"/gi;
    let match;
    while ((match = styles.exec(html)) !== null) {
      const value = match[1];
      if (/\b(?:NaN|Infinity)\b/i.test(value)) return true;
      NUMBER_WITH_UNIT.lastIndex = 0;
      let size;
      while ((size = NUMBER_WITH_UNIT.exec(value)) !== null) {
        const number = Number(size[1]);
        const unit = size[2].toLowerCase();
        const inEm = unit === "%" ? number / 100 : number * UNIT_IN_EM[unit];
        if (!Number.isFinite(inEm) || Math.abs(inEm) > LIMIT.sizeEm) return true;
      }
    }
    return false;
  }

  function countElements(html) {
    const tags = html.match(/<[A-Za-z][^>]*>/g);
    return tags ? tags.length : 0;
  }

  function render(katex, tex, displayMode, budget) {
    if (!katex || typeof katex.renderToString !== "function") return { reason: "unavailable" };
    if (!inputIsSafe(tex)) return { reason: "input-limit" };
    if (budget.calls >= LIMIT.calls || budget.inputChars + tex.length > LIMIT.inputChars ||
        budget.htmlChars >= LIMIT.totalHtmlChars || budget.elements >= LIMIT.totalElements) {
      return { reason: "batch-limit" };
    }
    budget.calls += 1;
    budget.inputChars += tex.length;

    // A new object per formula prevents definitions leaking between formulas.
    // Reject assignment primitives again at KaTeX's expander, even if a future
    // syntax manages to evade the simple source scan above.
    const macros = {};
    for (const command of ASSIGNMENTS) {
      macros["\\" + command] = () => { throw new Error("Macro assignment blocked"); };
    }
    let html;
    try {
      html = katex.renderToString(tex, {
        displayMode: Boolean(displayMode),
        throwOnError: false,
        strict: false,
        trust: false,
        output: "html",
        maxExpand: 64,
        maxSize: 20,
        macros,
        globalGroup: false,
      });
    } catch (_err) {
      return { reason: "render-error" };
    }
    if (typeof html !== "string") return { reason: "render-error" };
    const elements = countElements(html);
    budget.htmlChars += html.length;
    budget.elements += elements;
    if (html.length > LIMIT.htmlChars || elements > LIMIT.elements ||
        budget.htmlChars > LIMIT.totalHtmlChars || budget.elements > LIMIT.totalElements) {
      return { reason: "output-limit" };
    }
    if (oversizedLayout(html)) return { reason: "layout-limit" };
    return { html };
  }

  const api = { createBudget, render, LIMIT };
  root.LessonMath = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" ? window : globalThis);
