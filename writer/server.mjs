import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as yaml from "js-yaml";
import {
  WriterError,
  list,
  safeFilename,
  parsePost,
  validateDraft,
  serializeDraft,
  assertRemoteUnchanged,
  plainText,
  githubRepository,
} from "./core.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function run(command, args, cwd, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND:
          process.env.GIT_SSH_COMMAND ||
          "ssh -o BatchMode=yes -o ConnectTimeout=15",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (data) => {
      output = (output + data).slice(-1_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let escalation;
    const kill = (signal) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 5000);
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      if (code === 0) resolve(output.trim());
      else
        reject(
          new WriterError(
            `${command} 执行失败${code === null ? "（超时）" : ""}：${output.slice(-2500).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@")}`,
            500,
          ),
        );
    });
  });
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

export async function createWriter({
  root = path.resolve(appDir, ".."),
  port = 4318,
  deploymentPollMs = 20_000,
} = {}) {
  root = await fs.realpath(root);
  const postsDir = path.join(root, "source", "_posts");
  const stateDir = path.join(root, ".writer");
  const draftsDir = path.join(stateDir, "drafts");
  const jobsDir = path.join(stateDir, "jobs");
  await fs.mkdir(draftsDir, { recursive: true });
  await fs.mkdir(jobsDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const branch = process.env.WRITER_BRANCH || "main";
  if (
    !/^[\w./-]+$/.test(branch) ||
    branch.startsWith("-") ||
    branch.includes("..")
  )
    throw new WriterError("WRITER_BRANCH 无效。");
  const config = yaml.load(
    await fs.readFile(path.join(root, "_config.yml"), "utf8"),
    { schema: yaml.JSON_SCHEMA },
  );
  const remote = await run("git", ["remote", "get-url", "origin"], root);
  const repository = githubRepository(remote);
  const gitName = await run("git", ["config", "user.name"], root).catch(
    () => "",
  );
  const gitEmail = await run("git", ["config", "user.email"], root).catch(
    () => "",
  );
  const jobs = new Map();
  const locks = new Map();
  let busy = null;

  const locked = async (key, fn) => {
    const before = locks.get(key) || Promise.resolve();
    const next = before.catch(() => {}).then(fn);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  };
  const draftPath = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new WriterError("草稿编号无效。");
    return path.join(draftsDir, `${id}.json`);
  };
  const readDraft = async (id) => {
    const value = await readOptional(draftPath(id));
    if (!value) throw new WriterError("没有找到这篇草稿。", 404);
    return JSON.parse(value);
  };
  const saveDraft = async (value) => {
    value.updatedAt = new Date().toISOString();
    value.version = randomUUID();
    await atomicJson(draftPath(value.id), value);
    return value;
  };
  const publicDraft = (draft) => {
    const { baseContent, ...publicFields } = draft;
    return publicFields;
  };
  const jsonFiles = async (dir) =>
    (await fs.readdir(dir)).filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    );
  const allDrafts = async () => {
    const drafts = await Promise.all(
      (await jsonFiles(draftsDir)).map(async (name) =>
        JSON.parse(await fs.readFile(path.join(draftsDir, name), "utf8")),
      ),
    );
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  const postFile = async (
    filename,
    base = postsDir,
    { allowMissing = false } = {},
  ) => {
    const target = path.join(base, safeFilename(filename));
    const baseReal = await fs.realpath(base);
    let cursor = target;
    while (true) {
      try {
        const resolved = await fs.realpath(cursor);
        if (
          resolved !== baseReal &&
          !resolved.startsWith(`${baseReal}${path.sep}`)
        )
          throw new WriterError("文章路径不能指向文章目录之外。");
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || !allowMissing) throw error;
        cursor = path.dirname(cursor);
      }
    }
    // Reject symlinks even when they happen to stay within the article directory.
    for (const part of path.relative(base, target).split(path.sep)) {
      base = path.join(base, part);
      try {
        if ((await fs.lstat(base)).isSymbolicLink())
          throw new WriterError("写作台不修改符号链接文章。");
      } catch (error) {
        if (error.code !== "ENOENT" || !allowMissing) throw error;
      }
    }
    return target;
  };
  const allPosts = async () => {
    const files = [];
    const walk = async (dir, prefix = "") => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory())
          await walk(path.join(dir, entry.name), `${relative}/`);
        else if (entry.isFile() && /\.md$/i.test(entry.name))
          files.push(relative);
      }
    };
    await walk(postsDir);
    const posts = await Promise.all(
      files.map(async (filename) => {
        try {
          const raw = await fs.readFile(await postFile(filename), "utf8");
          const data = parsePost(raw);
          return {
            filename,
            title: data.title || filename,
            date: data.date,
            categories: data.categories,
            tags: data.tags,
            excerpt: data.content.replace(/[#*`>]/g, "").slice(0, 120),
          };
        } catch {
          return {
            filename,
            title: filename,
            date: "",
            categories: [],
            tags: [],
            error: "文章信息无法解析",
          };
        }
      }),
    );
    return posts.sort((a, b) => b.date.localeCompare(a.date));
  };
  const recordJob = async (job) => {
    jobs.set(job.id, job);
    await atomicJson(path.join(jobsDir, `${job.id}.json`), job);
  };
  const step = async (job, key, message, state = "running") => {
    job.stage = key;
    job.message = message;
    job.steps[key] = state;
    job.updatedAt = new Date().toISOString();
    await recordJob(job);
  };
  const fetchJson = async (url) => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Hane-local-writer",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new WriterError(
        `GitHub 部署查询暂时不可用（HTTP ${response.status}）。文章已推送，可打开 Actions 查看，稍后重试查询。`,
        502,
      );
    return response.json();
  };
  const monitor = async (job) => {
    if (!repository)
      throw new WriterError(
        "远端不是 GitHub 仓库，已推送，但无法自动查询 Pages 部署。",
        502,
      );
    await step(job, "deploy", "GitHub 正在构建并部署文章…");
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const data = await fetchJson(
        `https://api.github.com/repos/${repository}/actions/runs?head_sha=${job.commit}&per_page=20`,
      );
      const workflow = data.workflow_runs?.find(
        (item) => item.path?.split("@")[0] === ".github/workflows/pages.yml",
      );
      if (workflow) {
        job.actionsUrl = workflow.html_url;
        if (workflow.status === "completed") {
          if (workflow.conclusion !== "success")
            throw new WriterError(
              `文章已推送，但 GitHub Pages 部署结果是 ${workflow.conclusion}。请打开 Actions 查看日志。`,
              502,
            );
          await step(job, "deploy", "GitHub Pages 部署成功。", "done");
          break;
        }
        job.message =
          workflow.status === "queued"
            ? "文章已推送，等待 GitHub 开始构建…"
            : "GitHub 正在构建并部署文章…";
        await recordJob(job);
      }
      await sleep(deploymentPollMs);
    }
    if (job.steps.deploy !== "done")
      throw new WriterError(
        "文章已推送，部署仍在进行。可以打开 Actions 查看或稍后重试查询。",
        502,
      );
    await step(job, "live", "正在核对线上文章的标题和正文…");
    for (let attempt = 0; attempt < 12; attempt++) {
      const url = new URL(job.publicUrl);
      // Only contact the configured blog; front-matter permalinks cannot choose a service to probe.
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== new URL(config.url).origin
      )
        throw new WriterError(
          "文章链接不属于当前博客，请检查 permalink 配置。",
        );
      url.searchParams.set("writer_verify", `${job.commit}-${attempt}`);
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (response?.ok) {
        const html = plainText(await response.text());
        if (
          html.includes(job.title) &&
          (!job.excerpt || html.includes(job.excerpt))
        ) {
          job.status = "deployed";
          await step(job, "live", "文章已上线，标题和正文核对通过。", "done");
          return;
        }
      }
      await sleep(deploymentPollMs);
    }
    throw new WriterError(
      "GitHub 部署成功，但线上页面尚未核对通过。请打开文章检查，或稍后重试查询。",
      502,
    );
  };
  const syncLocal = async (job) => {
    try {
      const localBranch = await run("git", ["branch", "--show-current"], root);
      if (localBranch !== branch) throw new Error("当前工作分支不是发布分支");
      await run("git", ["fetch", "origin", branch], root);
      await run(
        "git",
        ["merge", "--ff-only", "--no-edit", `origin/${branch}`],
        root,
      );
      job.localSync = "本地文章已同步。";
    } catch {
      job.localSync =
        "文章已推送；本地有待合并的改动，未自动同步。草稿仍保留在写作台。";
    }
    await recordJob(job);
  };
  const finishError = async (job, error) => {
    job.status = job.pushed ? "attention" : "failed";
    job.steps[job.stage] = "error";
    job.message = error.message;
    await recordJob(job);
  };
  const executePublish = async (job, draft) => {
    let scratch;
    try {
      const desired = serializeDraft(draft);
      await step(job, "prepare", "正在读取 GitHub 上的最新版本…");
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "hane-writer-"));
      await run(
        "git",
        ["clone", "--quiet", "--shared", "--no-checkout", root, scratch],
        root,
      );
      await run("git", ["remote", "set-url", "origin", remote], scratch);
      await run("git", ["fetch", "--quiet", "origin", branch], scratch);
      await run(
        "git",
        ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
        scratch,
      );
      const remotePost = await postFile(
        draft.filename,
        path.join(scratch, "source", "_posts"),
        { allowMissing: true },
      );
      const remoteContent = await readOptional(remotePost);
      assertRemoteUnchanged(draft, remoteContent, desired);
      // Keep concurrent edits by other tools out of a publication from this draft.
      const localContent = await readOptional(
        await postFile(draft.filename, postsDir, { allowMissing: true }),
      );
      if (
        localContent !== draft.baseContent &&
        localContent !== desired &&
        draft.kind !== "new"
      )
        throw new WriterError(
          "本地文章在草稿打开后发生了变化，请先导出草稿并重新打开文章。",
          409,
        );
      await fs.mkdir(path.dirname(remotePost), { recursive: true });
      await fs.writeFile(remotePost, desired);
      await step(job, "prepare", "文章已准备，正在独立目录里检查。", "done");
      await step(job, "build", "正在生成博客并检查文章页面…");
      await fs.symlink(
        path.join(root, "node_modules"),
        path.join(scratch, "node_modules"),
        "dir",
      );
      const output = await run(
        process.execPath,
        [path.join(appDir, "build.mjs"), scratch, draft.filename],
        scratch,
        180_000,
      );
      const result = output.match(/WRITER_RESULT:(.+)/);
      if (
        !result ||
        /(?:^|\s)(?:ERROR|FATAL)\b/m.test(output.replace(/\x1b\[[0-9;]*m/g, ""))
      )
        throw new WriterError(`博客构建失败：${output.slice(-1800)}`, 500);
      Object.assign(job, JSON.parse(result[1]));
      await step(job, "build", "构建通过，文章页面检查通过。", "done");
      if (job.mode === "check") {
        job.status = "checked";
        job.message = "发布检查通过。现在可以发布到 GitHub。";
        await recordJob(job);
        return;
      }
      if (!gitName || !gitEmail)
        throw new WriterError("请先为 Git 配置 user.name 和 user.email。");
      await step(job, "push", "正在将这篇文章提交到 GitHub…");
      const relative = `source/_posts/${draft.filename}`;
      await run("git", ["add", "--", relative], scratch);
      const changed = (
        await run("git", ["diff", "--cached", "--name-only", "-z"], scratch)
      )
        .split("\0")
        .filter(Boolean);
      if (changed.length) {
        if (changed.length !== 1 || changed[0] !== relative)
          throw new WriterError("提交包含了文章之外的文件，已停止发布。", 500);
        await run(
          "git",
          [
            "-c",
            `user.name=${gitName}`,
            "-c",
            `user.email=${gitEmail}`,
            "commit",
            "--quiet",
            "-m",
            `blog: ${draft.baseContent === null ? "publish" : "update"} ${draft.title}`,
            "--",
            relative,
          ],
          scratch,
        );
      }
      job.commit = await run("git", ["rev-parse", "HEAD"], scratch);
      await recordJob(job);
      if (changed.length) {
        try {
          await run(
            "git",
            ["push", "origin", `HEAD:refs/heads/${branch}`],
            scratch,
          );
        } catch (error) {
          // A lost SSH acknowledgement can occur after GitHub accepted the push.
          await run("git", ["fetch", "--quiet", "origin", branch], scratch);
          try {
            await run(
              "git",
              ["merge-base", "--is-ancestor", job.commit, "FETCH_HEAD"],
              scratch,
            );
          } catch {
            throw error;
          }
        }
      }
      job.pushed = true;
      await step(
        job,
        "push",
        changed.length
          ? "文章已推送到 GitHub。"
          : "GitHub 已有相同文章，正在核对部署。",
        "done",
      );
      await locked(draft.id, async () => {
        const latest = await readDraft(draft.id);
        // Preserve any content edited while this snapshot was being published.
        latest.baseContent = desired;
        latest.kind = "post";
        latest.lastPublished = {
          commit: job.commit,
          url: job.publicUrl,
          version: draft.version,
        };
        await atomicJson(draftPath(latest.id), latest);
      });
      await syncLocal(job);
      await monitor(job);
    } catch (error) {
      await finishError(job, error);
    } finally {
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
      if (busy === job.id) busy = null;
    }
  };

  const startJob = async (draft, mode) => {
    if (busy)
      throw new WriterError("已有一篇文章正在检查或发布，请等待它完成。", 409);
    validateDraft(draft, { publish: true });
    const job = {
      id: randomUUID(),
      draftId: draft.id,
      mode,
      title: draft.title,
      status: "running",
      stage: "prepare",
      steps: {},
      message: "正在准备文章…",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actionsUrl: repository
        ? `https://github.com/${repository}/actions`
        : null,
    };
    busy = job.id;
    await recordJob(job);
    void executePublish(job, draft);
    return job;
  };
  const bootstrap = async () => {
    const [posts, drafts] = await Promise.all([allPosts(), allDrafts()]);
    return {
      token,
      site: {
        title: config.title,
        author: config.author || "Hane",
        url: config.url,
        repository,
        branch,
        canPublish: Boolean(gitName && gitEmail),
        timezone: "Asia/Shanghai",
      },
      posts,
      drafts: drafts.map(publicDraft),
      categories: list(posts.flatMap((post) => post.categories)),
      tags: list(posts.flatMap((post) => post.tags)),
      jobs: [...jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 12),
    };
  };
  const body = async (req) => {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new WriterError("请求必须是 JSON。", 415);
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 2_100_000)
        throw new WriterError("文章超过 2 MB，请拆分或缩短。", 413);
    }
    try {
      return JSON.parse(raw || "{}");
    } catch {
      throw new WriterError("请求格式错误。");
    }
  };
  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const host = req.headers.host;
      if (
        ![new URL(origin).host, `localhost:${server.address().port}`].includes(
          host,
        ) ||
        (req.headers.origin &&
          ![origin, `http://localhost:${server.address().port}`].includes(
            req.headers.origin,
          ))
      )
        throw new WriterError("写作台只接受本机页面的请求。", 403);
      const url = new URL(req.url, origin);
      const pathname = url.pathname;
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers["x-writer-token"] !== token
      )
        throw new WriterError("会话已过期，请刷新写作台后重试。", 403);
      if (pathname === "/api/bootstrap" && req.method === "GET")
        return sendJson(res, await bootstrap());
      if (pathname === "/api/drafts" && req.method === "POST") {
        const input = await body(req);
        const fields = validateDraft(input);
        const draft = await saveDraft({
          id: randomUUID(),
          kind: "new",
          baseContent: null,
          ...fields,
        });
        return sendJson(res, publicDraft(draft), 201);
      }
      if (pathname === "/api/drafts/from-post" && req.method === "POST") {
        const input = await body(req);
        const filename = safeFilename(input.filename);
        return await locked(`post:${filename}`, async () => {
          const existing = (await allDrafts()).find(
            (draft) => draft.kind === "post" && draft.filename === filename,
          );
          if (existing) return sendJson(res, publicDraft(existing));
          const raw = await fs.readFile(await postFile(filename), "utf8");
          const { metadata, ...fields } = parsePost(raw);
          const draft = await saveDraft({
            id: randomUUID(),
            kind: "post",
            filename,
            baseContent: raw,
            ...fields,
          });
          return sendJson(res, publicDraft(draft), 201);
        });
      }
      const draftMatch = pathname.match(/^\/api\/drafts\/([a-f0-9-]{36})$/);
      if (draftMatch && req.method === "GET")
        return sendJson(res, publicDraft(await readDraft(draftMatch[1])));
      if (draftMatch && req.method === "PUT") {
        const input = await body(req);
        return await locked(draftMatch[1], async () => {
          const original = await readDraft(draftMatch[1]);
          if (busy && jobs.get(busy)?.draftId === original.id)
            throw new WriterError(
              "这篇文章正在检查或发布，请完成后继续编辑。",
              409,
            );
          if (input.version !== original.version)
            throw new WriterError(
              "这篇草稿已在另一个窗口更新。请先导出当前内容，再刷新。",
              409,
            );
          const fields = validateDraft(input);
          if (original.kind === "post" && fields.filename !== original.filename)
            throw new WriterError("编辑已有文章时不能更改文件名。");
          return sendJson(
            res,
            publicDraft(await saveDraft({ ...original, ...fields })),
          );
        });
      }
      if (draftMatch && req.method === "DELETE") {
        const input = await body(req);
        return await locked(draftMatch[1], async () => {
          const draft = await readDraft(draftMatch[1]);
          if (input.version !== draft.version)
            throw new WriterError("草稿有新版本，请刷新后再删除。", 409);
          if (busy && jobs.get(busy)?.draftId === draft.id)
            throw new WriterError(
              "文章正在检查或发布，请完成后再删除草稿。",
              409,
            );
          await fs.unlink(draftPath(draft.id));
          return sendJson(res, { ok: true });
        });
      }
      if (pathname === "/api/export" && req.method === "POST") {
        const input = await body(req);
        const draft = await readDraft(input.draftId);
        if (input.version !== draft.version)
          throw new WriterError("草稿有新版本，请刷新后导出。", 409);
        return sendJson(res, {
          filename: draft.filename,
          markdown: serializeDraft(draft),
        });
      }
      if (
        (pathname === "/api/publish" || pathname === "/api/check") &&
        req.method === "POST"
      ) {
        const input = await body(req);
        return await locked(input.draftId, async () => {
          const draft = await readDraft(input.draftId);
          if (input.version !== draft.version)
            throw new WriterError("草稿有新版本，请刷新后重试。", 409);
          return sendJson(
            res,
            await startJob(
              draft,
              pathname.endsWith("check") ? "check" : "publish",
            ),
            202,
          );
        });
      }
      const jobMatch = pathname.match(
        /^\/api\/jobs\/([a-f0-9-]{36})(\/retry)?$/,
      );
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) throw new WriterError("没有找到发布记录。", 404);
        if (!jobMatch[2] && req.method === "GET") return sendJson(res, job);
        if (jobMatch[2] && req.method === "POST") {
          if (busy) throw new WriterError("已有发布正在进行。", 409);
          if (!job.pushed || !["attention", "deployed"].includes(job.status))
            throw new WriterError("这条记录没有可查询的线上版本。");
          busy = job.id;
          job.status = "running";
          void monitor(job)
            .catch((error) => finishError(job, error))
            .finally(() => {
              if (busy === job.id) busy = null;
            });
          return sendJson(res, job, 202);
        }
      }
      const staticFiles = {
        "/": ["public/index.html", "text/html"],
        "/style.css": ["public/style.css", "text/css"],
        "/app.js": ["public/app.js", "text/javascript"],
        "/vendor/marked.js": [
          "../node_modules/marked/lib/marked.esm.js",
          "text/javascript",
        ],
        "/vendor/purify.js": [
          "../node_modules/dompurify/dist/purify.es.mjs",
          "text/javascript",
        ],
      };
      if (staticFiles[pathname] && ["GET", "HEAD"].includes(req.method)) {
        const [file, type] = staticFiles[pathname];
        const data = await fs.readFile(path.resolve(appDir, file));
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`,
          "Cache-Control": "no-cache",
        });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      throw new WriterError("没有找到这个页面。", 404);
    } catch (error) {
      sendJson(
        res,
        {
          error:
            error.code === "ENOENT"
              ? "没有找到文章或依赖，请检查文件并运行 npm install。"
              : error.message,
        },
        error.status || 500,
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of await jsonFiles(jobsDir)) {
    const job = JSON.parse(await fs.readFile(path.join(jobsDir, name), "utf8"));
    if (job.status === "running") {
      job.status = job.pushed ? "attention" : "failed";
      job.message = job.pushed
        ? "服务曾重新启动，文章已推送。点击重新查询可继续检查部署。"
        : "服务在检查或推送时重新启动。请先查看 GitHub，再重试发布；相同内容不会重复提交。";
      job.steps[job.stage] = "error";
      await recordJob(job);
    }
    jobs.set(job.id, job);
  }
  return {
    server,
    origin,
    bootstrap,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.WRITER_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("WRITER_PORT 必须是 1 到 65535 之间的端口号。");
  const writer = await createWriter({
    root: process.env.WRITER_REPO_DIR || path.resolve(appDir, ".."),
    port,
  });
  console.log(
    `\n  Hane 写作台\n  ${writer.origin}\n  本地草稿会自动保存；发布后自动检查 GitHub Pages。\n`,
  );
  process.on("SIGINT", () => {
    writer.server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    writer.server.close();
    process.exit(0);
  });
}
