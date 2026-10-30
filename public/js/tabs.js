// Top-level tabs. The last tab used is remembered between launches.
const Tabs = (() => {
  const buttons = [...document.querySelectorAll('[data-tab]')];
  const panels = [...document.querySelectorAll('[data-panel]')];
  const listeners = [];
  let current = null;

  function show(name) {
    if (!panels.some((p) => p.dataset.panel === name)) name = 'convert';
    current = name;
    buttons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    try {
      localStorage.setItem('audiosmith-tab', name);
    } catch {
      // storage unavailable; the tab just won't be remembered
    }
    listeners.forEach((fn) => fn(name));
  }

  buttons.forEach((b, i) => {
    b.addEventListener('click', () => show(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      show(next.dataset.tab);
    });
  });

  let saved = null;
  try {
    saved = localStorage.getItem('audiosmith-tab');
  } catch {
    // fall through to the default tab
  }
  show(saved || 'convert');

  return {
    get current() {
      return current;
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
})();

// True when a key press is meant for a text field rather than a page shortcut.
function isTypingTarget(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'range';
}
