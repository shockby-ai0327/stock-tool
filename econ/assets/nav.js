/* ============================================================
   World Economics Course — Navigation & Interactivity
   ============================================================ */

(function () {
  'use strict';

  /* ── Elements ── */
  const sidebar        = document.getElementById('sidebar');
  const main           = document.getElementById('main');
  const overlay        = document.getElementById('overlay');
  const sidebarToggle  = document.getElementById('sidebarToggleBtn');
  const topbarToggle   = document.getElementById('topbarToggleBtn');

  if (!sidebar || !main) return;

  const STORE = 'econ-sidebar';

  function isMobileNow() { return window.innerWidth < 768; }

  function getStored() {
    try { return localStorage.getItem(STORE) !== 'false'; }
    catch (e) { return true; }
  }

  function setStored(val) {
    try { localStorage.setItem(STORE, String(val)); }
    catch (e) {}
  }

  let mobile = isMobileNow();
  let open   = mobile ? false : getStored();

  /* ── Apply State ── */
  function apply() {
    if (mobile) {
      sidebar.classList.toggle('mobile-open', open);
      sidebar.classList.remove('collapsed');
      main.classList.remove('expanded');
      if (overlay) {
        overlay.style.display = 'block';
        requestAnimationFrame(() => overlay.classList.toggle('visible', open));
      }
    } else {
      sidebar.classList.remove('mobile-open');
      sidebar.classList.toggle('collapsed', !open);
      main.classList.toggle('expanded', !open);
      if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.remove('visible');
      }
    }

    /* Update topbar button label */
    const lbl = document.querySelector('#topbarToggleBtn .toggle-label');
    if (lbl) lbl.textContent = open ? '隱藏目錄' : '顯示目錄';
  }

  function toggle() {
    open = !open;
    if (!mobile) setStored(open);
    apply();
  }

  /* ── Listeners ── */
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggle);
  if (topbarToggle)  topbarToggle.addEventListener('click', toggle);
  if (overlay) {
    overlay.addEventListener('click', () => {
      if (mobile && open) { open = false; apply(); }
    });
  }

  /* Debounced resize */
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowMobile = isMobileNow();
      if (nowMobile !== mobile) {
        mobile = nowMobile;
        open   = mobile ? false : getStored();
        apply();
      }
    }, 100);
  });

  /* ── Mark Active Nav Item ── */
  function markActive() {
    const file = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-item[href]').forEach(link => {
      const lf = link.getAttribute('href').split('/').pop();
      link.classList.toggle('active', lf === file);
      if (lf === file) link.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  }

  /* ── Exercise Toggles ── */
  function initExercises() {
    document.querySelectorAll('.exercise-toggle').forEach(btn => {
      btn.addEventListener('click', function () {
        const ans  = this.closest('.exercise').querySelector('.exercise-answer');
        const isOpen = ans.classList.toggle('visible');
        this.classList.toggle('open', isOpen);
        const lbl = this.querySelector('.toggle-label');
        if (lbl) lbl.textContent = isOpen ? '收起答案' : '查看標準答案與評分標準';
      });
    });
  }

  /* ── Smooth TOC Scroll ── */
  function initToc() {
    document.querySelectorAll('.toc-item a[href^="#"]').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const target = document.querySelector(link.getAttribute('href'));
        if (target) {
          window.scrollTo({
            top: target.getBoundingClientRect().top + window.scrollY - 72,
            behavior: 'smooth'
          });
        }
      });
    });
  }

  /* ── Init ── */
  function init() {
    apply();
    markActive();
    initExercises();
    initToc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
