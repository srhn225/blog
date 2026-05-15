---
title: 留言板
date: 2026-05-15 11:20:00
comments: false
---

<div class="guestbook-board" id="guestbook-board">
  <form class="guestbook-form" data-guestbook-form>
    <div class="guestbook-fields">
      <input name="name" maxlength="24" placeholder="名字" autocomplete="name">
    </div>
    <textarea name="message" maxlength="300" placeholder="写点什么..." required></textarea>
    <div class="guestbook-actions">
      <button type="submit"><i class="fas fa-paper-plane"></i><span>发送留言</span></button>
      <button type="button" data-guestbook-clear><i class="fas fa-rotate-left"></i><span>重置本地留言</span></button>
      <span class="guestbook-hint">留言保存在当前浏览器。</span>
    </div>
  </form>
  <div class="guestbook-list" data-guestbook-list></div>
</div>

<script src="/blog/js/guestbook.js"></script>
