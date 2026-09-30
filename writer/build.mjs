import fs from "node:fs/promises";
import path from "node:path";
import Hexo from "hexo";
import { plainText } from "./core.mjs";

const [root, filename] = process.argv.slice(2);
const hexo = new Hexo(root, { silent: false });
try {
  await hexo.init();
  await hexo.call("generate", { bail: true, force: true });
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
  process.stdout.write(
    `\nWRITER_RESULT:${JSON.stringify({ publicUrl: post.permalink, title: post.title, excerpt })}\n`,
  );
  await hexo.exit();
} catch (error) {
  console.error(error.message);
  await hexo.exit(error);
  process.exitCode = 1;
}
