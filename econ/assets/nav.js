/* ============================================================
   World Economics Course — Navigation & Interactivity v2
   ============================================================ */

(function () {
  'use strict';

  /* ── Elements (match actual HTML IDs) ── */
  const sidebar       = document.getElementById('sidebar');
  const mainWrapper   = document.querySelector('.main-wrapper');
  const sidebarToggle = document.getElementById('sidebarToggle');

  /* Create overlay dynamically so HTML doesn't need it */
  let overlay = document.querySelector('.overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    document.body.appendChild(overlay);
  }

  if (!sidebar || !mainWrapper) return;

  const STORE = 'econ-sidebar';

  function isMobile() { return window.innerWidth < 768; }

  function getStored() {
    try { return localStorage.getItem(STORE) !== 'false'; }
    catch (e) { return true; }
  }

  function setStored(val) {
    try { localStorage.setItem(STORE, String(val)); }
    catch (e) {}
  }

  let mobile = isMobile();
  let open   = mobile ? false : getStored();

  /* ── Apply sidebar state ── */
  function apply() {
    if (mobile) {
      sidebar.classList.toggle('mobile-open', open);
      sidebar.classList.remove('collapsed');
      mainWrapper.classList.remove('expanded');
      overlay.style.display = 'block';
      requestAnimationFrame(() => overlay.classList.toggle('visible', open));
    } else {
      sidebar.classList.remove('mobile-open');
      sidebar.classList.toggle('collapsed', !open);
      mainWrapper.classList.toggle('expanded', !open);
      overlay.style.display = 'none';
      overlay.classList.remove('visible');
    }
  }

  function toggle() {
    open = !open;
    if (!mobile) setStored(open);
    apply();
  }

  /* ── Listeners ── */
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggle);

  overlay.addEventListener('click', () => {
    if (mobile && open) { open = false; apply(); }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowMobile = isMobile();
      if (nowMobile !== mobile) {
        mobile = nowMobile;
        open   = mobile ? false : getStored();
        apply();
      }
    }, 100);
  });

  /* ── Mark active nav link ── */
  function markActive() {
    const file = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-link').forEach(link => {
      const lf = (link.getAttribute('href') || '').split('/').pop();
      if (lf === file) {
        link.classList.add('active');
        link.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      } else {
        link.classList.remove('active');
      }
    });
  }

  /* ── Exercise answer toggles (.toggle-answer, inline onclick) ── */
  function initExercises() {
    /* Support both class-based and any dynamically bound buttons */
    document.querySelectorAll('.toggle-answer').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        const exercise = this.closest('.exercise');
        if (!exercise) return;
        const ans = exercise.querySelector('.answer-content, .exercise-answer');
        if (!ans) return;
        const isOpen = ans.classList.toggle('visible');
        this.classList.toggle('open', isOpen);
        this.textContent = isOpen ? '▴ 收起答案' : '▾ 查看標準答案與評分標準';
      });
    });
  }

  /* Global toggle function for inline onclick="toggleAnswer(this)" */
  window.toggleAnswer = function (btn) {
    const exercise = btn.closest('.exercise');
    if (!exercise) return;
    const ans = exercise.querySelector('.answer-content, .exercise-answer');
    if (!ans) return;
    const isOpen = ans.classList.toggle('visible');
    btn.classList.toggle('open', isOpen);
    btn.textContent = isOpen ? '▴ 收起答案' : '▾ 查看標準答案與評分標準';
  };

  /* ── Reading progress bar ── */
  function initProgress() {
    let bar = document.getElementById('reading-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'reading-progress';
      document.body.prepend(bar);
    }
    function update() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = docHeight > 0 ? (scrollTop / docHeight * 100) + '%' : '0%';
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  /* ── Scroll-reveal ── */
  function initReveal() {
    const targets = document.querySelectorAll(
      '.blackboard, .transmission, .case-study, .misconception, .key-concept, .exercise-section'
    );
    if (!('IntersectionObserver' in window)) {
      targets.forEach(el => el.classList.add('visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal', 'visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
    targets.forEach(el => {
      el.classList.add('reveal');
      io.observe(el);
    });
  }

  /* ── Smooth TOC scroll ── */
  function initToc() {
    document.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', e => {
        const id = link.getAttribute('href');
        const target = document.querySelector(id);
        if (target) {
          e.preventDefault();
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
    initProgress();
    initReveal();
    initToc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
