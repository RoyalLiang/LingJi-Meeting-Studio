const switches = [...document.querySelectorAll('[data-view]')];
const panels = [...document.querySelectorAll('[data-panel]')];
const validViews = new Set(panels.map(panel => panel.dataset.panel));

document.querySelector('.demo-switch').hidden = false;
for (const button of switches) {
  button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (!validViews.has(view)) return;
    for (const item of switches) item.setAttribute('aria-pressed', String(item === button));
    for (const panel of panels) panel.hidden = panel.dataset.panel !== view;
  });
}

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  document.documentElement.classList.add('reveal-ready');
  for (const element of document.querySelectorAll('[data-reveal]')) observer.observe(element);
}
