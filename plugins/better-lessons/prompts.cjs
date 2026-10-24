/**
 * better-lessons —— **全部给 LLM 的提示词**都集中在这个文件里（DESIGN.md §6.2 / §6.3）。
 *
 * 改语气、加约束、调措辞只改这里；index.cjs 只负责"什么时候把它送出去"。
 * 每个提示词上方都标了【调用时机】，说明它在什么时刻、以什么形式到达模型眼前。
 *
 * ---------------------------------------------------------------- 两种形态，别混用
 *
 *   1. `BLS_FORMAT_SPEC`       常驻说明，learn 模式**每一轮**注入 runtime context。
 *   2. `buildClassroomBrief()` 课堂进行中的现场播报，追加在常驻说明之后（同一轮、同一个 context）。
 *
 * 两者进的都是宿主的 runtime context（每轮变化，因此不破坏宿主的提示词缓存）。
 *
 * **要不要动用课堂，由模型自己决定。** 这里只写"要用的话该怎么写""课堂现在什么样"，
 * 不写"每一轮都必须推一段"——插件不替模型决定要不要上课（DESIGN §6.2）。
 * 插件侧唯一的强制是：模型写了剧本却没推时替它推出去（§6.3）。
 *
 * ---------------------------------------------------------------- 这里有意**不放**的东西
 *
 *   - **工具名 / 参数的 `description`**：它们和 `inputSchema` 交织在一起，拆出来会让"读一个工具的定义"
 *     变成翻两个文件。它们属于工具 schema，不属于提示词（§5.2）。若确实想集中，请单独说。
 *   - **工具的返回值文案**：那是"回给模型的执行结果"，不是提示词。它必须与参数校验的错误行号绑在一起
 *     （§5.3 第 2 条），所以留在各自的 execute 里 —— 但**其中内嵌的 BLS 样例**例外，它是格式说明，
 *     见下面的 `SAMPLE_SCRIPT`。
 *   - **窗口 / 面板的界面文案**：给用户看的，不是给模型看的。
 */

/**
 * 【人家写给自己的备忘】
 *
 * 这个文件里装的每个字，最后都会落到我自己眼前。所以别写成说明书，写成备忘：
 * 什么时候用、怎么用、用错了会怎样，一眼看得懂。
 * 语气可以软，规矩必须硬 —— 关键字、箭头、逐字匹配这几样，一个字都不能松。
 */

/**
 * 【常驻】BLS 格式说明。
 *
 * **调用时机**：learn 模式的每一轮都会进宿主的 runtime context（由 `registerPromptProvider` 的
 * `provide()` 返回，`modes: ["learn"]`、`sources: ["conversation"]`）。两种情形：
 *   - 该会话**没有**活跃课堂房间 → 只注入这一段；
 *   - 该会话**有**活跃课堂房间 → 这一段在最前，后面接 `buildClassroomBrief()`。
 *
 * **写作约束**：
 *   - 每轮都进 context，所以**必须短**；
 *   - 它是这段提示词里的"稳定前缀"，**措辞一变整段缓存就失效**，改的时候要有意识地接受这个代价；
 *   - 只写"模型不可能自己猜出来"的东西：关键字清单、硬规则。别写背景介绍。
 */
const BLS_FORMAT_SPEC = [
  "【BLS 剧本】黑板用不用，可以自己拿主意；想讲的时候，再把稿子写成 learn/lessons/<名字>.bls 文件，把文件名交给推送。",
  "关键字有且只有这几个：",
  "  meta title=<板书标题>          ← 单行，可选，整段最多一次",
  "  say << … >>                    ← 块，一行一句对白，块内每行按 markdown 渲染",
  "  board << … >>                  ← 块，整块 markdown 板书",
  "  board replace <旧内容> -> <新内容>   ← 内容匹配替换，可以只改一行里的一小段",
  "  board clear                    ← 清空板书",
  "要用的时候，牢记这几条：",
  "1. 顺序是死的：先 write_lesson 把稿子落成文件，再 push_script 推上去；只在聊天框里回话，黑板不会动。",
  "2. 文件名用「主题-序号-要点.bls」；要插在中间就写 01.1。",
  "3. 对白一行一句，块内不要留空行；板书全放进 board 块，块外不写 markdown 标题。",
  "4. BLS 没有注释语法。正文里绝不写 ASCII 箭头，一律写 →。",
  "5. 每份 BLS 都从空板开始；要改本份剧本前面步骤写出的板书，用 board replace，<旧内容>逐字匹配这份剧本演到此处的板书（包括之前的替换结果）。不要引用「课堂现场」里的旧板书。",
  "6. 公式直接写 LaTeX：行内用 $...$（如 $\\Delta = b^2 - 4ac$），独占一段用 $$...$$；不要用 \\( \\) 或 \\[ \\]。",
].join("\n");

/**
 * 【工具报错时】一段最短的、可以照抄的 BLS 正例。
 *
 * **调用时机**：不是 context 注入。`write_lesson` 收到空 `file` / 空 `script` 时，
 * 把它拼在**参数校验的报错文案**后面返回给模型（`index.cjs` 的 writeLessonTool.execute）。
 * 所以它进的是"工具返回值"这条路，只是内容本身是格式说明，才和 `BLS_FORMAT_SPEC` 放在一起 ——
 * BLS 语法一改，这两个地方必须同时改，摆在一起才不会只改一半。
 *
 * **写作约束**：它会被原样抄走，因此必须**逐字符合法**（能被 parseBLS 解析通过、无 warning）。
 * 演示的是最常用的三件事：say 块、board 块、board replace（且 replace 的旧内容确实存在于上一块板书里）。
 */
const SAMPLE_SCRIPT = [
  "meta title=判别式",
  "",
  "say <<",
  "伙伴，我们今天只看一件事：**判别式** $\\Delta = b^2 - 4ac$ 的符号。",
  ">>",
  "board <<",
  "## 判别式",
  "",
  "$$\\Delta = b^2 - 4ac$$",
  "",
  "它的符号决定抛物线与 x 轴交点的个数。",
  ">>",
  "board replace 它的符号决定抛物线与 x 轴交点的个数。 -> **它的符号决定抛物线与 x 轴交点的个数。**",
].join("\n");

/** 注入板书的上限（字符）。超长时保留末尾，见 `buildClassroomBrief`。 */
const BOARD_INJECT_LIMIT = 12000;

/**
 * 【课堂进行中】现场播报：进度 + 已用文件 + 板书全文。
 *
 * **调用时机**：learn 模式每一轮，当**该会话存在活跃课堂房间**时，追加在 `BLS_FORMAT_SPEC` 之后
 * （同样是 `provide()` 的返回值、同样进 runtime context）。
 *
 * **为什么带上板书全文**：让模型知道前一层讲到了哪里，以便衔接插话。
 * 新写的 BLS 从空板开始，`board replace` 只能引用本份剧本先前步骤写出的内容（§4.5 / §6.2b）。
 *
 * **这一段的目的是"告知"，不是"下令"**：把课堂现在什么样摆清楚，要不要接着演由模型自己判断。
 * 模型只在聊天框里回答也完全正常——插件侧的强制只剩"写了没推就替它推"（§6.3）。
 */
function buildClassroomBrief(input) {
  const progress = String(input.progress || "").trim();
  const frameCount = Number(input.frameCount) || 0;
  const files = Array.isArray(input.lessonFiles) ? input.lessonFiles.join(" → ") : "";
  const boardText = String(input.boardText == null ? "" : input.boardText);
  const userText = String(input.userText || "");
  // 板书超长时保留**末尾**：新写的板书在下面，也更可能是这次要改的目标（§6.2b）
  const visible = boardText.length > BOARD_INJECT_LIMIT
    ? boardText.slice(boardText.length - BOARD_INJECT_LIMIT)
    : boardText;

  return [
    "【课堂现场】",
    `黑板开着；${progress}；帧队列长度 ${frameCount}。`,
    `这节课已经用过的剧本（按顺序）：${files || "（还没有）"}`,
    "课堂当前可见板书（仅供衔接讲解；新 BLS 从空板开始，不能直接对这里的内容用 board replace）：",
    visible || "（黑板是空的）",
    "要不要接着用黑板讲，可以自己拿主意；只在聊天框里答一句也可以。",
    "决定要讲的话：先 better-lessons_write_lesson 写一份新剧本（别去覆写正在播的那份），紧接着 better-lessons_push_script 把它推上去；短到 1-2 步也行。",
    `伙伴说的是：${userText}`,
  ].join("\n");
}

module.exports = {
  BLS_FORMAT_SPEC,
  SAMPLE_SCRIPT,
  BOARD_INJECT_LIMIT,
  buildClassroomBrief,
};
