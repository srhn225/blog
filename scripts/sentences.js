const fs = require('node:fs/promises');
const path = require('node:path');
const { parseSentence, homepageEligible, escapeHtml, sentenceRules } = require('../lib/sentences.cjs');
let fallback;

hexo.extend.filter.register('before_generate', async function () {
  const directory = path.join(this.source_dir, '_sentences');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const sentences = await Promise.all(entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.md')).map(async entry => {
    const sentence = parseSentence(await fs.readFile(path.join(directory, entry.name), 'utf8'));
    if (!sentence.content || sentence.content.includes('\0') || Array.from(sentence.content).length > sentenceRules.limit) throw new Error(`短句 ${entry.name} 的内容无效。`);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sentence.date)) throw new Error(`短句 ${entry.name} 的日期无效。`);
    return { ...sentence, filename: entry.name, anchor: 'sentence-' + entry.name.slice(0, -3), showOnHomepage: sentence.homepage && homepageEligible(sentence.content) };
  }));
  sentences.sort((a, b) => b.date.localeCompare(a.date) || a.filename.localeCompare(b.filename));
  this.locals.set('sentences', () => sentences);
  const subtitle = this.theme.config.subtitle;
  fallback ??= [...(subtitle.sub || [])];
  // Typed.js interprets HTML. Encode user text before placing it inside an inline script.
  subtitle.sub = [...new Set([...sentences.filter(sentence => sentence.showOnHomepage).map(sentence => escapeHtml(sentence.content)), ...fallback])];
});

hexo.extend.generator.register('sentences', function (locals) {
  const sentences = locals.sentences || [];
  const cards = sentences.map(sentence => `<article class="sentence-card" id="${escapeHtml(sentence.anchor)}"><span class="sentence-quote" aria-hidden="true">“</span><p class="sentence-text">${escapeHtml(sentence.content)}</p><footer class="sentence-meta"><span>${escapeHtml(sentence.author || this.config.author)}</span><a class="sentence-permalink" href="#${encodeURIComponent(sentence.anchor)}" aria-label="这条短句的链接"><time datetime="${sentence.date.replace(' ', 'T')}+08:00">${sentence.date.slice(0, 16)}</time></a>${sentence.showOnHomepage ? '<span class="sentence-home-badge">首页一言</span>' : ''}</footer></article>`).join('');
  return {
    path: 'sentences/index.html',
    layout: ['page'],
    data: {
      title: '短句',
      type: 'sentences',
      __page: true,
      content: `<section class="sentence-board" aria-label="Hane 与 Ame 的短句"><div class="sentence-board-intro"><span class="sentence-eyebrow">HANE × AME · WORDS IN THE RAIN</span><h2>留下一句，此刻的心情。</h2><p>有些想法还不需要写成文章。把它们放在这里，让一句话也有自己的位置。</p><span class="sentence-total">${sentences.length} 条短句</span></div><div class="sentence-list">${cards || '<p class="sentence-empty">窗外有雨，纸上还有空白。等我们写下第一句。</p>'}</div></section>`,
    },
  };
});
