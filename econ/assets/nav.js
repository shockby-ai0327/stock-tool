/* ============================================================
   World Economics Course — Navigation & Interactivity v3
   Layout B: dynamic right panel, active TOC, animations
   ============================================================ */

(function () {
  'use strict';

  /* ── Elements ── */
  const sidebar     = document.getElementById('sidebar');
  const mainWrapper = document.querySelector('.main-wrapper');
  const toggleBtn   = document.getElementById('sidebarToggle');

  /* Overlay (created if missing) */
  let overlay = document.querySelector('.overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    document.body.appendChild(overlay);
  }

  if (!sidebar || !mainWrapper) return;

  /* ── Sidebar open/close ── */
  const STORE = 'econ-sidebar';
  function isMobile() { return window.innerWidth < 768; }
  function getStored() {
    try { return localStorage.getItem(STORE) !== 'false'; } catch { return true; }
  }
  function setStored(v) {
    try { localStorage.setItem(STORE, String(v)); } catch {}
  }

  let mobile = isMobile();
  let open   = mobile ? false : getStored();

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

  function toggle() { open = !open; if (!mobile) setStored(open); apply(); }

  if (toggleBtn) toggleBtn.addEventListener('click', toggle);
  overlay.addEventListener('click', () => { if (mobile && open) { open = false; apply(); } });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const now = isMobile();
      if (now !== mobile) { mobile = now; open = mobile ? false : getStored(); apply(); }
    }, 100);
  });

  /* ── Mark active nav link ── */
  function markActive() {
    const file = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-link').forEach(a => {
      const lf = (a.getAttribute('href') || '').split('/').pop();
      a.classList.toggle('active', lf === file);
      if (lf === file) a.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  }

  /* ── Exercise toggle ── */
  const CARD_SEL = '.exercise-card, .exercise';

  function toggleExercise(btn) {
    const card = btn.closest(CARD_SEL);
    if (!card) return;
    const ans = card.querySelector('.exercise-answer, .answer-content');
    if (!ans) return;
    const isOpen = ans.classList.toggle('visible');
    btn.classList.toggle('open', isOpen);
    btn.textContent = isOpen ? '▴ 收起答案' : '▾ 顯示標準答案與評分標準';
  }

  function initExercises() {
    document.querySelectorAll('.exercise-toggle, .toggle-answer').forEach(btn => {
      if (btn.dataset.bound) return;
      if (btn.getAttribute('onclick')) return; // inline onclick handles it
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () { toggleExercise(this); });
    });
  }

  window.toggleAnswer = toggleExercise;

  /* ── Reading progress bar ── */
  function initProgress() {
    let bar = document.getElementById('reading-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'reading-progress';
      document.body.prepend(bar);
    }
    function update() {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = h > 0 ? (window.scrollY / h * 100) + '%' : '0%';
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  /* ── Scroll-reveal with stagger ── */
  function initReveal() {
    const targets = document.querySelectorAll(
      '.blackboard, .transmission, .case-study, .key-concept, .exercise-section, .exercise-card'
    );
    if (!('IntersectionObserver' in window)) {
      targets.forEach(el => el.classList.add('reveal', 'visible'));
      return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal', 'visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06 });

    targets.forEach(el => { el.classList.add('reveal'); io.observe(el); });
  }

  /* ── Smooth anchor scroll ── */
  function initToc() {
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) {
          e.preventDefault();
          window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
        }
      });
    });
  }

  /* ── Dynamic right panel (Layout B) ── */
  function buildRightPanel() {
    const content = document.querySelector('.content');
    if (!content) return;

    /* Only on lecture pages (has .lecture-hero or .section) */
    const isLecture = !!document.querySelector('.lecture-hero, .section-title');
    if (!isLecture) return;

    /* Wrap existing children in article-main */
    const main = document.createElement('div');
    main.className = 'article-main';
    Array.from(content.childNodes).forEach(n => main.appendChild(n));

    /* Build aside */
    const aside = document.createElement('aside');
    aside.className = 'article-aside';

    /* — Mini TOC — */
    const headings = main.querySelectorAll('h2.section-title');
    if (headings.length > 0) {
      const tocPanel = document.createElement('div');
      tocPanel.className = 'aside-panel';

      const label = document.createElement('div');
      label.className = 'aside-label';
      label.textContent = '本講目錄';
      tocPanel.appendChild(label);

      headings.forEach((h, i) => {
        /* Ensure heading has an id */
        if (!h.id) h.id = 'sec-' + i;
        const a = document.createElement('a');
        a.className = 'aside-toc-item';
        a.href = '#' + h.id;
        a.textContent = h.textContent.trim();
        a.addEventListener('click', e => {
          e.preventDefault();
          window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
        });
        tocPanel.appendChild(a);
      });
      aside.appendChild(tocPanel);

      /* Active section tracking */
      if ('IntersectionObserver' in window) {
        const tocLinks = tocPanel.querySelectorAll('.aside-toc-item');
        const sectionIO = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              tocLinks.forEach(a => a.classList.remove('active'));
              const active = tocPanel.querySelector(`a[href="#${entry.target.id}"]`);
              if (active) {
                active.classList.add('active');
                active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }
          });
        }, { rootMargin: '-20% 0px -60% 0px' });
        headings.forEach(h => sectionIO.observe(h));
      }
    }

    /* — Key Formulas — */
    /* Try .blackboard-eq first; fall back to first equation line inside <pre> */
    let eqTexts = [...main.querySelectorAll('.blackboard-eq')]
      .map(el => el.textContent.trim().split('\n')[0].trim())
      .filter(t => t.length > 2);

    if (eqTexts.length === 0) {
      eqTexts = [...main.querySelectorAll('.blackboard pre')]
        .flatMap(pre => pre.textContent.split('\n'))
        .filter(l => /[=＝]/.test(l) && l.trim().length > 4)
        .map(l => l.trim())
        .slice(0, 5);
    }
    eqTexts = eqTexts.slice(0, 4);

    if (eqTexts.length > 0) {
      const fPanel = document.createElement('div');
      fPanel.className = 'aside-panel';
      const fl = document.createElement('div');
      fl.className = 'aside-label';
      fl.textContent = '關鍵公式';
      fPanel.appendChild(fl);
      eqTexts.forEach(t => {
        const chip = document.createElement('code');
        chip.className = 'aside-formula';
        chip.textContent = t.slice(0, 58);
        fPanel.appendChild(chip);
      });
      aside.appendChild(fPanel);
    }

    /* — Core Concepts — */
    /* Try .key-concept-title; fall back to first <strong> inside .key-concept */
    let conceptTexts = [...main.querySelectorAll('.key-concept-title')]
      .map(el => el.textContent.trim())
      .filter(t => t && !t.includes('核心概念') && t.length < 40);

    if (conceptTexts.length === 0) {
      conceptTexts = [...main.querySelectorAll('.key-concept strong')]
        .map(el => {
          /* "Term（English）" → just the Chinese term */
          return el.textContent.trim().replace(/（.*）/, '').replace(/\(.*\)/, '').trim();
        })
        .filter(t => t && t.length > 1 && t.length < 24)
        .slice(0, 8);
    }
    conceptTexts = [...new Set(conceptTexts)].slice(0, 9); // dedupe

    if (conceptTexts.length > 0) {
      const cPanel = document.createElement('div');
      cPanel.className = 'aside-panel';
      const cl = document.createElement('div');
      cl.className = 'aside-label';
      cl.textContent = '核心概念';
      cPanel.appendChild(cl);
      const wrap = document.createElement('div');
      conceptTexts.forEach(t => {
        const tag = document.createElement('span');
        tag.className = 'aside-concept';
        tag.textContent = t.slice(0, 22);
        wrap.appendChild(tag);
      });
      cPanel.appendChild(wrap);
      aside.appendChild(cPanel);
    }

    /* — Lecture meta — */
    const meta = document.querySelector('.lecture-hero-meta');
    if (meta) {
      const mPanel = document.createElement('div');
      mPanel.className = 'aside-panel';
      const ml = document.createElement('div');
      ml.className = 'aside-label';
      ml.textContent = '講義資訊';
      mPanel.appendChild(ml);

      const metaClone = meta.cloneNode(true);
      metaClone.style.cssText = 'font-size:.75rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:.375rem;';
      [...metaClone.children].forEach(s => { s.style.cssText = 'display:block;font-size:.75rem;'; });
      mPanel.appendChild(metaClone);
      aside.appendChild(mPanel);
    }

    content.appendChild(main);
    content.appendChild(aside);
    content.classList.add('has-aside');
  }

  /* ── Init ── */
  function init() {
    apply();
    markActive();
    buildRightPanel();   /* must run before initReveal so targets are in DOM */
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
