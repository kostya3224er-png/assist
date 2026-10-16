/* ui-kit.js — заменяет нативные элементы браузера на свои, в цвет темы.
   Оригинальные <select>, <input type=range|file> остаются в DOM и работают как раньше:
   renderer.js читает value / files и слушает change так же, как и без этого файла. */
(() => {
  'use strict';

  const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const selValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const selIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

  /* ---------------------------------------------------------------- select */
  const pop = document.createElement('div');
  pop.className = 'cs-pop';
  pop.setAttribute('role', 'listbox');
  pop.hidden = true;
  document.body.appendChild(pop);

  let openInst = null;
  let typeBuf = '';
  let typeAt = 0;

  const CHEV = '<svg class="cs-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  function enhanceSelect(sel) {
    if (sel._cs) return;
    const wrap = document.createElement('div');
    wrap.className = 'cs';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cs-trigger';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const txt = document.createElement('span');
    btn.append(txt);
    btn.insertAdjacentHTML('beforeend', CHEV);
    wrap.append(btn);
    sel.after(wrap);
    sel.classList.add('cs-native');
    sel.tabIndex = -1;

    const lab = sel.id && document.querySelector('label[for="' + sel.id + '"]');
    if (lab) btn.setAttribute('aria-label', lab.textContent.trim());

    const inst = { sel, wrap, btn, hl: -1 };
    sel._cs = inst;

    inst.refresh = () => {
      const o = sel.options[selIndex.get.call(sel)];
      txt.textContent = o ? o.textContent : '';
      btn.disabled = sel.disabled;
      if (openInst === inst) renderList(inst);
    };

    // программные sel.value = ... / sel.selectedIndex = ... тоже обновляют вид
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return selValue.get.call(sel); },
      set(v) { selValue.set.call(sel, v); inst.refresh(); }
    });
    Object.defineProperty(sel, 'selectedIndex', {
      configurable: true,
      get() { return selIndex.get.call(sel); },
      set(v) { selIndex.set.call(sel, v); inst.refresh(); }
    });

    new MutationObserver(inst.refresh).observe(sel, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['disabled', 'selected', 'label']
    });
    sel.addEventListener('change', inst.refresh);

    btn.addEventListener('click', () => (openInst === inst ? closePop() : openPop(inst)));
    btn.addEventListener('keydown', (e) => onKey(e, inst));
    inst.refresh();
  }

  function renderList(inst) {
    const keep = pop.scrollTop;
    pop.textContent = '';
    const opts = Array.from(inst.sel.options);
    if (!opts.length) {
      const d = document.createElement('div');
      d.className = 'cs-empty';
      d.textContent = 'Нет вариантов';
      pop.append(d);
      return;
    }
    const cur = selIndex.get.call(inst.sel);
    opts.forEach((o, i) => {
      const d = document.createElement('div');
      d.className = 'cs-opt' + (i === cur ? ' sel' : '') + (i === inst.hl ? ' hl' : '') + (o.disabled ? ' dis' : '');
      d.setAttribute('role', 'option');
      d.setAttribute('aria-selected', i === cur ? 'true' : 'false');
      d.dataset.i = i;
      const s = document.createElement('span');
      s.textContent = o.textContent;
      d.append(s);
      pop.append(d);
    });
    pop.scrollTop = keep;
  }

  function placePop(inst) {
    const r = inst.btn.getBoundingClientRect();
    pop.style.minWidth = r.width + 'px';
    pop.style.maxHeight = '260px';
    const below = window.innerHeight - r.bottom - 10;
    const above = r.top - 10;
    const need = Math.min(pop.scrollHeight + 2, 260);
    const up = need > below && above > below;
    const mh = Math.max(120, Math.min(260, up ? above : below));
    pop.style.maxHeight = mh + 'px';
    const ph = Math.min(pop.scrollHeight + 2, mh);
    const pw = pop.offsetWidth;
    pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pw - 6)) + 'px';
    pop.style.top = (up ? r.top - ph - 4 : r.bottom + 4) + 'px';
  }

  function openPop(inst) {
    closePop();
    if (inst.btn.disabled) return;
    inst.refresh();
    openInst = inst;
    inst.hl = selIndex.get.call(inst.sel);
    pop.scrollTop = 0;
    renderList(inst);
    pop.hidden = false;
    inst.wrap.classList.add('open');
    inst.btn.setAttribute('aria-expanded', 'true');
    placePop(inst);
    const s = pop.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  function closePop() {
    if (!openInst) return;
    openInst.wrap.classList.remove('open');
    openInst.btn.setAttribute('aria-expanded', 'false');
    openInst = null;
    pop.hidden = true;
  }

  function setHl(inst, i, scroll) {
    if (i === inst.hl) return;
    inst.hl = i;
    pop.querySelectorAll('.cs-opt').forEach((el) => el.classList.toggle('hl', +el.dataset.i === i));
    if (scroll) {
      const el = pop.querySelector('.cs-opt[data-i="' + i + '"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(inst, i) {
    const sel = inst.sel;
    const o = sel.options[i];
    if (!o || o.disabled) return;
    closePop();
    if (i !== selIndex.get.call(sel)) {
      selIndex.set.call(sel, i);
      inst.refresh();
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    inst.btn.focus();
  }

  function onKey(e, inst) {
    const n = inst.sel.options.length;
    if (openInst !== inst) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openPop(inst);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setHl(inst, Math.min(n - 1, inst.hl + 1), true); break;
      case 'ArrowUp':   e.preventDefault(); setHl(inst, Math.max(0, inst.hl - 1), true); break;
      case 'Home':      e.preventDefault(); setHl(inst, 0, true); break;
      case 'End':       e.preventDefault(); setHl(inst, n - 1, true); break;
      case 'Enter':
      case ' ':         e.preventDefault(); if (inst.hl >= 0) choose(inst, inst.hl); break;
      case 'Escape':    e.preventDefault(); e.stopPropagation(); closePop(); break;
      case 'Tab':       closePop(); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typeBuf = now - typeAt > 700 ? e.key : typeBuf + e.key;
          typeAt = now;
          const q = typeBuf.toLowerCase();
          const idx = Array.from(inst.sel.options).findIndex((o) => o.textContent.trim().toLowerCase().startsWith(q));
          if (idx >= 0) setHl(inst, idx, true);
        }
    }
  }

  // клики по списку; mousedown не отбирает фокус у кнопки
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', (e) => {
    const d = e.target.closest('.cs-opt');
    if (d && openInst) choose(openInst, +d.dataset.i);
  });
  pop.addEventListener('mousemove', (e) => {
    const d = e.target.closest('.cs-opt');
    if (d && openInst && !d.classList.contains('dis')) setHl(openInst, +d.dataset.i, false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (openInst && !pop.contains(e.target) && !openInst.wrap.contains(e.target)) closePop();
  }, true);
  document.addEventListener('scroll', (e) => {
    if (openInst && !pop.contains(e.target)) closePop();
  }, true);
  window.addEventListener('resize', closePop);
  window.addEventListener('blur', closePop);

  /* ----------------------------------------------------------------- range */
  function syncRange(r) {
    const min = parseFloat(r.min) || 0;
    const max = r.max === '' ? 100 : parseFloat(r.max);
    const v = parseFloat(inputValue.get.call(r));
    const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
    r.style.setProperty('--p', Math.max(0, Math.min(100, p)) + '%');
  }

  function enhanceRange(r) {
    if (r._rg) return;
    r._rg = true;
    Object.defineProperty(r, 'value', {
      configurable: true,
      get() { return inputValue.get.call(r); },
      set(v) { inputValue.set.call(r, v); syncRange(r); }
    });
    r.addEventListener('input', () => syncRange(r));
    syncRange(r);
  }

  /* ------------------------------------------------------------------ file */
  function enhanceFile(inp) {
    if (inp._cf) return;
    inp._cf = true;
    const wrap = document.createElement('div');
    wrap.className = 'cf';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cf-btn';
    btn.textContent = 'Выбрать файл';
    const name = document.createElement('span');
    name.className = 'cf-name';
    inp.before(wrap);
    wrap.append(btn, name, inp);

    const sync = () => {
      const f = inp.files && inp.files[0];
      name.textContent = f ? f.name : 'Файл не выбран';
      wrap.classList.toggle('has', !!f);
    };
    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', sync);
    Object.defineProperty(inp, 'value', {
      configurable: true,
      get() { return inputValue.get.call(inp); },
      set(v) { inputValue.set.call(inp, v); sync(); }
    });
    sync();
  }

  /* --------------------------------------------------------------- tooltips */
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipEl = null;
  let tipTimer = 0;

  function hideTip() {
    clearTimeout(tipTimer);
    tipEl = null;
    tip.classList.remove('on');
  }

  function showTip(el, text) {
    tip.textContent = text;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6));
    let y = r.bottom + 8;
    if (y + h > window.innerHeight - 6) y = r.top - h - 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    tip.classList.add('on');
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[title],[data-tip]');
    if (el === tipEl) return;
    hideTip();
    if (!el) return;
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.removeAttribute('title'); // убираем системную подсказку
      if (t) {
        el.dataset.tip = t;
        if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
      }
    }
    const text = el.dataset.tip;
    if (!text) return;
    tipEl = el;
    tipTimer = setTimeout(() => showTip(el, text), 350);
  });
  document.addEventListener('mouseout', (e) => {
    if (tipEl && !tipEl.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('pointerdown', hideTip, true);

  /* ------------------------------------------------------------------ init */
  function enhanceAll(root) {
    if (!root.querySelectorAll) return;
    if (root.matches) {
      if (root.matches('select')) enhanceSelect(root);
      else if (root.matches('input[type=range]')) enhanceRange(root);
      else if (root.matches('input[type=file]')) enhanceFile(root);
    }
    root.querySelectorAll('select').forEach(enhanceSelect);
    root.querySelectorAll('input[type=range]').forEach(enhanceRange);
    root.querySelectorAll('input[type=file]').forEach(enhanceFile);
  }

  enhanceAll(document);
  new MutationObserver((list) => {
    for (const m of list) m.addedNodes.forEach((n) => { if (n.nodeType === 1) enhanceAll(n); });
  }).observe(document.body, { childList: true, subtree: true });
})();
