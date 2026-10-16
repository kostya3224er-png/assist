/* Кастомные контролы вместо браузерных: select, range, file, title-подсказки.
   Нативные элементы остаются в DOM и синхронизируются, поэтому renderer.js работает без изменений. */
(() => {
  'use strict';

  const SEL_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const SEL_INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  const INP_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  // Для темы показываем кружок: фон темы + акцентный цвет
  const THEME_SWATCH = {
    purple: ['#0d0b14', '#8879d6'],
    red:    ['#110c10', '#c66a7a'],
    blue:   ['#0b1017', '#6c9cca'],
    gray:   ['#0e1012', '#9aa3aa'],
    white:  ['#c9c8ce', '#777581'],
    black:  ['#050607', '#c85961']
  };
  const swatchFor = (sel, value) => (sel.id === 'theme' ? THEME_SWATCH[value] : null);
  const gradient = c => `linear-gradient(135deg, ${c[0]} 0 50%, ${c[1]} 50% 100%)`;

  const CHEVRON = '<svg class="cs-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHECK = '<svg class="cs-check" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 6.4 5 8.9l4.5-5.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------------- Общее меню для всех select ---------------- */
  const menu = document.createElement('div');
  menu.className = 'cs-menu';
  menu.setAttribute('role', 'listbox');
  const list = document.createElement('div');
  list.className = 'cs-list';
  menu.appendChild(list);
  document.body.appendChild(menu);

  let active = null;      // { sel, trigger, wrap, sync, hl }
  let typeBuf = '', typeTimer = 0;

  const items = () => list.querySelectorAll('.cs-item');

  function updateFade() {
    const top = list.scrollTop > 2;
    const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
    list.style.setProperty('--ft', top ? '22px' : '0px');
    list.style.setProperty('--fb', bottom ? '22px' : '0px');
  }

  function build(sel) {
    list.textContent = '';
    const opts = Array.from(sel.options);
    if (!opts.length) {
      const e = document.createElement('div');
      e.className = 'cs-empty';
      e.textContent = 'Нет вариантов';
      list.appendChild(e);
      return;
    }
    opts.forEach((o, i) => {
      const it = document.createElement('div');
      it.className = 'cs-item' + (o.selected ? ' sel' : '') + (o.disabled ? ' dis' : '');
      it.setAttribute('role', 'option');
      it.setAttribute('aria-selected', o.selected ? 'true' : 'false');
      it.dataset.i = i;
      it.style.setProperty('--i', Math.min(i, 9));
      const c = swatchFor(sel, o.value);
      if (c) {
        const sw = document.createElement('span');
        sw.className = 'cs-sw';
        sw.style.background = gradient(c);
        it.appendChild(sw);
      }
      const t = document.createElement('span');
      t.className = 'cs-txt';
      t.textContent = o.text;
      it.appendChild(t);
      it.insertAdjacentHTML('beforeend', CHECK);
      list.appendChild(it);
    });
  }

  function place(trigger) {
    const r = trigger.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, gap = 6, pad = 10;
    menu.style.maxHeight = 'none';
    menu.style.width = Math.max(r.width, 180) + 'px';
    const natural = menu.offsetHeight;
    const below = vh - r.bottom - gap - pad;
    const above = r.top - gap - pad;
    const up = natural > below && above > below;
    const h = Math.max(Math.min(natural, up ? above : below, 300), 96);
    menu.style.maxHeight = h + 'px';
    menu.style.left = Math.min(Math.max(pad, r.left), Math.max(pad, vw - menu.offsetWidth - pad)) + 'px';
    if (up) { menu.style.top = 'auto'; menu.style.bottom = (vh - r.top + gap) + 'px'; }
    else { menu.style.bottom = 'auto'; menu.style.top = (r.bottom + gap) + 'px'; }
    menu.classList.toggle('up', up);
  }

  function setHl(i, smooth) {
    if (!active) return;
    const els = items();
    const el = els[i];
    if (!el) return;
    els.forEach(x => x.classList.remove('hl'));
    el.classList.add('hl');
    active.hl = i;
    const top = el.offsetTop, bot = top + el.offsetHeight;
    let to = null;
    if (top < list.scrollTop + 4) to = top - 4;
    else if (bot > list.scrollTop + list.clientHeight - 4) to = bot - list.clientHeight + 4;
    if (to !== null) list.scrollTo({ top: Math.max(0, to), behavior: smooth ? 'smooth' : 'auto' });
  }

  function open(rec) {
    if (rec.sel.disabled) return;
    if (active) close();
    active = rec;
    build(rec.sel);
    place(rec.trigger);
    list.scrollTop = 0;
    menu.classList.add('open');
    rec.wrap.classList.add('open');
    rec.trigger.setAttribute('aria-expanded', 'true');
    const cur = Math.max(0, SEL_INDEX.get.call(rec.sel));
    setHl(cur, false);
    updateFade();
  }

  function close() {
    if (!active) return;
    const rec = active;
    active = null;
    menu.classList.remove('open');
    rec.wrap.classList.remove('open');
    rec.trigger.setAttribute('aria-expanded', 'false');
  }

  function choose(i) {
    const rec = active;
    if (!rec) return;
    const o = rec.sel.options[i];
    if (!o || o.disabled) return;
    const changed = SEL_INDEX.get.call(rec.sel) !== i;
    SEL_INDEX.set.call(rec.sel, i);
    close();
    rec.sync();
    rec.trigger.focus({ preventScroll: true });
    if (changed) {
      rec.sel.dispatchEvent(new Event('input', { bubbles: true }));
      rec.sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function move(dir) {
    const els = items();
    let i = active.hl;
    for (let n = 0; n < els.length; n++) {
      i += dir;
      if (i < 0 || i >= els.length) return;
      if (!els[i].classList.contains('dis')) { setHl(i, true); return; }
    }
  }

  function typeahead(ch) {
    clearTimeout(typeTimer);
    typeBuf += ch.toLowerCase();
    typeTimer = setTimeout(() => { typeBuf = ''; }, 600);
    const els = Array.from(items());
    const idx = els.findIndex(e => !e.classList.contains('dis') && e.textContent.trim().toLowerCase().startsWith(typeBuf));
    if (idx >= 0) setHl(idx, true);
  }

  menu.addEventListener('mousedown', e => e.preventDefault());       // фокус остаётся на кнопке
  menu.addEventListener('mousemove', e => {
    const it = e.target.closest('.cs-item');
    if (it && !it.classList.contains('dis') && active && active.hl !== +it.dataset.i) setHl(+it.dataset.i, false);
  });
  menu.addEventListener('click', e => {
    const it = e.target.closest('.cs-item');
    if (it && !it.classList.contains('dis')) choose(+it.dataset.i);
  });
  list.addEventListener('scroll', updateFade, { passive: true });

  document.addEventListener('pointerdown', e => {
    if (active && !menu.contains(e.target) && !active.trigger.contains(e.target)) close();
  }, true);
  window.addEventListener('scroll', e => { if (active && !menu.contains(e.target)) close(); }, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);

  /* ---------------- Обёртка над каждым select ---------------- */
  function enhanceSelect(sel) {
    if (sel._cs) return;
    sel._cs = true;

    const wrap = document.createElement('div');
    wrap.className = 'cs';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<span class="cs-sw" hidden></span><span class="cs-label"></span>' + CHEVRON;
    const labelEl = sel.closest('.field') && sel.closest('.field').querySelector('label');
    if (labelEl) trigger.setAttribute('aria-label', labelEl.textContent.trim());

    sel.parentNode.insertBefore(wrap, sel);
    wrap.append(trigger, sel);
    sel.classList.add('cs-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');

    const label = trigger.querySelector('.cs-label');
    const sw = trigger.querySelector('.cs-sw');
    const rec = { sel, trigger, wrap, hl: 0, sync };

    function sync() {
      const o = sel.options[SEL_INDEX.get.call(sel)];
      label.textContent = o ? o.text : '';
      const c = o ? swatchFor(sel, o.value) : null;
      if (c) { sw.hidden = false; sw.style.background = gradient(c); } else { sw.hidden = true; }
      trigger.disabled = sel.disabled;
      wrap.classList.toggle('dis', sel.disabled);
      if (active && active.sel === sel) close();
    }

    // renderer.js меняет value/selectedIndex программно (без событий) — ловим это
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return SEL_VALUE.get.call(this); },
      set(v) { SEL_VALUE.set.call(this, v); sync(); }
    });
    Object.defineProperty(sel, 'selectedIndex', {
      configurable: true,
      get() { return SEL_INDEX.get.call(this); },
      set(v) { SEL_INDEX.set.call(this, v); sync(); }
    });
    new MutationObserver(sync).observe(sel, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled']
    });
    sel.addEventListener('change', sync);
    sel.addEventListener('focus', () => trigger.focus());

    trigger.addEventListener('click', () => { (active && active.sel === sel) ? close() : open(rec); });
    trigger.addEventListener('keydown', e => {
      const isOpen = active && active.trigger === trigger;
      const k = e.key;
      if (!isOpen) {
        if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); open(rec); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (k === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (k === 'Home') { e.preventDefault(); const i = Array.from(items()).findIndex(x => !x.classList.contains('dis')); if (i >= 0) setHl(i, true); }
      else if (k === 'End') {
        e.preventDefault();
        const els = Array.from(items());
        for (let i = els.length - 1; i >= 0; i--) if (!els[i].classList.contains('dis')) { setHl(i, true); break; }
      }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active.hl); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (k === 'Tab') { close(); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { typeahead(k); }
    });

    sync();
  }

  /* ---------------- Ползунки ---------------- */
  function enhanceRange(r) {
    if (r._cs) return;
    r._cs = true;
    const upd = () => {
      const min = parseFloat(r.min) || 0, max = parseFloat(r.max) || 100;
      const ratio = max > min ? (parseFloat(INP_VALUE.get.call(r)) - min) / (max - min) : 0;
      r.style.setProperty('--p', 'calc(8px + (100% - 16px) * ' + Math.min(Math.max(ratio, 0), 1) + ')');
    };
    Object.defineProperty(r, 'value', {
      configurable: true,
      get() { return INP_VALUE.get.call(this); },
      set(v) { INP_VALUE.set.call(this, v); upd(); }
    });
    r.addEventListener('input', upd);
    upd();
  }

  /* ---------------- Выбор файла ---------------- */
  function enhanceFile(inp) {
    if (inp._cs) return;
    inp._cs = true;
    const wrap = document.createElement('div');
    wrap.className = 'cs-file';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cs-file-btn';
    btn.textContent = 'Выбрать файл';
    const name = document.createElement('span');
    name.className = 'cs-file-name';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.append(btn, name, inp);
    inp.classList.add('cs-native');
    inp.tabIndex = -1;
    const upd = () => {
      const f = inp.files && inp.files[0];
      name.textContent = f ? f.name : 'Файл не выбран';
      wrap.classList.toggle('has', !!f);
    };
    Object.defineProperty(inp, 'value', {
      configurable: true,
      get() { return INP_VALUE.get.call(this); },
      set(v) { INP_VALUE.set.call(this, v); upd(); }
    });
    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', upd);
    upd();
  }

  function scan(root) {
    root.querySelectorAll('select:not(.cs-native)').forEach(enhanceSelect);
    root.querySelectorAll('input[type=range]').forEach(enhanceRange);
    root.querySelectorAll('input[type=file]').forEach(enhanceFile);
  }

  /* ---------------- Подсказки вместо нативных title ---------------- */
  const tip = document.createElement('div');
  tip.className = 'cs-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipEl = null, tipTimer = 0;

  function hideTip() {
    clearTimeout(tipTimer);
    tipEl = null;
    tip.classList.remove('show');
  }

  function showTip(el) {
    let text;
    if (el.classList.contains('cs-trigger')) {
      const l = el.querySelector('.cs-label');
      text = (l && l.scrollWidth > l.clientWidth + 1 && !(active && active.trigger === el)) ? l.textContent : '';
    } else {
      text = el.dataset.tip;
    }
    if (!text) return;
    tip.textContent = text;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), Math.max(8, vw - tw - 8));
    let top = r.bottom + 8;
    if (top + th > vh - 8) top = r.top - th - 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add('show');
  }

  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[title],[data-tip],.cs-trigger');
    if (!el || el === tipEl) return;
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      if (t) {
        el.dataset.tip = t;
        if (!el.hasAttribute('aria-label') && el.textContent.trim().length <= 2) el.setAttribute('aria-label', t);
      }
      el.removeAttribute('title');            // чтобы не показывался браузерный tooltip
    }
    hideTip();
    tipEl = el;
    tipTimer = setTimeout(() => showTip(el), 380);
  });
  document.addEventListener('mouseout', e => {
    if (tipEl && !tipEl.contains(e.relatedTarget)) hideTip();
  });
  ['pointerdown', 'keydown', 'wheel'].forEach(t => document.addEventListener(t, hideTip, true));
  window.addEventListener('blur', hideTip);

  /* ---------------- Старт + слежение за новыми элементами ---------------- */
  scan(document);
  new MutationObserver(muts => {
    for (const m of muts) {
      if (menu.contains(m.target) || tip.contains(m.target)) continue;
      if (m.addedNodes.length) { scan(document); break; }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
