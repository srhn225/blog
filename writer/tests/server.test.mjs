import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createWriter, run, sleep } from "../server.mjs";
import { hash } from "../core.mjs";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
let temporary, root, remote, writer, token;

async function request(route, method = "GET", value, extraHeaders = {}) {
  const response = await fetch(`${writer.origin}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Writer-Token": token || "",
      ...extraHeaders,
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const data = await response.json();
  return { status: response.status, data };
}
const newDraft = (filename) => ({
  title: "测试文章",
  content: "这是一篇用于验证写作台的文章。\n\n## 小标题\n\n第二段正文。",
  filename,
  date: "2026-09-30 12:30:00",
  categories: ["日常"],
  tags: ["测试"],
  author: "Hane",
  cover: "",
});
async function waitJob(id) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const { data } = await request(`/api/jobs/${id}`);
    if (data.status !== "running") return data;
    await sleep(100);
  }
  throw new Error("test publication did not finish");
}

test.before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "writer-tests-"));
  root = path.join(temporary, "blog");
  remote = path.join(temporary, "remote.git");
  await run("git", ["clone", "--quiet", "--shared", project, root], project);
  await run("git", ["checkout", "--quiet", "-B", "main"], root);
  await run("git", ["config", "user.name", "Writer Tests"], root);
  await run(
    "git",
    ["config", "user.email", "writer-tests@example.invalid"],
    root,
  );
  await run("git", ["clone", "--quiet", "--bare", root, remote], root);
  await run("git", ["remote", "set-url", "origin", remote], root);
  await fs.symlink(
    path.join(project, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  // Changes which publication must never build, stage, or overwrite.
  await fs.writeFile(path.join(root, "db.json"), "unrelated dirty cache\n");
  await fs.writeFile(
    path.join(root, "keep-staged.txt"),
    "unrelated staged change\n",
  );
  await run("git", ["add", "--", "keep-staged.txt"], root);
  await fs.writeFile(
    path.join(root, "keep-untracked.txt"),
    "private local notes\n",
  );
  await fs.appendFile(path.join(root, ".git/info/exclude"), "\n/.writer\n");
  writer = await createWriter({ root, port: 0 });
  const result = await request("/api/bootstrap");
  token = result.data.token;
});
test.after(async () => {
  if (writer) await writer.close();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test("blocks foreign origins, invalid hosts and missing session tokens", async () => {
  const outside = await request("/api/bootstrap", "GET", null, {
    Origin: "https://evil.example",
  });
  assert.equal(outside.status, 403);
  // Native fetch rewrites Host, so use an HTTP request to exercise DNS rebinding protection.
  const dnsRebind = await new Promise((resolve, reject) => {
    http
      .get(
        `${writer.origin}/api/bootstrap`,
        { headers: { Host: "evil.example" } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      )
      .on("error", reject);
  });
  assert.equal(dnsRebind, 403);
  const withoutToken = await request("/api/drafts", "POST", newDraft("x.md"), {
    "X-Writer-Token": "",
  });
  assert.equal(withoutToken.status, 403);
});

test("saves drafts separately, rejects stale writes, and exports Markdown", async () => {
  const created = await request(
    "/api/drafts",
    "POST",
    newDraft("draft-only.md"),
  );
  assert.equal(created.status, 201);
  assert.equal(
    await fs
      .stat(path.join(root, "source/_posts/draft-only.md"))
      .catch(() => null),
    null,
  );
  const saved = await request(`/api/drafts/${created.data.id}`, "PUT", {
    ...created.data,
    title: "保存后的标题",
  });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.data.version, created.data.version);
  const stale = await request(
    `/api/drafts/${created.data.id}`,
    "PUT",
    created.data,
  );
  assert.equal(stale.status, 409);
  const exported = await request("/api/export", "POST", {
    draftId: saved.data.id,
    version: saved.data.version,
  });
  assert.match(exported.data.markdown, /保存后的标题/);
  assert.match(exported.data.markdown, /copyright_author: Hane/);
  const removed = await request(`/api/drafts/${created.data.id}`, "DELETE", {
    version: saved.data.version,
  });
  assert.equal(removed.status, 200);
});

test("refuses to open symlink articles", async () => {
  await fs.symlink(
    path.join(root, "keep-untracked.txt"),
    path.join(root, "source/_posts/symlink.md"),
  );
  const result = await request("/api/drafts/from-post", "POST", {
    filename: "symlink.md",
  });
  assert.equal(result.status, 400);
});

test("preflight builds the real Hexo site without mutating repository state", async () => {
  const dbHash = hash(await fs.readFile(path.join(root, "db.json")));
  const before = await run("git", ["status", "--porcelain", "-z"], root);
  const head = await run("git", ["rev-parse", "HEAD"], root);
  const created = await request(
    "/api/drafts",
    "POST",
    newDraft("writer-preflight.md"),
  );
  const result = await request("/api/check", "POST", {
    draftId: created.data.id,
    version: created.data.version,
  });
  assert.equal(result.status, 202);
  const job = await waitJob(result.data.id);
  assert.equal(job.status, "checked", job.message);
  assert.equal(job.steps.build, "done");
  assert.equal(hash(await fs.readFile(path.join(root, "db.json"))), dbHash);
  assert.equal(await run("git", ["status", "--porcelain", "-z"], root), before);
  assert.equal(await run("git", ["rev-parse", "HEAD"], root), head);
  assert.equal(
    await run("git", ["rev-parse", "refs/heads/main"], remote),
    head,
  );
});

test("publishes only the selected Unicode post and preserves unrelated staged work", async () => {
  const beforeHead = await run("git", ["rev-parse", "HEAD"], root);
  const dbHash = hash(await fs.readFile(path.join(root, "db.json")));
  const indexBefore = await run("git", ["diff", "--cached", "--binary"], root);
  const created = await request(
    "/api/drafts",
    "POST",
    newDraft("我的测试文章.md"),
  );
  const result = await request("/api/publish", "POST", {
    draftId: created.data.id,
    version: created.data.version,
  });
  assert.equal(result.status, 202);
  const duplicate = await request("/api/publish", "POST", {
    draftId: created.data.id,
    version: created.data.version,
  });
  assert.equal(duplicate.status, 409);
  const concurrentEdit = await request(
    `/api/drafts/${created.data.id}`,
    "PUT",
    { ...created.data, filename: "changed-during-publish.md" },
  );
  assert.equal(concurrentEdit.status, 409);
  const job = await waitJob(result.data.id);
  assert.equal(job.pushed, true, job.message);
  assert.equal(job.status, "attention"); // The fixture intentionally uses a local bare remote.
  const remoteHead = await run("git", ["rev-parse", "refs/heads/main"], remote);
  assert.equal(remoteHead, job.commit);
  assert.equal(
    await run(
      "git",
      ["diff", "--name-only", "-z", beforeHead, remoteHead],
      root,
    ),
    "source/_posts/我的测试文章.md\0",
  );
  assert.equal(hash(await fs.readFile(path.join(root, "db.json"))), dbHash);
  assert.equal(
    await run("git", ["diff", "--cached", "--binary"], root),
    indexBefore,
  );
  assert.equal(
    await fs.readFile(path.join(root, "keep-untracked.txt"), "utf8"),
    "private local notes\n",
  );
  assert.ok(job.localSync.includes("已同步"));
  const current = await request(`/api/drafts/${created.data.id}`);
  assert.equal(current.data.kind, "post");
  assert.equal(current.data.version, created.data.version);
  assert.equal(current.data.lastPublished.commit, job.commit);
  // An identical retry must not create another commit, even when deployment query is unavailable.
  const retry = await request("/api/publish", "POST", {
    draftId: current.data.id,
    version: current.data.version,
  });
  const repeated = await waitJob(retry.data.id);
  assert.equal(repeated.commit, job.commit);
  assert.equal(
    await run("git", ["rev-parse", "refs/heads/main"], remote),
    job.commit,
  );
});

test("remote changes stop publication instead of overwriting another edit", async () => {
  const filename = "rainy-night-notes.md";
  const opened = await request("/api/drafts/from-post", "POST", { filename });
  const edited = await request(`/api/drafts/${opened.data.id}`, "PUT", {
    ...opened.data,
    content: "我在本地草稿里写下的新内容。",
  });
  const other = path.join(temporary, "other-editor");
  await run("git", ["clone", "--quiet", remote, other], root);
  await fs.appendFile(
    path.join(other, "source/_posts", filename),
    "\n另一个编辑者的新内容。\n",
  );
  await run("git", ["add", "--", `source/_posts/${filename}`], other);
  await run(
    "git",
    [
      "-c",
      "user.name=Other Writer",
      "-c",
      "user.email=other@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "edit in another checkout",
    ],
    other,
  );
  await run("git", ["push", "--quiet", "origin", "main"], other);
  const head = await run("git", ["rev-parse", "refs/heads/main"], remote);
  const started = await request("/api/publish", "POST", {
    draftId: edited.data.id,
    version: edited.data.version,
  });
  const job = await waitJob(started.data.id);
  assert.equal(job.status, "failed");
  assert.match(job.message, /GitHub 上有了新版本/);
  assert.equal(
    await run("git", ["rev-parse", "refs/heads/main"], remote),
    head,
  );
  assert.equal(
    (await request(`/api/drafts/${edited.data.id}`)).data.content,
    "我在本地草稿里写下的新内容。",
  );
});
