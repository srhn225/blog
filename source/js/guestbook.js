(function () {
  var root = document.getElementById('guestbook-board');
  if (!root || root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';

  var storageKey = 'hane-blog-guestbook';
  var form = root.querySelector('[data-guestbook-form]');
  var list = root.querySelector('[data-guestbook-list]');
  var clearButton = root.querySelector('[data-guestbook-clear]');
  var formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  var seedMessages = [
    {
      name: 'Hane',
      message: '欢迎来到留言板。这里适合放短句、想法和到此一游。',
      createdAt: '2026-05-15T10:20:00+08:00'
    },
    {
      name: '雨天访客',
      message: '背景的雨滴很轻，像打开窗户听见的声音。',
      createdAt: '2026-05-15T10:32:00+08:00'
    }
  ];

  function readMessages() {
    try {
      var raw = window.localStorage.getItem(storageKey);
      if (!raw) return seedMessages.slice();
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : seedMessages.slice();
    } catch (error) {
      return seedMessages.slice();
    }
  }

  function saveMessages(messages) {
    window.localStorage.setItem(storageKey, JSON.stringify(messages));
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render() {
    var messages = readMessages();
    if (messages.length === 0) {
      list.innerHTML = '<div class="guestbook-empty">还没有留言。</div>';
      return;
    }

    list.innerHTML = messages.map(function (item) {
      var date = formatter.format(new Date(item.createdAt));
      return [
        '<article class="guestbook-message">',
        '<div class="guestbook-message-head">',
        '<span class="guestbook-message-name">' + escapeHTML(item.name || '匿名') + '</span>',
        '<time class="guestbook-message-date">' + escapeHTML(date) + '</time>',
        '</div>',
        '<p class="guestbook-message-body">' + escapeHTML(item.message || '') + '</p>',
        '</article>'
      ].join('');
    }).join('');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var formData = new FormData(form);
    var name = String(formData.get('name') || '').trim() || '匿名';
    var message = String(formData.get('message') || '').trim();
    if (!message) return;

    var messages = readMessages();
    messages.unshift({
      name: name.slice(0, 24),
      message: message.slice(0, 300),
      createdAt: new Date().toISOString()
    });
    saveMessages(messages);
    form.reset();
    render();
  });

  clearButton.addEventListener('click', function () {
    window.localStorage.removeItem(storageKey);
    render();
  });

  render();
}());
