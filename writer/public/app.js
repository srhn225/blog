import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (id) => document.getElementById(id);
const state = {
  site: null,
  token: "",
  posts: [],
  sentences: [],
  drafts: [],
  categories: [],
  tags: [],
  jobs: [],
  draft: null,
  mode: "posts",
  categoryFilter: "",
  view: "edit",
  dirty: false,
  revision: 0,
  categoryChanged: false,
  autoFilename: false,
  job: null,
  saving: null,
};
const fieldIds = [
  "title",
  "content",
  "category",
  "custom-category",
  "tags",
  "date",
  "author",
  "cover",
  "filename",
  "homepage",
];
const isSentence = (item = state.draft) => item?.contentType === "sentence";
const sentenceCount = (text) => Array.from(text.trim()).length;
const eligibleSentence = (text) => {
  const rules = state.site?.sentenceRules || { min: 2, max: 60 };
  return sentenceCount(text) >= rules.min && sentenceCount(text) <= rules.max && !/[\r\n]/.test(text.trim());
};
const terminal = (job) =>
  ["checked", "deployed", "failed", "attention"].includes(job.status);
let saveTimer, previewTimer, toastTimer, pollTimer;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  element.setAttribute("class", "icon");
  element.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  element.append(use);
  return element;
}
function toast(message, error = false, action = null) {
  clearTimeout(toastTimer);
  const element = $("toast");
  element.className = `toast${error ? " error" : ""}`;
  element.replaceChildren(node("span", "", message));
  if (action) {
    const button = node("button", "toast-action", action.label);
    button.addEventListener("click", action.run);
    element.append(button);
  }
  element.hidden = false;
  toastTimer = setTimeout(
    () => {
      element.hidden = true;
    },
    action ? 30_000 : 6000,
  );
}
async function api(route, method = "GET", data) {
  let response;
  try {
    response = await fetch(route, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Writer-Token": state.token,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  } catch {
    throw new Error(
      "本地写作服务没有响应。草稿备份已留在浏览器，请重新启动服务。",
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
const attempt =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message, true);
    }
  };
const tags = (text) => [
  ...new Set(
    text
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const localTime = (date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

function fields() {
  const category =
    $("category").value === "__new__"
      ? $("custom-category").value.trim()
      : $("category").value;
  return {
    contentType: isSentence() ? "sentence" : "post",
    ...(isSentence() ? { homepage: $("homepage").checked } : {}),
    title: $("title").value,
    content: $("content").value,
    categories: state.categoryChanged
      ? category
        ? [category]
        : []
      : state.draft.categories,
    tags: tags($("tags").value),
    date: $("date").value.replace("T", " "),
    author: $("author").value,
    cover: $("cover").value,
    filename: $("filename").value,
  };
}
function setSaveStatus(message, error = false) {
  $("save-status").classList.toggle("error", error);
  $("save-status").replaceChildren(
    node("span", "status-dot"),
    node("span", "", message),
  );
}
function backup() {
  try {
    localStorage.setItem(
      `hane-writer-backup:${state.draft.id}`,
      JSON.stringify({ version: state.draft.version, fields: fields() }),
    );
  } catch {
    setSaveStatus("浏览器备份空间不足，请及时保存或导出", true);
  }
}
function clearBackup(id) {
  try {
    localStorage.removeItem(`hane-writer-backup:${id}`);
  } catch {}
}
function saveBackupFile(value) {
  const f = value.fields;
  const markdown = `---\ntitle: ${JSON.stringify(f.title)}\ndate: ${JSON.stringify(f.date)}\ncategories: ${JSON.stringify(f.categories)}\ntags: ${JSON.stringify(f.tags)}\nauthor: ${JSON.stringify(f.author)}\ncover: ${JSON.stringify(f.cover)}\n---\n\n${f.content}`;
  download(f.filename || "recovered-draft.md", markdown);
}
async function save() {
  clearTimeout(saveTimer);
  if (state.saving) {
    await state.saving;
    if (state.dirty) return save();
    return;
  }
  if (!state.draft || !state.dirty) return;
  const id = state.draft.id;
  const revision = state.revision;
  const snapshot = fields();
  setSaveStatus("正在保存到本地…");
  state.saving = (async () => {
    try {
      const saved = await api(`/api/drafts/${id}`, "PUT", {
        ...snapshot,
        version: state.draft.version,
      });
      if (state.draft?.id !== id) return;
      state.draft = saved;
      state.drafts = [
        saved,
        ...state.drafts.filter((draft) => draft.id !== id),
      ];
      if (state.revision === revision) {
        state.dirty = false;
        clearBackup(id);
        setSaveStatus(
          `已保存 · ${localTime(new Date(saved.updatedAt)).slice(11, 16)}`,
        );
      } else {
        backup();
        setSaveStatus("有新修改，正在保存…");
      }
      renderLibrary();
    } catch (error) {
      setSaveStatus("保存失败 · 浏览器备份仍保留", true);
      toast(error.message, true, {
        label: "下载未保存内容",
        run: () => saveBackupFile({ fields: snapshot }),
      });
      throw error;
    }
  })();
  try {
    await state.saving;
  } finally {
    state.saving = null;
  }
  if (state.dirty) return save();
}
function changed(event) {
  if (!state.draft) return;
  if (
    event?.target?.id === "category" ||
    event?.target?.id === "custom-category"
  ) {
    state.categoryChanged = true;
    $("custom-category").hidden = $("category").value !== "__new__";
    if (event.target.id === "category" && !$("custom-category").hidden)
      $("custom-category").focus();
  }
  if (event?.target?.id === "filename") state.autoFilename = false;
  if (event?.target?.id === "title" && state.autoFilename) {
    const slug = $("title")
      .value.trim()
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
      .replace(/\s+/g, "-")
      .slice(0, 65);
    const prefix = $("date").value.slice(0, 10);
    $("filename").value = slug
      ? `${prefix}-${slug}.md`
      : `${prefix}-untitled-${state.draft.id.slice(0, 6)}.md`;
  }
  state.dirty = true;
  state.revision++;
  setSaveStatus("未保存的修改…");
  backup();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(() => {}), 800);
  updateStats();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}
function updateStats() {
  const content = $("content").value;
  const count = (
    content.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{Letter}\p{Number}]+/gu,
    ) || []
  ).length;
  $("word-count").textContent = `${count.toLocaleString("zh-CN")} 字`;
  $("reading-time").textContent =
    `约 ${Math.max(1, Math.ceil(count / 300))} 分钟阅读`;
  $("article-date").textContent = $("date").value
    ? $("date").value.slice(0, 10).replaceAll("-", " / ")
    : "选择文章日期";
  if (isSentence()) {
    const length = sentenceCount(content);
    const eligible = eligibleSentence(content);
    $("word-count").textContent = `${length} / ${state.site.sentenceRules.limit} 字`;
    $("reading-time").textContent = "一句话，也有自己的位置";
    $("sentence-eligibility").textContent = length > state.site.sentenceRules.limit
      ? "内容超过 500 字，请精简后发布。"
      : !length ? "写下短句后，会自动检查一言收录条件。"
      : !eligible ? "这条短句会留在短句分区，长度或换行不适合首页一言。"
      : $("homepage").checked ? "符合条件，发布后会加入首页一言。" : "仅展示在短句分区。";
    $("sentence-eligibility").classList.toggle("ineligible", !eligible);
    updateDisabled();
  }
}
function renderPreview() {
  if (state.view === "edit") return;
  if (!$("content").value.trim()) {
    $("preview").replaceChildren(
      node("p", "preview-placeholder", "写下第一句话，预览就会出现在这里。"),
    );
    return;
  }
  if (isSentence()) {
    const quote = node("blockquote", "sentence-preview");
    quote.append(node("p", "", $("content").value.trim()), node("footer", "", `${$("author").value || state.site.author} · ${$("date").value.slice(0, 10)}`));
    $("preview").replaceChildren(quote);
    return;
  }
  const sanitized = DOMPurify.sanitize(
    marked.parse($("content").value, { breaks: true }),
    {
      FORBID_TAGS: [
        "style",
        "iframe",
        "form",
        "input",
        "button",
        "textarea",
        "select",
      ],
      FORBID_ATTR: ["style"],
    },
  );
  $("preview").innerHTML = sanitized;
  for (const link of $("preview").querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
function renderCategories() {
  const names = [
    ...new Set([
      ...state.categories,
      ...state.drafts.flatMap((d) => d.categories),
    ]),
  ];
  $("category-count").textContent = names.length;
  $("category-nav").replaceChildren();
  for (const name of names) {
    const button = node(
      "button",
      `category-link${state.categoryFilter === name ? " active" : ""}`,
      name,
    );
    button.append(
      node(
        "span",
        "",
        state.posts.filter((post) => post.categories.includes(name)).length,
      ),
    );
    button.addEventListener("click", () => {
      state.mode = "posts";
      state.categoryFilter = name;
      renderLibrary();
      document.body.classList.remove("menu-open");
    });
    $("category-nav").append(button);
  }
}
function renderLibrary() {
  document.querySelector(".library").setAttribute("aria-label", state.mode === "sentences" ? "短句列表" : state.mode === "drafts" ? "草稿列表" : "文章列表");
  $("posts-count").textContent = state.posts.length;
  $("drafts-count").textContent = state.drafts.length;
  $("sentences-count").textContent = state.sentences.length;
  $("nav-posts").classList.toggle(
    "active",
    state.mode === "posts" && !state.categoryFilter,
  );
  $("nav-drafts").classList.toggle("active", state.mode === "drafts");
  $("nav-sentences").classList.toggle("active", state.mode === "sentences");
  $("library-title").textContent =
    state.categoryFilter || (state.mode === "drafts" ? "草稿箱" : state.mode === "sentences" ? "短句板" : "文章库");
  $("list-caption").textContent =
    state.mode === "drafts" ? "最近保存的草稿" : state.mode === "sentences" ? "短句与本地草稿" : "最近的文章";
  $("search").placeholder = state.mode === "sentences" ? "搜索句子、作者" : "搜索标题、分类、标签";
  $("search").setAttribute("aria-label", state.mode === "sentences" ? "搜索短句" : "搜索文章");
  const query = $("search").value.trim().toLocaleLowerCase();
  const sentenceDrafts = state.drafts.filter(isSentence);
  const sentenceItems = [...sentenceDrafts, ...state.sentences.filter(item => !sentenceDrafts.some(draft => draft.filename === item.filename))].sort((a, b) => b.date.localeCompare(a.date));
  const items = (state.mode === "drafts" ? state.drafts : state.mode === "sentences" ? sentenceItems : state.posts).filter(
    (item) =>
      (!state.categoryFilter ||
        item.categories.includes(state.categoryFilter)) &&
      [item.title, item.author, item.content, ...item.categories, ...item.tags, item.filename]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
  );
  $("library-count").textContent = items.length;
  const container = $("article-list");
  container.replaceChildren();
  if (!items.length)
    container.append(
      node(
        "p",
        "empty-list",
        query ? "没有找到匹配的内容。" : state.mode === "sentences" ? "还没有短句，写下此刻的想法吧。" : "还没有内容，写下你的第一篇吧。",
      ),
    );
  for (const item of items) {
    const active =
      item.id
        ? item.id === state.draft?.id
        : item.filename === state.draft?.filename &&
          state.draft?.kind === "post" && isSentence(item) === isSentence();
    const button = node("button", `article-item${active ? " active" : ""}${isSentence(item) ? " sentence-item" : ""}`);
    button.append(node("h3", "", item.title || (isSentence(item) ? "新短句" : "未命名的文章")));
    button.append(
      node(
        "p",
        "",
        (isSentence(item) ? (item.kind === "new" ? "本地草稿" : "已发布") + " · " + (item.author || state.site.author) : item.excerpt) ||
          item.content?.replace(/[#*`>]/g, "").slice(0, 80) ||
          "故事正在酝酿中…",
      ),
    );
    const meta = node("div", "article-item-meta");
    const displayDate =
      state.mode === "drafts" ? localTime(new Date(item.updatedAt)) : item.date;
    meta.append(
      node("span", "", displayDate.slice(0, 10).replaceAll("-", ".")),
      node("span", "article-category", isSentence(item) ? (eligibleSentence(item.content || "") && item.homepage !== false ? "首页一言" : "短句") : item.categories[0] || "未分类"),
    );
    button.append(meta);
    button.addEventListener(
      "click",
      attempt(async () => {
        await save();
        const draft =
          item.id
            ? await api(`/api/drafts/${item.id}`)
            : await api("/api/drafts/from-post", "POST", {
                filename: item.filename,
                contentType: item.contentType || "post",
              });
        state.drafts = [
          draft,
          ...state.drafts.filter((d) => d.id !== draft.id),
        ];
        loadDraft(draft);
      }),
    );
    container.append(button);
  }
  renderCategories();
}
function loadDraft(draft) {
  state.draft = draft;
  state.dirty = false;
  state.categoryChanged = false;
  state.autoFilename =
    draft.kind === "new" && /-untitled-/.test(draft.filename);
  for (const id of ["title", "content", "author", "cover", "filename"])
    $(id).value = draft[id] || "";
  $("date").value = draft.date.replace(" ", "T");
  $("homepage").checked = draft.homepage !== false;
  const sentence = isSentence(draft);
  document.body.classList.toggle("sentence-mode", sentence);
  document.querySelector(".inspector").setAttribute("aria-label", sentence ? "短句设置" : "文章设置");
  $("compose-prompt").textContent = sentence ? "A SMALL THOUGHT, A PLACE TO STAY" : "MAKE ROOM FOR A NEW IDEA";
  $("inspector-title").textContent = sentence ? "短句设置" : "文章设置";
  $("date-label").textContent = sentence ? "发表日期" : "文章日期";
  $("content-label").textContent = sentence ? "短句内容" : "Markdown 正文";
  $("content").placeholder = sentence ? "写下此刻想到的一句话……\n\n可以很短，也可以慢慢说。" : "每一个故事，都从一句话开始。\n\n记下今天的发现、喜欢的音乐，\n或一个还没来得及说出口的想法……";
  $("preview").setAttribute("aria-label", sentence ? "短句预览" : "文章预览");
  $("format-label").textContent = sentence ? "纯文本 · 短句" : "Markdown";
  $("publish-label").textContent = sentence ? "发布短句" : "发布文章";
  $("publish-note").textContent = sentence ? "让一句话抵达远方" : "让文章抵达远方";
  $("tags").value = draft.tags.join(", ");
  $("category").replaceChildren(node("option", "", "未分类"));
  $("category").firstElementChild.value = "";
  for (const name of [
    ...new Set([
      ...state.categories,
      ...state.drafts.flatMap((d) => d.categories),
      ...draft.categories,
    ]),
  ]) {
    const option = node("option", "", name);
    option.value = name;
    $("category").append(option);
  }
  const custom = node("option", "", "+ 新建分类");
  custom.value = "__new__";
  $("category").append(custom);
  $("category").value = draft.categories[0] || "";
  $("custom-category").hidden = true;
  $("custom-category").value = "";
  $("filename").readOnly = draft.kind === "post";
  $("draft-kind").textContent = draft.kind === "post" ? (sentence ? "编辑短句" : "编辑文章") : sentence ? "新短句" : "新文章";
  setSaveStatus(
    `已保存 · ${localTime(new Date(draft.updatedAt)).slice(11, 16)}`,
  );
  $("tag-suggestions").replaceChildren();
  for (const tag of state.tags.slice(0, 5)) {
    const button = node("button", "", `+ ${tag}`);
    button.addEventListener("click", () => {
      $("tags").value = [...new Set([...tags($("tags").value), tag])].join(
        ", ",
      );
      changed();
    });
    $("tag-suggestions").append(button);
  }
  try {
    localStorage.setItem("hane-writer-current", draft.id);
    const pending = JSON.parse(
      localStorage.getItem(`hane-writer-backup:${draft.id}`) || "null",
    );
    if (
      pending &&
      JSON.stringify(pending.fields) !== JSON.stringify(fields())
    ) {
      if (pending.version === draft.version) {
        for (const id of ["title", "content", "author", "cover", "filename"])
          $(id).value = pending.fields[id];
        $("date").value = pending.fields.date.replace(" ", "T");
        $("homepage").checked = pending.fields.homepage !== false;
        $("tags").value = pending.fields.tags.join(", ");
        if (
          JSON.stringify(pending.fields.categories) !==
          JSON.stringify(draft.categories)
        ) {
          $("category").value = "__new__";
          $("custom-category").value = pending.fields.categories[0] || "";
          $("custom-category").hidden = false;
          state.categoryChanged = true;
        }
        changed();
        toast("已恢复上次尚未保存的内容。");
      } else
        toast(
          "另一窗口保存了新版本。浏览器中的未保存备份可以单独下载。",
          true,
          { label: "下载备份", run: () => saveBackupFile(pending) },
        );
    }
  } catch {}
  updateStats();
  renderPreview();
  renderLibrary();
  updateDisabled();
}
function updateDisabled() {
  const locked =
    state.job && !terminal(state.job) && state.job.draftId === state.draft?.id;
  for (const id of fieldIds) $(id).disabled = Boolean(locked || !state.draft);
  $("homepage").disabled ||= isSentence() && !eligibleSentence($("content").value);
  for (const button of $("toolbar").querySelectorAll("button"))
    button.disabled = Boolean(locked || !state.draft);
  for (const button of $("tag-suggestions").querySelectorAll("button"))
    button.disabled = Boolean(locked || !state.draft);
  for (const id of ["publish", "check", "discard"])
    $(id).disabled = Boolean(
      (state.job && !terminal(state.job)) || !state.draft,
    );
  if (isSentence() && sentenceCount($("content").value) > state.site.sentenceRules.limit) {
    $("publish").disabled = true;
    $("check").disabled = true;
  }
  $("export").disabled = !state.draft;
}
async function newDraft(type = "post") {
  await save();
  const date = localTime(new Date());
  const draft = await api("/api/drafts", "POST", {
    contentType: type,
    ...(type === "sentence" ? { homepage: true } : {}),
    title: "",
    filename: `${date.slice(0, 10)}-${type === "sentence" ? "sentence" : "untitled"}-${crypto.randomUUID().slice(0, 8)}.md`,
    date,
    categories: type === "sentence" ? [] : ["日常"],
    tags: [],
    author: state.site.author,
    cover: "",
    content: "",
  });
  state.drafts = [draft, ...state.drafts];
  state.mode = type === "sentence" ? "sentences" : "drafts";
  state.categoryFilter = "";
  loadDraft(draft);
  $(type === "sentence" ? "content" : "title").focus();
  document.body.classList.remove("menu-open");
}
function download(filename, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const link = node("a");
  link.href = url;
  link.download = filename.split("/").pop();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function format(kind) {
  const area = $("content");
  if (area.disabled) return;
  const start = area.selectionStart,
    end = area.selectionEnd;
  const selection = area.value.slice(start, end);
  const formats = {
    bold: ["**", selection || "粗体文字", "**"],
    italic: ["*", selection || "斜体文字", "*"],
    heading: ["## ", selection || "一个小标题", ""],
    quote: ["> ", selection || "一段值得记下的话", ""],
    list: ["- ", selection || "列表内容", ""],
    link: ["[", selection || "链接文字", "](https://example.com)"],
    code: ["```\n", selection || "在这里写代码", "\n```"],
  };
  let [before, content, after] = formats[kind];
  if (
    ["heading", "quote", "list", "code"].includes(kind) &&
    start > 0 &&
    area.value[start - 1] !== "\n"
  )
    before = `\n${before}`;
  area.setRangeText(`${before}${content}${after}`, start, end, "end");
  area.focus();
  area.setSelectionRange(
    start + before.length,
    start + before.length + content.length,
  );
  changed();
}
function safeLink(url, text) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      return node("span", "", text);
    const link = node("a", "", text);
    link.href = parsed.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch {
    return node("span", "", text);
  }
}
function renderJob(job) {
  state.job = job;
  const checking = job.mode === "check";
  const label = job.contentType === "sentence" ? "短句" : "文章";
  $("publish-title").textContent =
    job.status === "deployed"
      ? `${label}已抵达远方`
      : job.status === "checked"
        ? "可以安心发布了"
        : checking
          ? "检查发布"
          : `发布${label}`;
  $("publish-message").textContent = job.message;
  $("publish-steps").replaceChildren();
  const steps = checking
    ? [
        ["prepare", `准备${label}`],
        ["build", "构建并检查页面"],
      ]
    : [
        ["prepare", `准备${label}`],
        ["build", "构建并检查页面"],
        ["push", "提交并推送到 GitHub"],
        ["deploy", "部署到 GitHub Pages"],
        ["live", job.contentType === "sentence" ? "核对短句与首页一言" : "核对线上文章"],
      ];
  steps.forEach(([key, label], i) => {
    const status = job.steps[key] || "pending";
    const item = node("li", `publish-step ${status}`);
    const mark = node("span", "step-icon");
    if (status === "done") mark.append(icon("check"));
    else if (status === "error") mark.append(node("span", "", "!"));
    else if (status !== "running") mark.textContent = i + 1;
    item.append(mark, node("span", "", label));
    $("publish-steps").append(item);
  });
  $("job-links").replaceChildren();
  if (job.publicUrl && job.pushed)
    $("job-links").append(safeLink(job.publicUrl, `查看线上${label} ↗`));
  if (job.actionsUrl && !checking)
    $("job-links").append(safeLink(job.actionsUrl, "查看 GitHub Actions ↗"));
  if (job.commit && state.site.repository)
    $("job-links").append(
      safeLink(
        `https://github.com/${state.site.repository}/commit/${job.commit}`,
        job.commit.slice(0, 7),
      ),
    );
  $("local-sync").textContent = job.localSync || "";
  $("retry-job").hidden = !(job.status === "attention" && job.pushed);
  $("done-job").hidden = !terminal(job);
  updateDisabled();
}
async function pollJob(id) {
  clearTimeout(pollTimer);
  try {
    const job = await api(`/api/jobs/${id}`);
    renderJob(job);
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== id)];
    if (!terminal(job)) {
      pollTimer = setTimeout(() => pollJob(id), 1400);
      return;
    }
    const data = await api("/api/bootstrap");
    const current = state.draft?.id;
    Object.assign(state, {
      posts: data.posts,
      sentences: data.sentences,
      drafts: data.drafts,
      categories: data.categories,
      tags: data.tags,
      jobs: data.jobs,
    });
    const updated = state.drafts.find((d) => d.id === current);
    if (updated && !state.dirty && !state.saving) loadDraft(updated);
    else renderLibrary();
  } catch (error) {
    toast(error.message, true);
    pollTimer = setTimeout(() => pollJob(id), 6000);
  }
}
async function startPublish(mode) {
  await save();
  const draft = state.draft;
  const job = await api(
    mode === "check" ? "/api/check" : "/api/publish",
    "POST",
    { draftId: draft.id, version: draft.version },
  );
  renderJob(job);
  if (!$("publish-dialog").open) $("publish-dialog").showModal();
  void pollJob(job.id);
}
function history() {
  const running =
    state.job && !terminal(state.job)
      ? state.job
      : state.jobs.find((job) => !terminal(job));
  if (running) {
    renderJob(running);
    if (!$("publish-dialog").open) $("publish-dialog").showModal();
    void pollJob(running.id);
    return;
  }
  $("history-list").replaceChildren();
  if (!state.jobs.length)
    $("history-list").append(
      node("p", "empty-list", "发布第一篇文章后，记录会出现在这里。"),
    );
  const names = {
    checked: "检查通过",
    deployed: "已上线",
    running: "进行中",
    failed: "未发布",
    attention: "已推送 · 待核对",
  };
  for (const job of state.jobs) {
    const button = node("button", "history-item");
    button.append(node("h3", "", job.title));
    const details = node("p");
    details.append(
      node("span", "", localTime(new Date(job.createdAt)).slice(0, 16)),
      node("span", "", names[job.status]),
    );
    button.append(details);
    button.addEventListener("click", () => {
      $("history-dialog").close();
      renderJob(job);
      $("publish-dialog").showModal();
      if (!terminal(job)) void pollJob(job.id);
    });
    $("history-list").append(button);
  }
  $("history-dialog").showModal();
}

for (const id of fieldIds)
  $(id).addEventListener(["category", "homepage"].includes(id) ? "change" : "input", changed);
for (const button of document.querySelectorAll("[data-view]")) {
  if (button.tagName !== "BUTTON") continue;
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    $("writing-panes").dataset.view = state.view;
    for (const tab of document.querySelectorAll(".view-tabs button"))
      tab.classList.toggle("selected", tab === button);
    $("toolbar").hidden = state.view === "preview";
    renderPreview();
  });
}
for (const button of $("toolbar").querySelectorAll("button"))
  button.addEventListener("click", () => format(button.dataset.format));
$("new-post").addEventListener("click", attempt(() => newDraft("post")));
$("new-sentence").addEventListener("click", attempt(() => newDraft("sentence")));
$("nav-sentences").addEventListener("click", attempt(async () => {
  await save();
  state.mode = "sentences";
  state.categoryFilter = "";
  if (!isSentence()) {
    const draft = state.drafts.find(isSentence);
    if (draft) loadDraft(await api(`/api/drafts/${draft.id}`));
    else if (state.sentences.length) {
      const opened = await api("/api/drafts/from-post", "POST", { filename: state.sentences[0].filename, contentType: "sentence" });
      state.drafts = [opened, ...state.drafts];
      loadDraft(opened);
    } else await newDraft("sentence");
  }
  renderLibrary();
  document.body.classList.remove("menu-open");
}));
$("nav-posts").addEventListener("click", () => {
  state.mode = "posts";
  state.categoryFilter = "";
  renderLibrary();
  document.body.classList.remove("menu-open");
});
$("nav-drafts").addEventListener("click", () => {
  state.mode = "drafts";
  state.categoryFilter = "";
  renderLibrary();
  document.body.classList.remove("menu-open");
});
$("nav-history").addEventListener("click", history);
$("search").addEventListener("input", renderLibrary);
$("focus-toggle").addEventListener("click", () =>
  document.body.classList.toggle("focus-mode"),
);
$("menu-toggle").addEventListener("click", () =>
  document.body.classList.toggle("menu-open"),
);
$("publish").addEventListener(
  "click",
  attempt(() => startPublish("publish")),
);
$("check").addEventListener(
  "click",
  attempt(() => startPublish("check")),
);
$("export").addEventListener(
  "click",
  attempt(async () => {
    await save();
    const result = await api("/api/export", "POST", {
      draftId: state.draft.id,
      version: state.draft.version,
    });
    download(result.filename, result.markdown);
    toast("Markdown 已导出。");
  }),
);
$("discard").addEventListener("click", () => $("discard-dialog").showModal());
$("cancel-discard").addEventListener("click", () =>
  $("discard-dialog").close(),
);
$("confirm-discard").addEventListener(
  "click",
  attempt(async () => {
    await save();
    const id = state.draft.id;
    await api(`/api/drafts/${id}`, "DELETE", { version: state.draft.version });
    clearBackup(id);
    state.drafts = state.drafts.filter((d) => d.id !== id);
    state.draft = null;
    $("discard-dialog").close();
    if (state.drafts.length)
      loadDraft(await api(`/api/drafts/${state.drafts[0].id}`));
    else await newDraft();
    toast("本地草稿已删除。");
  }),
);
$("close-publish").addEventListener("click", () => $("publish-dialog").close());
$("done-job").addEventListener("click", () => $("publish-dialog").close());
$("close-history").addEventListener("click", () => $("history-dialog").close());
$("retry-job").addEventListener(
  "click",
  attempt(async () => {
    const job = await api(`/api/jobs/${state.job.id}/retry`, "POST", {});
    renderJob(job);
    void pollJob(job.id);
  }),
);
document.addEventListener("click", (event) => {
  if (
    document.body.classList.contains("menu-open") &&
    !event.target.closest(".sidebar, #menu-toggle")
  )
    document.body.classList.remove("menu-open");
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      void attempt(save)();
    }
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      void attempt(() => newDraft(state.mode === "sentences" ? "sentence" : "post"))();
    }
    if (
      event.key.toLowerCase() === "b" &&
      !isSentence() &&
      document.activeElement === $("content")
    ) {
      event.preventDefault();
      format("bold");
    }
  }
  if (event.key === "Escape") {
    document.body.classList.remove("focus-mode", "menu-open");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty || state.saving) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function boot() {
  updateDisabled();
  try {
    const data = await api("/api/bootstrap");
    Object.assign(state, {
      site: data.site,
      token: data.token,
      posts: data.posts,
      sentences: data.sentences,
      drafts: data.drafts,
      categories: data.categories,
      tags: data.tags,
      jobs: data.jobs,
    });
    $("visit-blog").href = data.site.url;
    $("connection-label").textContent = "已连接 · 自动保存";
    $("publish-target").textContent =
      `${data.site.repository || "GitHub"} · ${data.site.branch}`;
    let current;
    try {
      current = localStorage.getItem("hane-writer-current");
    } catch {}
    const active =
      data.drafts.find((draft) => draft.id === current) || data.drafts[0];
    if (active) {
      state.mode = isSentence(active) ? "sentences" : "posts";
      loadDraft(active);
    }
    else await newDraft();
    // Keep the article library visible for the first visit.
    if (!active) {
      state.mode = "posts";
      renderLibrary();
    }
    const job = data.jobs.find((item) => !terminal(item));
    if (job) {
      renderJob(job);
      $("publish-dialog").showModal();
      void pollJob(job.id);
    }
    if (!data.site.canPublish)
      toast("保存和预览已就绪。发布前请为 Git 配置姓名和邮箱。", true);
  } catch (error) {
    $("connection-label").textContent = "服务未连接";
    document.querySelector(".connection").classList.add("offline");
    setSaveStatus("请先启动本地写作服务", true);
    toast(error.message, true);
  }
}
void boot();
