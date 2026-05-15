(function () {
  if (document.getElementById('rain-canvas')) return;

  var mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mediaQuery.matches) return;

  var canvas = document.createElement('canvas');
  canvas.id = 'rain-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  var ctx = canvas.getContext('2d');
  var drops = [];
  var width = 0;
  var height = 0;
  var dpr = 1;
  var animationId = 0;
  var lastTime = 0;
  var storageKey = 'hane-rain-size';
  var minRainSize = 1;
  var maxRainSize = 5;
  var defaultRainSize = 3;
  var rainSize = readRainSize();

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function readRainSize() {
    try {
      var stored = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(stored)) return clampRainSize(stored);
    } catch (error) {
      return defaultRainSize;
    }
    return defaultRainSize;
  }

  function clampRainSize(value) {
    return Math.min(maxRainSize, Math.max(minRainSize, value));
  }

  function formatRainSize(value) {
    return value.toFixed(1);
  }

  function getRainProgress() {
    return (rainSize - minRainSize) / (maxRainSize - minRainSize) * 100;
  }

  function getRainProfile() {
    var level = (rainSize - minRainSize) / (maxRainSize - minRainSize);
    var swell = level * level;

    return {
      size: 0.76 + level * 0.88 + swell * 0.46,
      count: 0.66 + level * 0.92 + swell * 0.48,
      alpha: 0.8 + level * 0.34 + swell * 0.16,
      speed: 0.86 + level * 0.44 + swell * 0.28
    };
  }

  function createDrop(initial) {
    var depth = random(0.45, 1);
    return {
      x: random(-width * 0.1, width * 1.05),
      y: initial ? random(-height, height) : random(-height * 0.24, -18),
      length: random(12, 28) * depth,
      speed: random(260, 580) * depth,
      drift: random(-24, -8) * depth,
      alpha: random(0.16, 0.38) * depth,
      width: random(0.7, 1.5) * depth
    };
  }

  function syncDropCount() {
    var profile = getRainProfile();
    var baseCount = Math.max(54, Math.min(142, Math.floor(width * height / 11200)));
    var targetCount = Math.max(38, Math.min(270, Math.floor(baseCount * profile.count)));

    if (drops.length > targetCount) {
      drops.length = targetCount;
      return;
    }

    while (drops.length < targetCount) {
      drops.push(createDrop(true));
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drops = [];
    syncDropCount();
  }

  function drawDrop(drop) {
    var profile = getRainProfile();
    var length = drop.length * profile.size;
    var alpha = drop.alpha * profile.alpha;
    var gradient = ctx.createLinearGradient(drop.x, drop.y, drop.x + drop.drift * 0.04, drop.y + length);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(0.26, 'rgba(210, 240, 255, ' + alpha + ')');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = drop.width * profile.size;
    ctx.beginPath();
    ctx.moveTo(drop.x, drop.y);
    ctx.lineTo(drop.x + drop.drift * 0.08, drop.y + length);
    ctx.stroke();
  }

  function frame(time) {
    var delta = Math.min(32, time - (lastTime || time));
    lastTime = time;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    var profile = getRainProfile();
    for (var i = 0; i < drops.length; i += 1) {
      var drop = drops[i];
      drop.y += drop.speed * profile.speed * delta / 1000;
      drop.x += drop.drift * delta / 1000;

      if (drop.y > height + 40 || drop.x < -60) {
        drops[i] = createDrop(false);
        drop = drops[i];
      }

      drawDrop(drop);
    }

    animationId = window.requestAnimationFrame(frame);
  }

  function start() {
    createRainControl();
    resize();
    animationId = window.requestAnimationFrame(frame);
  }

  function createRainControl() {
    if (document.getElementById('rain-control')) return;

    var control = document.createElement('div');
    control.id = 'rain-control';
    control.innerHTML = [
      '<button class="rain-control-toggle" type="button" aria-expanded="false" title="雨">',
      '<i class="fas fa-cloud-rain" aria-hidden="true"></i>',
      '</button>',
      '<div class="rain-control-panel" aria-hidden="true">',
      '<div class="rain-control-head">',
      '<span>雨</span>',
      '<output class="rain-control-value">' + formatRainSize(rainSize) + '</output>',
      '</div>',
      '<input class="rain-control-range" type="range" min="' + minRainSize + '" max="' + maxRainSize + '" step="0.01" value="' + rainSize + '" aria-label="雨">',
      '<div class="rain-control-scale"><span>细</span><span>雨</span><span>骤</span></div>',
      '</div>'
    ].join('');

    document.body.appendChild(control);

    var toggle = control.querySelector('.rain-control-toggle');
    var panel = control.querySelector('.rain-control-panel');
    var range = control.querySelector('.rain-control-range');
    var output = control.querySelector('.rain-control-value');

    function updateControlVisual() {
      output.textContent = formatRainSize(rainSize);
      range.style.setProperty('--rain-progress', getRainProgress() + '%');
    }

    toggle.addEventListener('click', function () {
      var open = control.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-hidden', String(!open));
    });

    updateControlVisual();

    range.addEventListener('input', function () {
      rainSize = clampRainSize(Number(range.value));
      updateControlVisual();
      try {
        window.localStorage.setItem(storageKey, String(rainSize));
      } catch (error) {
        // Ignore storage failures; the visual control still works for this page.
      }
      syncDropCount();
    });
  }

  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      window.cancelAnimationFrame(animationId);
      animationId = 0;
      return;
    }

    if (!animationId) {
      lastTime = 0;
      animationId = window.requestAnimationFrame(frame);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}());
