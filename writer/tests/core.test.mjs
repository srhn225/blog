import test from "node:test";
import assert from "node:assert/strict";
import {
  safeFilename,
  parsePost,
  serializeDraft,
  validateDraft,
  assertRemoteUnchanged,
  shanghaiDate,
  githubRepository,
  parseSentence,
  homepageEligible,
  sentenceLength,
  escapeHtml,
  plainText,
} from "../core.mjs";

const original =
  "---\ntitle: 原文章\ndate: 2026-09-30 10:00:00\nauthor: Codex\ncopyright_author: Codex\ncategories:\n  - [研究, 方法]\ntags: [记录, Markdown]\ncover: false\ncomments: false\ncustom_option: keep-me\n---\n\n一段正文。\n";
const draft = () => {
  const { metadata, ...fields } = parsePost(original);
  return { ...fields, filename: "原文章.md", baseContent: original };
};

test("unchanged articles preserve exact bytes and nested metadata", () => {
  assert.equal(serializeDraft(draft()), original);
  const changed = serializeDraft({
    ...draft(),
    title: "新标题",
    content: "新的正文。",
    author: "Hane",
  });
  const parsed = parsePost(changed);
  assert.deepEqual(parsed.metadata.categories, [["研究", "方法"]]);
  assert.equal(parsed.metadata.comments, false);
  assert.equal(parsed.metadata.cover, false);
  assert.equal(parsed.metadata.custom_option, "keep-me");
  assert.equal(parsed.metadata.author, "Hane");
  assert.equal(parsed.metadata.copyright_author, "Hane");
});

test("sentence drafts keep plain text and use Unicode lengths for homepage selection", () => {
  const sentence = { ...draft(), contentType: "sentence", baseContent: null, content: "  雨会停，想法会留下。  ", homepage: true };
  const serialized = serializeDraft(sentence);
  const parsed = parseSentence(serialized);
  assert.equal(parsed.content, "雨会停，想法会留下。");
  assert.equal(parsed.author, "Codex");
  assert.equal(parsed.homepage, true);
  assert.equal(serializeDraft({ ...parsed, filename: "sentence.md", baseContent: serialized }), serialized);
  assert.equal(sentenceLength("🌧️和雨"), 4);
  assert.equal(homepageEligible("雨"), false);
  assert.equal(homepageEligible("雨停"), true);
  assert.equal(homepageEligible("雨".repeat(60)), true);
  assert.equal(homepageEligible("雨".repeat(61)), false);
  assert.equal(homepageEligible("雨停\n天晴"), false);
  assert.equal(homepageEligible("🌧".repeat(60)), true);
  assert.throws(() => validateDraft({ ...sentence, content: "雨".repeat(501) }));
  assert.throws(() => validateDraft({ ...sentence, homepage: "false" }));
  assert.throws(() => validateDraft({ ...sentence, contentType: "../post" }));
  assert.throws(() => validateDraft({ ...sentence, content: "" }, { publish: true }));
  assert.equal(escapeHtml('</script><img onerror="alert(1)">'), '&lt;/script&gt;&lt;img onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(plainText('<p>&amp;lt;img&amp;gt; &lt;b&gt; &quot;雨&quot;</p>'), '&lt;img&gt; <b> "雨"');
  assert.equal(parseSentence(serializeDraft({ ...sentence, date: "2026-09-30 10:00", homepage: false })).date, "2026-09-30 10:00:00");
});

test("filenames reject traversal and accept Unicode article names", () => {
  assert.equal(safeFilename("随笔/我的故事.md"), "随笔/我的故事.md");
  for (const name of [
    "../a.md",
    "/a.md",
    "a/../b.md",
    "a//b.md",
    "a\\b.md",
    ".private.md",
    "a.txt",
    "a\0.md",
  ])
    assert.throws(() => safeFilename(name));
});

test("validates dates and required publication fields", () => {
  assert.equal(
    shanghaiDate(new Date("2026-09-29T16:00:00Z")),
    "2026-09-30 00:00:00",
  );
  assert.throws(() =>
    validateDraft({ ...draft(), date: "2026-02-30 12:00:00" }),
  );
  assert.throws(() =>
    validateDraft({ ...draft(), title: "" }, { publish: true }),
  );
  assert.throws(() =>
    validateDraft({ ...draft(), cover: "javascript:alert(1)" }),
  );
  assert.doesNotThrow(() =>
    validateDraft({ ...draft(), title: "", content: "" }),
  );
});

test("publication refuses remote edits and filename collisions", () => {
  assert.doesNotThrow(() => assertRemoteUnchanged(draft(), original, "new"));
  assert.throws(() =>
    assertRemoteUnchanged(draft(), "someone else updated it", "new"),
  );
  assert.throws(() =>
    assertRemoteUnchanged({ baseContent: null }, original, "new"),
  );
  assert.doesNotThrow(() =>
    assertRemoteUnchanged(
      { baseContent: null },
      "already pushed",
      "already pushed",
    ),
  );
  assert.throws(() => assertRemoteUnchanged(draft(), null, "new"));
});

test("only recognized GitHub remotes are used for deployment queries", () => {
  assert.equal(
    githubRepository("git@github.com:srhn225/blog.git"),
    "srhn225/blog",
  );
  assert.equal(
    githubRepository("https://github.com/srhn225/blog.git"),
    "srhn225/blog",
  );
  assert.equal(
    githubRepository("ssh://git@github.com/srhn225/blog.git"),
    "srhn225/blog",
  );
  assert.equal(
    githubRepository("https://github.com.evil.example/srhn225/blog"),
    null,
  );
  assert.equal(githubRepository("/tmp/local-remote.git"), null);
});
