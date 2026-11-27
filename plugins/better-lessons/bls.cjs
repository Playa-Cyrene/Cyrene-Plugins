/**
 * BLS（Better Lesson Script）—— 剧本文本格式的解析器：文本 → IR + warnings。
 *
 * 语法规范见 DESIGN.md §4.2，校验规则见 §4.5，IR 形状见 §4.4。
 *
 * 语法速查（全文 4 个关键字：meta / say / board / board 的两种编辑形态）：
 *
 *   meta title=<板书标题>                 ← 单行，可选，整段最多一次
 *   say <<                                ← 块：按行拆成多个 say step
 *   每行一句对白
 *   >>
 *   board <<                              ← 块：整块算一个 boardBlock step
 *   整块 markdown 板书
 *   >>
 *   board replace <旧内容> -> <新内容>      ← 单行：内容匹配替换
 *   board clear                           ← 单行：清空
 *
 * 词法要点（易错）：
 *   · BLS 没有注释语法，块外的散行是"无法识别的行"，跳过并告警；
 *   · 块内不识别 BLS 语法，`#` 就是 markdown 标题；块内空行保留；
 *   · 块内只去掉公共缩进；`>>` 之后不允许有其他字符；
 *   · say 块的空行不产生 step，行首尾空白裁掉；
 *   · `->` 是正文里唯一的分隔符，正文中禁止出现 ASCII 箭头（要写 →）。
 *
 * 关键不变式（决定了本文件不需要外部黑板入参）：
 *   **每一层都从一块空黑板开始演**。换层时过渡帧负责清板（§7.4 / §8.4），
 *   所以校验 `board replace` 时只需在本层内部累积的草稿板上做，跨层引用一律 miss。
 */
const boardApi = require("./board.cjs");

/** 硬上限（§4.2）。超出即拒绝整段剧本，不做静默截断。 */
const LIMITS = {
  lineChars: 2000,
  stepsPerLayer: 200,
  scriptChars: 48000,
};

/** 块起始行。两种块都用 `>>` 收尾。 */
const BLOCK_STARTERS = { "say <<": "say", "board <<": "board" };
const BLOCK_TERMINATOR = ">>";
/** 单行指令。 */
const META_RE = /^meta\s+title=(.+)$/;
const BOARD_REPLACE_RE = /^board\s+replace\s+(.+?)\s*->\s*(.*)$/;
const BOARD_CLEAR_RE = /^board\s+clear$/;
const BOARD_ANY_RE = /^board\b/;
const BOARD_REPLACE_PREFIX_RE = /^board\s+replace\b/;

/** 去掉块内容的公共缩进；空行原样保留（markdown 需要它分段）。 */
function stripCommonIndent(lines) {
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.replace(/^[ \t]+/, "").length;
    if (indent < min) min = indent;
    if (min === 0) break;
  }
  if (!Number.isFinite(min) || min === 0) return lines.slice();
  return lines.map((line) => (line.trim() ? line.slice(min) : ""));
}

/** 告警文案里的片段预览。 */
function preview(text, max = 24) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 解析剧本正文。
 *
 * @param {string} source BLS 正文
 * @returns {{ steps: Array<object>, warnings: Array<{line:number,message:string}>, title: string }}
 * @throws {Error} 超限、或有效 step 数为 0 时
 */
function parseBLS(source) {
  const text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
  if (text.length > LIMITS.scriptChars) {
    throw new Error(`剧本超过 ${LIMITS.scriptChars} 字符上限（当前 ${text.length}）`);
  }

  const warnings = [];
  const steps = [];
  const warn = (line, message) => warnings.push({ line, message });
  /** 本层自己的草稿板：每层从空板开始，所以不需要外部黑板入参。 */
  const draft = boardApi.createBoard();

  let title = "";
  let sawMeta = false;
  let block = null; // { kind: "say" | "board", startLine: number, lines: string[] }

  function pushStep(step, lineNo) {
    steps.push(step);
    if (steps.length > LIMITS.stepsPerLayer) {
      throw new Error(
        `单层超过 ${LIMITS.stepsPerLayer} 步上限（第 ${lineNo} 行已到第 ${steps.length} 步）。` +
          `请把这个剧本拆成多个文件，先后推送。`,
      );
    }
  }

  function closeBlock() {
    const current = block;
    block = null;
    if (!current) return;

    if (current.kind === "say") {
      let emitted = 0;
      current.lines.forEach((raw, offset) => {
        const content = raw.trim();
        if (!content) return; // say 块的空行不产生 step
        emitSay(content, current.startLine + 1 + offset);
        emitted += 1;
      });
      if (emitted === 0) warn(current.startLine, "say 块内没有有效行，未产生任何 step");
      return;
    }

    const body = stripCommonIndent(current.lines);
    boardApi.apply({ kind: "boardBlock", lines: body }, draft);
    pushStep({ kind: "boardBlock", lines: body }, current.startLine);
  }

  function emitSay(content, lineNo) {
    if (content.includes("->")) warn(lineNo, "正文里不要写 ASCII 箭头 ->，要写 →");
    pushStep({ kind: "say", text: content }, lineNo);
  }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (raw.length > LIMITS.lineChars) {
      warn(lineNo, `单行超过 ${LIMITS.lineChars} 字符，本行已跳过`);
      continue;
    }

    // ---- 块内 ----
    if (block) {
      if (trimmed === BLOCK_TERMINATOR) {
        closeBlock();
        continue;
      }
      if (trimmed.startsWith(BLOCK_TERMINATOR)) {
        warn(
          lineNo,
          "`>>` 之后不允许有其他字符：本行按块内容处理；若要写 markdown 嵌套引用请改用 `> >`",
        );
      }
      block.lines.push(raw);
      continue;
    }

    // ---- 块外 ----
    if (!trimmed) continue;

    const starter = BLOCK_STARTERS[trimmed];
    if (starter) {
      block = { kind: starter, startLine: lineNo, lines: [] };
      continue;
    }

    const metaHit = META_RE.exec(trimmed);
    if (metaHit) {
      if (sawMeta) warn(lineNo, "meta 只能出现一次，本行已忽略");
      else {
        title = metaHit[1].trim();
        sawMeta = true;
      }
      continue;
    }

    if (BOARD_CLEAR_RE.test(trimmed)) {
      boardApi.apply({ kind: "boardClear" }, draft);
      pushStep({ kind: "boardClear" }, lineNo);
      continue;
    }

    if (BOARD_ANY_RE.test(trimmed)) {
      const replaceHit = BOARD_REPLACE_RE.exec(trimmed);
      if (replaceHit && replaceHit[1].trim()) {
        const from = replaceHit[1];
        const to = replaceHit[2];
        if (to.includes("->")) warn(lineNo, "替换内容里不要写 ASCII 箭头 ->，要写 →");

        const hits = boardApi.boardText(draft).split(from).length - 1;
        if (hits === 0) {
          warn(lineNo, `board replace 的旧内容在板书里找不到，本步已忽略：${preview(from)}`);
          continue;
        }
        if (hits > 1) {
          warn(lineNo, `旧内容命中 ${hits} 处，只替换第一处；建议引用更长的上下文以唯一定位`);
        }
        boardApi.apply({ kind: "boardReplace", from, to }, draft);
        pushStep({ kind: "boardReplace", from, to }, lineNo);
        continue;
      }

      if (BOARD_REPLACE_PREFIX_RE.test(trimmed)) {
        warn(
          lineNo,
          replaceHit
            ? "board replace 的 <旧内容> 不能为空，本行已跳过"
            : "board replace 缺少 `->` 分隔符，本行已跳过（写法：board replace <旧内容> -> <新内容>）",
        );
        continue;
      }

      warn(lineNo, `无法识别的行，本行已跳过：${preview(trimmed)}`);
      continue;
    }

    warn(lineNo, `无法识别的行，本行已跳过：${preview(trimmed)}`);
  }

  if (block) {
    warn(block.startLine, `\`${block.kind} <<\` 没有配对的 \`>>\`，该块及其后内容已全部丢弃`);
    block = null;
  }

  if (!steps.length) {
    const detail = warnings.length
      ? `前几条问题：\n${warnings.slice(0, 3).map((w) => `  第 ${w.line} 行：${w.message}`).join("\n")}`
      : "剧本里没有任何有效指令";
    throw new Error(`这份剧本解析不出任何可演出的内容，未推送。${detail}`);
  }

  return { steps, warnings, title };
}

/** 供窗口显示层标题：meta 之外的第二选择（§4.2）。 */
function deriveTitle(steps, fallback) {
  for (const step of steps) {
    if (step.kind !== "boardBlock") continue;
    for (const line of step.lines) {
      const hit = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (hit) return hit[1];
    }
  }
  return fallback || "";
}

/** 一句话摘要，用于工具返回值（§5.3 第 7 条：返回值必须短）。 */
function summarizeSteps(steps) {
  const counts = { say: 0, boardBlock: 0, boardReplace: 0, boardClear: 0 };
  for (const step of steps) {
    if (counts[step.kind] !== undefined) counts[step.kind] += 1;
  }
  return (
    `共 ${steps.length} 步（对白 ${counts.say}、板书 ${counts.boardBlock}` +
    `、改写 ${counts.boardReplace}、清板 ${counts.boardClear}）`
  );
}

module.exports = {
  LIMITS,
  BLOCK_STARTERS,
  BLOCK_TERMINATOR,
  META_RE,
  BOARD_REPLACE_RE,
  BOARD_CLEAR_RE,
  parseBLS,
  deriveTitle,
  summarizeSteps,
};
