import { createHash } from "node:crypto";
import path from "node:path";
import * as yaml from "js-yaml";

export class WriterError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const list = (value) => [
  ...new Set(
    (Array.isArray(value) ? value.flat(Infinity) : value ? [value] : [])
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

export function safeFilename(value) {
  if (
    typeof value !== "string" ||
    value.length > 220 ||
    /[\\\x00-\x1f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    !/\.md$/i.test(value) ||
    value.startsWith(".")
  ) {
    throw new WriterError("文章文件名无效，请使用相对路径和 .md 后缀。");
  }
  return value;
}

export function parsePost(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match)
    throw new WriterError("文章缺少 YAML front matter，暂时无法在写作台编辑。");
  let metadata;
  try {
    metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) || {};
  } catch {
    throw new WriterError("文章的 YAML 信息格式有误，请先修正。");
  }
  if (typeof metadata !== "object" || Array.isArray(metadata))
    throw new WriterError("文章信息必须是 YAML 对象。");
  const fields = {
    title: String(metadata.title ?? ""),
    date: String(metadata.date ?? ""),
    categories: list(metadata.categories),
    tags: list(metadata.tags),
    author: String(metadata.author ?? metadata.copyright_author ?? ""),
    cover: typeof metadata.cover === "string" ? metadata.cover : "",
    content: raw.slice(match[0].length).replace(/^\r?\n/, ""),
  };
  return { metadata, ...fields };
}

export function validateDraft(input, { publish = false } = {}) {
  const text = (key, max = 1000) => {
    const value = String(input[key] ?? "");
    if (value.length > max || value.includes("\0"))
      throw new WriterError(`${key} 的内容过长或含无效字符。`);
    return value;
  };
  const draft = {
    title: text("title", 300).trim(),
    filename: safeFilename(text("filename", 220)),
    date: text("date", 30).trim(),
    categories: list(input.categories),
    tags: list(input.tags),
    author: text("author", 150).trim(),
    cover: text("cover", 2000).trim(),
    content: text("content", 2_000_000),
  };
  if (
    draft.categories.length > 12 ||
    draft.tags.length > 40 ||
    [...draft.categories, ...draft.tags].some((s) => s.length > 150)
  )
    throw new WriterError("分类或标签太多、太长。");
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(draft.date))
    throw new WriterError("请选择完整的文章日期和时间。");
  const date = new Date(
    `${draft.date.replace(" ", "T")}${draft.date.length === 16 ? ":00" : ""}+08:00`,
  );
  if (
    !Number.isFinite(date.getTime()) ||
    shanghaiDate(date).slice(0, 16) !==
      draft.date.replace("T", " ").slice(0, 16)
  )
    throw new WriterError("文章日期无效。");
  if (draft.cover && !/^(https?:\/\/|\/)/i.test(draft.cover))
    throw new WriterError("封面请使用 http(s) 地址或以 / 开头的站内路径。");
  if (publish && !draft.title) throw new WriterError("发布前请填写文章标题。");
  if (publish && !draft.content.trim())
    throw new WriterError("发布前请写一些正文。");
  return draft;
}

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function serializeDraft(draft) {
  const fields = validateDraft(draft, { publish: true });
  const original = draft.baseContent ? parsePost(draft.baseContent) : null;
  if (
    original &&
    Object.entries(fields)
      .filter(([key]) => key !== "filename")
      .every(
        ([key, value]) =>
          JSON.stringify(original[key]) === JSON.stringify(value),
      )
  )
    return draft.baseContent;
  const metadata = {
    ...(original?.metadata || {}),
    title: fields.title,
    date: fields.date,
  };
  for (const key of ["categories", "tags"]) {
    if (
      !original ||
      JSON.stringify(original[key]) !== JSON.stringify(fields[key])
    )
      metadata[key] = fields[key];
  }
  if (!original || original.author !== fields.author) {
    if (fields.author) {
      metadata.author = fields.author;
      metadata.copyright_author = fields.author;
    } else {
      delete metadata.author;
      delete metadata.copyright_author;
    }
  }
  if (!original || original.cover !== fields.cover) {
    if (fields.cover) metadata.cover = fields.cover;
    else delete metadata.cover;
  }
  return `---\n${yaml.dump(metadata, { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true })}---\n\n${fields.content.trimEnd()}\n`;
}

export function assertRemoteUnchanged(draft, remoteContent, desiredContent) {
  if (remoteContent === desiredContent) return;
  if (draft.baseContent === null && remoteContent !== null)
    throw new WriterError("GitHub 上已存在同名文章，请换一个文件名。", 409);
  if (draft.baseContent !== null && remoteContent !== draft.baseContent)
    throw new WriterError(
      "这篇文章在 GitHub 上有了新版本。请先导出当前草稿，再重新打开线上文章合并修改。",
      409,
    );
}

export const plainText = (html) =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

export function githubRepository(remote) {
  const match = remote.match(
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
  );
  return match?.[1] || null;
}
