(() => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  // Enhanced hideouts with more variety and personality
  const hideouts = [
    { selector: '.sidebar', side: 'right', bubble: 'lurking by controls ✨' },
    { selector: '.center', side: 'left', bubble: 'zoom zoom 💨' },
    { selector: '.right-panel', side: 'left', bubble: 'peekaboo 👀' },
    { selector: '.status-banner', side: 'right', bubble: 'mission ready ⚡' },
    { selector: '.challenge-card', side: 'left', bubble: 'bonus found 🎯' },
    { selector: '.tab-bar', side: 'right', bubble: 'tabs secured 📊' },
    { selector: '.pnl-card', side: 'left', bubble: 'checking profits 💰' },
    { selector: '.preset-cards', side: 'right', bubble: 'strategy scout 🔍' },
    { selector: '.chart-card', side: 'left', bubble: 'analyzing chart 📈' },
    { selector: '.mode-cards', side: 'right', bubble: 'mode patrol 🎮' },
    { selector: '.trades-table', side: 'left', bubble: 'trade watcher 👁️' },
    { selector: '.risk-card', side: 'right', bubble: 'risk check ⚠️' },
    { selector: '.xp-bar-wrap', side: 'left', bubble: 'level hunting 🏆' },
    { selector: '.avatar', side: 'left', bubble: 'hello friend 👋' },
    { selector: '.overseer-card', side: 'right', bubble: 'overseer assist 🤖' }
  ];

  let friendEl;
  let bubbleEl;
  let currentTarget = 0;
  let activeTimeout;
  let isRunning = false;

  function ensureFriend() {
    friendEl = document.getElementById('pixelPal');
    if (!friendEl) return false;
    bubbleEl = friendEl.querySelector('.pixel-pal-bubble');
    return true;
  }

  function isAppVisible() {
    const appScreen = document.getElementById('appScreen');
    return appScreen && !appScreen.classList.contains('hidden');
  }

  function getHideoutRect(hideout) {
    const el = document.querySelector(hideout.selector);
    return el ? el.getBoundingClientRect() : null;
  }

  function addRunningAnimation() {
    if (!friendEl || isRunning) return;
    isRunning = true;
    friendEl.classList.add('pal-running');
    setTimeout(() => {
      if (friendEl) friendEl.classList.remove('pal-running');
      isRunning = false;
    }, 1800);
  }

  function moveFriend() {
    if (!ensureFriend() || !isAppVisible()) {
      activeTimeout = window.setTimeout(moveFriend, 1200);
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Randomly pick from available hideouts with some preference for variety
    let hideout;
    let attempts = 0;
    do {
      const randIdx = Math.floor(Math.random() * hideouts.length);
      hideout = hideouts[randIdx];
      currentTarget = randIdx;
      attempts++;
    } while (!getHideoutRect(hideout) && attempts < 5);
    
    const rect = getHideoutRect(hideout);

    if (!rect) {
      activeTimeout = window.setTimeout(moveFriend, 1800);
      return;
    }

    // Add running animation for longer distances
    addRunningAnimation();

    const sideOffset = hideout.side === 'left' ? -18 : rect.width - 30;
    const x = Math.max(16, Math.min(viewportWidth - 80, rect.left + sideOffset));
    const y = Math.max(88, Math.min(viewportHeight - 88, rect.top + Math.min(rect.height - 52, Math.max(12, rect.height * 0.45))));

    friendEl.classList.remove('hidden', 'is-hidden', 'flip');
    if (hideout.side === 'left') friendEl.classList.add('flip');

    if (bubbleEl) {
      bubbleEl.textContent = hideout.bubble;
      bubbleEl.classList.remove('show');
      window.setTimeout(() => bubbleEl && bubbleEl.classList.add('show'), 900);
      window.setTimeout(() => bubbleEl && bubbleEl.classList.remove('show'), 3200);
    }

    friendEl.style.setProperty('--pal-x', `${x}px`);
    friendEl.style.setProperty('--pal-y', `${y}px`);

    // Vary hiding duration for more personality
    const hideDelay = 3500 + Math.random() * 2000;
    const moveDelay = hideDelay + 2000 + Math.random() * 2500;
    
    window.setTimeout(() => friendEl.classList.add('is-hidden'), hideDelay);
    activeTimeout = window.setTimeout(moveFriend, moveDelay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeTimeout) {
      clearTimeout(activeTimeout);
    } else if (!document.hidden) {
      clearTimeout(activeTimeout);
      activeTimeout = window.setTimeout(moveFriend, 900);
    }
  });

  window.addEventListener('resize', () => {
    clearTimeout(activeTimeout);
    activeTimeout = window.setTimeout(moveFriend, 900);
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (!ensureFriend()) return;
    activeTimeout = window.setTimeout(moveFriend, 1800);
  });
})();
