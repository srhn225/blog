const yaml = require('js-yaml');

const sentenceRules = Object.freeze({ min: 2, max: 60, limit: 500 });
const sentenceLength = text => Array.from(String(text).trim()).length;
const homepageEligible = text => {
  const length = sentenceLength(text);
  return length >= sentenceRules.min && length <= sentenceRules.max && !/[\r\n]/.test(String(text).trim());
};
const sentenceTitle = text => Array.from(String(text).trim().replace(/\s+/g, ' ')).slice(0, 36).join('');
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function parseSentence(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('短句缺少日期和作者信息。');
  const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('短句信息格式有误。');
  const content = raw.slice(match[0].length).trim();
  return {
    metadata,
    contentType: 'sentence',
    title: sentenceTitle(content),
    date: String(metadata.date || ''),
    author: String(metadata.author || ''),
    homepage: metadata.homepage !== false,
    content,
    categories: [],
    tags: [],
    cover: '',
  };
}

module.exports = { sentenceRules, sentenceLength, homepageEligible, sentenceTitle, escapeHtml, parseSentence };
