/**
 * lessons —— 工作区 learn/lessons/ 下的剧本文件 IO。
 *
 * 这是插件在工作区里**唯一**的写入面（DESIGN.md §10），
 * 也是唯一的路径安全边界（§5.3 第 3 条）。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 相对工作区根的子目录（§4.6）。 */
const LESSONS_SUBDIR = path.join("learn", "lessons");
/** 剧本文件扩展名。刻意不用 .md —— Obsidian 会把 `>>` 当引用渲染，文件看起来像坏了。 */
const LESSON_EXT = ".bls";
/** 裸文件名白名单：不含任何路径分隔符（§4.6）。 */
const FILE_RE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,48}\.bls$/;
/** 单文件上限（§4.6）。 */
const MAX_BYTES = 64 * 1024;

function lessonsDir(workspaceRoot) {
  return path.join(workspaceRoot, LESSONS_SUBDIR);
}

/**
 * 把模型给的文件名解析成绝对路径。
 *
 * 名字直接来自模型，而插件有完整 fs 权限，所以这里必须硬校验：
 * 这里只处理词法路径；真正的目录、链接和打开后的文件身份在读写入口校验。
 */
function resolveLessonPath(workspaceRoot, file) {
  if (!workspaceRoot) throw new Error("该会话未绑定工作区，无法读写剧本文件");
  const name = String(file == null ? "" : file).trim();
  if (!name) throw new Error("缺少文件名 file");
  if (name.startsWith(".")) throw new Error(`文件名不能以点开头：${name}`);
  if (!FILE_RE.test(name)) {
    throw new Error(`文件名非法：${name}（需匹配 ${FILE_RE} 且以 ${LESSON_EXT} 结尾）`);
  }
  const dir = path.resolve(lessonsDir(workspaceRoot));
  const target = path.resolve(dir, name);
  if (target !== path.join(dir, name)) throw new Error(`文件名越界：${name}`);
  return target;
}

function samePath(a, b) {
  return path.relative(a, b) === "";
}

function sameNode(a, b) {
  // 没有可靠文件 ID 的文件系统上宁可拒绝，也不能把路径检查当作句柄检查。
  return typeof a.ino === "bigint" && a.ino !== 0n &&
    typeof b.ino === "bigint" && b.ino !== 0n &&
    a.dev === b.dev && a.ino === b.ino;
}

/** 逐级检查目录，避免 mkdir(recursive) 穿过目录链接在工作区外建文件。 */
function checkedLessonsDir(workspaceRoot, create) {
  if (!workspaceRoot) throw new Error("该会话未绑定工作区，无法读写剧本文件");
  const root = path.resolve(workspaceRoot);
  const rootReal = fs.realpathSync.native(root);
  let real = rootReal;
  const rootStat = fs.statSync(root, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error("工作区不是目录");
  const nodes = [rootStat];
  let current = root;
  for (const part of ["learn", "lessons"]) {
    current = path.join(current, part);
    if (create) {
      try {
        fs.mkdirSync(current);
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
      }
    }
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`剧本目录不能是符号链接：${current}`);
    if (!stat.isDirectory()) throw new Error(`剧本目录不是普通目录：${current}`);
    const nextReal = fs.realpathSync.native(current);
    if (!samePath(path.dirname(nextReal), real)) throw new Error("剧本目录越出工作区");
    nodes.push(stat);
    real = nextReal;
  }
  return { rootReal, dirReal: real, nodes };
}

function checkOpenedLesson(workspaceRoot, target, beforeDir, beforeFile, fd) {
  const afterDir = checkedLessonsDir(workspaceRoot, false);
  if (!samePath(beforeDir.rootReal, afterDir.rootReal) ||
      !samePath(beforeDir.dirReal, afterDir.dirReal) ||
      !beforeDir.nodes.every((node, index) => sameNode(node, afterDir.nodes[index]))) {
    throw new Error("剧本目录在打开文件时发生变化");
  }
  const afterFile = fs.lstatSync(target, { bigint: true });
  if (afterFile.isSymbolicLink()) throw new Error("剧本文件不能是符号链接");
  const opened = fs.fstatSync(fd, { bigint: true });
  if (!opened.isFile() || !afterFile.isFile()) throw new Error("剧本不是普通文件");
  if ((beforeFile && !sameNode(beforeFile, opened)) || !sameNode(afterFile, opened)) {
    throw new Error("剧本文件在打开时发生变化");
  }
  const realTarget = fs.realpathSync.native(target);
  if (!samePath(path.dirname(realTarget), beforeDir.dirReal)) {
    throw new Error("剧本文件越出工作区");
  }
  return opened;
}

function openFlags(mode, create) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  return mode | noFollow | (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
}

function readBoundedLesson(fd) {
  // 文件可能在 fstat 后增长；实际读取也严格限制为上限加一个字节。
  const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length > MAX_BYTES) throw new Error(`剧本超过 ${MAX_BYTES} 字节上限`);
  return buffer.toString("utf8", 0, length);
}

/** 目录不存在就建。宿主 vault 初始化里没有 learn/lessons/，插件自己补。 */
function ensureLessonsDir(workspaceRoot) {
  checkedLessonsDir(workspaceRoot, true);
  return lessonsDir(workspaceRoot);
}

/** learn/lessons/ 是否已存在。给文件选择器挑默认位置用，不创建目录。 */
function hasLessonsDir(workspaceRoot) {
  if (!workspaceRoot) return false;
  try {
    checkedLessonsDir(workspaceRoot, false);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/** 两种读取入口共用：按句柄确认文件类型和大小，再从同一句柄读取正文。 */
function readValidatedLessonFile(target, workspaceRoot) {
  const dir = workspaceRoot ? checkedLessonsDir(workspaceRoot, false) : null;
  const beforeFile = dir ? fs.lstatSync(target, { bigint: true }) : null;
  if (beforeFile && beforeFile.isSymbolicLink()) throw new Error("剧本文件不能是符号链接");
  const fd = fs.openSync(target, dir ? openFlags(fs.constants.O_RDONLY, false) : fs.constants.O_RDONLY);
  try {
    const stat = dir
      ? checkOpenedLesson(workspaceRoot, target, dir, beforeFile, fd)
      : fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error("剧本不是普通文件");
    if (stat.size > BigInt(MAX_BYTES)) throw new Error(`剧本超过 ${MAX_BYTES} 字节上限`);
    return readBoundedLesson(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读一个**用户从文件选择器里挑的**剧本：绝对路径，不走白名单。
 *
 * 这里不做路径校验是刻意的：路径来自用户本人在系统对话框里的选择，不是模型给的；
 * 而且这个通道只挂在窗口的 IPC 上，不是工具，模型碰不到它（模型那条路仍走 readLesson 的白名单）。
 */
function readLessonByPath(filePath) {
  const target = path.resolve(String(filePath == null ? "" : filePath));
  return readValidatedLessonFile(target);
}

function lessonExists(workspaceRoot, file) {
  const target = resolveLessonPath(workspaceRoot, file);
  try {
    checkedLessonsDir(workspaceRoot, false);
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/** 读剧本正文。文件不存在时抛 ENOENT，由调用方翻译成可行动的文案。 */
function readLesson(workspaceRoot, file) {
  return readValidatedLessonFile(resolveLessonPath(workspaceRoot, file), workspaceRoot);
}

/**
 * 写剧本正文（同名覆盖）。UTF-8、无 BOM、\n 换行。
 * 返回 { file, path, bytes, overwritten }。
 */
function writeLesson(workspaceRoot, file, text) {
  const target = resolveLessonPath(workspaceRoot, file);
  const body = String(text == null ? "" : text);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`剧本超过 ${MAX_BYTES} 字节上限（当前 ${bytes}）`);
  const dir = checkedLessonsDir(workspaceRoot, true);
  let beforeFile;
  try {
    beforeFile = fs.lstatSync(target, { bigint: true });
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  if (beforeFile && beforeFile.isSymbolicLink()) throw new Error("剧本文件不能是符号链接");
  if (beforeFile && !beforeFile.isFile()) throw new Error("剧本不是普通文件");
  const overwritten = Boolean(beforeFile);
  // 已有文件不使用 w 标志：先核对打开的句柄，再截断内容。
  const fd = fs.openSync(target, openFlags(fs.constants.O_WRONLY, !overwritten));
  try {
    const opened = checkOpenedLesson(workspaceRoot, target, dir, beforeFile, fd);
    if (opened.nlink > 1n) throw new Error("剧本文件存在其他硬链接，拒绝覆盖");
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, body, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
  return { file: path.basename(target), path: target, bytes, overwritten };
}

function deleteLesson(workspaceRoot, file) {
  const target = resolveLessonPath(workspaceRoot, file);
  try {
    checkedLessonsDir(workspaceRoot, false);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("剧本文件不能是符号链接");
    if (!stat.isFile()) throw new Error("剧本不是普通文件");
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
  fs.unlinkSync(target);
  return true;
}

/** 列出目录下的剧本文件名，已排序。目录不存在时返回空数组。 */
function listLessons(workspaceRoot) {
  if (!workspaceRoot) return [];
  const dir = lessonsDir(workspaceRoot);
  let entries;
  try {
    checkedLessonsDir(workspaceRoot, false);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(LESSON_EXT))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

module.exports = {
  LESSONS_SUBDIR,
  LESSON_EXT,
  FILE_RE,
  MAX_BYTES,
  lessonsDir,
  resolveLessonPath,
  ensureLessonsDir,
  hasLessonsDir,
  lessonExists,
  readLesson,
  readLessonByPath,
  writeLesson,
  deleteLesson,
  listLessons,
};
