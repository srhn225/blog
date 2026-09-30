import fs from "node:fs/promises";
import path from "node:path";
import Hexo from "hexo";
import { plainText, escapeHtml } from "./core.mjs";

const [root, filename, type = "post"] = process.argv.slice(2);
const hexo = new Hexo(root, { silent: false });
try {
  await hexo.init();
  await hexo.call("generate", { bail: true, force: true });
  let result;
  if (type === "sentence") {
    const sentence = hexo.locals.get("sentences").find(item => item.filename === filename);
    if (!sentence) throw new Error("短句没有被博客识别。");
    const board = await fs.readFile(path.join(hexo.public_dir, "sentences/index.html"), "utf8");
    if (!board.includes(`id="${escapeHtml(sentence.anchor)}"`) || !plainText(board).includes(sentence.content.replace(/\s+/g, " "))) throw new Error("短句分区缺少这条句子。");
    if (sentence.showOnHomepage) {
      const home = await fs.readFile(path.join(hexo.public_dir, "index.html"), "utf8");
      if (!home.includes(JSON.stringify(escapeHtml(sentence.content)))) throw new Error("首页一言没有收录这条短句。");
    }
    result = {
      publicUrl: `${hexo.config.url.replace(/\/$/, "")}/sentences/#${encodeURIComponent(sentence.anchor)}`,
      title: sentence.title,
      excerpt: sentence.content.replace(/\s+/g, " ").slice(0, 65),
      homepageText: sentence.showOnHomepage ? sentence.content : null,
    };
  } else {
    const post = hexo.locals
      .get("posts")
      .toArray()
      .find(
        (p) =>
          path.resolve(p.full_source) ===
          path.join(root, "source", "_posts", filename),
      );
    if (!post)
      throw new Error(
        "文章没有被 Hexo 识别为公开文章，请检查 layout、published 等文章信息。",
      );
    const htmlPath = path.join(
      hexo.public_dir,
      post.path.endsWith("/") ? `${post.path}index.html` : post.path,
    );
    const html = await fs.readFile(htmlPath, "utf8");
    const excerpt = plainText(post.content).slice(0, 65);
    if (
      !plainText(html).includes(post.title) ||
      (excerpt && !plainText(html).includes(excerpt))
    )
      throw new Error("生成的文章页面缺少标题或正文。");
    for (const category of post.categories.toArray()) {
      const routes = hexo.route
        .list()
        .filter(
          (route) =>
            route.startsWith(category.path) && route.endsWith("index.html"),
        );
      const pages = await Promise.all(
        routes.map((route) =>
          fs.readFile(path.join(hexo.public_dir, route), "utf8"),
        ),
      );
      if (!pages.some((page) => plainText(page).includes(post.title)))
        throw new Error(`分类“${category.name}”没有生成包含本文的归档页面。`);
    }
    result = { publicUrl: post.permalink, title: post.title, excerpt };
  }
  process.stdout.write(
    `\nWRITER_RESULT:${JSON.stringify(result)}\n`,
  );
  await hexo.exit();
} catch (error) {
  console.error(error.message);
  await hexo.exit(error);
  process.exitCode = 1;
}
