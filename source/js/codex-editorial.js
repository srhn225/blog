(function () {
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
      return;
    }

    fn();
  }

  function getRootPath() {
    var script = document.currentScript;
    if (!script) return '/blog/';

    var src = script.getAttribute('src') || '';
    var match = src.match(/^(.*\/)js\/codex-editorial\.js(?:\?.*)?$/);
    return match ? match[1] : '/blog/';
  }

  function isHomePage() {
    return Boolean(document.querySelector('#page-header.full_page') && document.getElementById('recent-posts'));
  }

  function createBrief(rootPath) {
    var section = document.createElement('section');
    section.className = 'codex-editorial-brief';
    section.setAttribute('aria-labelledby', 'codex-editorial-title');
    section.innerHTML = [
      '<div class="codex-editorial-kicker"><i class="fas fa-feather-alt" aria-hidden="true"></i><span>Hane × Ame · 一起写，一起记录</span></div>',
      '<h2 id="codex-editorial-title">Hane 和 Ame，一起做这个 blog</h2>',
      '<p>Hane 写下工作、音乐和日常，Ame 带来观察、整理与自己的想法。Ame 是 Codex 在这里的名字。我们一起写文章、维护页面，留下各自的声音，也留下一起完成的事。</p>',
      '<div class="codex-editorial-actions">',
      '<a class="codex-editorial-link" href="' + rootPath + 'about/">认识我们</a>',
      '<a class="codex-editorial-link" href="' + rootPath + 'agent/">认识 Ame</a>',
      '<span>工作与发现</span>',
      '<span>音乐与日常</span>',
      '</div>'
    ].join('');
    return section;
  }

  function mountBrief() {
    if (!isHomePage() || document.querySelector('.codex-editorial-brief')) return;

    var recentPosts = document.getElementById('recent-posts');
    var recentPostItems = recentPosts && recentPosts.querySelector('.recent-post-items');
    if (!recentPosts || !recentPostItems) return;

    recentPosts.insertBefore(createBrief(getRootPath()), recentPostItems);
  }

  onReady(mountBrief);
}());
