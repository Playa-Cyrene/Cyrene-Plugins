/**
 * Board —— 黑板的数据结构与纯函数。
 *
 * 黑板就是一篇 markdown 文档；所有变更都是对 BoardOp 的顺序应用。
 * 校验器、播放器、断点重绘器**必须共用这里的 apply()**，否则三处实现会漂移。
 * 设计依据：DESIGN.md §4.4 / §8。
 *
 * 只在主进程运行：窗口不自持黑板，而是渲染主进程随 `advance` 一起下发的 boardText
 * （§8.3 / §11.2）。所以这里就是普通 CommonJS 模块，不需要为渲染端做兼容包装。
 */
/** 新建一块空黑板。 */
function createBoard() {
  return { lines: [] };
}

/** 深拷贝。校验剧本时要"先试算再提交"，不能污染真实黑板。 */
function cloneBoard(board) {
  return { lines: board.lines.slice() };
}

/** 黑板全文。喂给 markdown 渲染器，也用于注入 Provider 的「当前板书」。 */
function boardText(board) {
  return board.lines.join("\n");
}

/**
 * 应用一条黑板操作，就地修改 board。
 * 返回 false 表示这条操作没有生效（找不到旧内容，或本身不是黑板操作）——
 * 与 DESIGN.md §4.5「忽略该步并告警」一致。
 */
function apply(op, board) {
  switch (op.kind) {
    case "boardBlock":
      board.lines.push(...op.lines);
      return true;

    case "boardReplace": {
      const text = boardText(board);
      const at = text.indexOf(op.from);
      if (at < 0) return false;
      board.lines = (text.slice(0, at) + op.to + text.slice(at + op.from.length)).split("\n");
      return true;
    }

    case "boardClear":
      board.lines.length = 0;
      return true;

    case "say":
      return false; // 对白不动黑板

    default:
      return false;
  }
}

/**
 * 从 steps 投影出黑板类操作，供断点重绘按 stepIndex 过滤重放（§4.4 / §8.3）。
 * 每层各自持有完整增量，所以重放不需要黑板快照。
 */
function projectBoardOps(steps) {
  const ops = [];
  steps.forEach((step, stepIndex) => {
    if (step.kind !== "say") ops.push(Object.assign({}, step, { stepIndex }));
  });
  return ops;
}

module.exports = { createBoard, cloneBoard, boardText, apply, projectBoardOps };
