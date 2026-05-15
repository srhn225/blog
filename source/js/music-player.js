(function () {
  window.addEventListener('load', function () {
    if (typeof window.loadMeting === 'function' && !document.querySelector('.music-page-aplayer .aplayer-body')) {
      window.loadMeting();
    }
  });
}());
