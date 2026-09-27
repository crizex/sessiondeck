// sessiondeck: shared UI behaviour (command palette, keys, film grain, pointer light, toast).
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let tt;
  function toast(msg, error) {
    $('.toast')?.remove(); clearTimeout(tt);
    document.body.insertAdjacentHTML('beforeend', `<div class="toast${error ? ' error' : ''}" role="status"><i></i>${esc(msg)}</div>`);
    tt = setTimeout(() => $('.toast')?.remove(), error ? 5000 : 2600);
  }

  // Layer for palette and dialogs. On close, focus returns to where it was before,
  // otherwise the keyboard lands somewhere in the document after Escape.
  let layer, before = null;
  function open(html) {
    if (layer.hidden) before = document.activeElement;
    layer.innerHTML = html;
    layer.hidden = false;
  }
  function close() {
    layer.hidden = true; layer.innerHTML = '';
    before?.focus?.(); before = null;
  }

  let commands = () => [];
  function palette() {
    open(`<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <input id="pal-q" placeholder="Session or command" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pal-l" aria-autocomplete="list"><ul id="pal-l" role="listbox"></ul></div>`);
    const q = $('#pal-q'), ul = $('#pal-l');
    let hits = [], sel = 0;
    const draw = () => {
      const s = q.value.toLowerCase().trim();
      hits = commands().filter(b => (b.t + ' ' + (b.k || '') + ' ' + b.g).toLowerCase().includes(s));
      sel = Math.min(sel, Math.max(0, hits.length - 1));
      let last = '';
      ul.innerHTML = hits.map((b, i) => {
        const head = b.g !== last ? `<li class="group" role="presentation">${esc(b.g)}</li>` : '';
        last = b.g;
        return head + `<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === sel}"><span class="dot" style="background:${b.c || 'var(--ink-3)'}"></span>${esc(b.t)}<small>${esc(b.k || '')}</small></li>`;
      }).join('') || '<li class="group">Nothing found</li>';
      q.setAttribute('aria-activedescendant', hits.length ? 'pal-' + sel : '');
      $('#pal-' + sel)?.scrollIntoView({block: 'nearest'});
    };
    const run = i => { const b = hits[i]; if (!b) return; close(); b.f(); };
    q.addEventListener('input', () => { sel = 0; draw(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
      if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    });
    ul.addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) run(+li.dataset.i); });
    draw(); q.focus();
  }

  function start({ commands: c, keys = {} }) {
    commands = c;
    layer = $('#layer');
    layer.addEventListener('click', e => { if (e.target === layer) close(); });
    $('#searchbtn')?.addEventListener('click', palette);

    document.addEventListener('keydown', e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); layer.hidden ? palette() : close(); return; }
      if (e.key === 'Escape' && !layer.hidden) { close(); return; }
      if (typing || !layer.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      const f = keys[e.key.toLowerCase()];
      if (f) { e.preventDefault(); f(); }
    });

    // Light edge following the pointer
    document.addEventListener('pointermove', e => {
      const k = e.target.closest?.('[data-light]');
      if (!k) return;
      const r = k.getBoundingClientRect();
      k.style.setProperty('--mx', e.clientX - r.left + 'px');
      k.style.setProperty('--my', e.clientY - r.top + 'px');
    });

    // Film grain as a tile generated once
    const cv = document.createElement('canvas'), x = cv.getContext('2d');
    cv.width = cv.height = 160;
    const img = x.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    x.putImageData(img, 0, 0);
    const grain = $('#grain');
    if (grain) grain.style.backgroundImage = `url(${cv.toDataURL()})`;

    const clock = () => { const u = $('#clock'); if (u) u.textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}); };
    clock(); setInterval(clock, 15000);
  }

  window.D = { $, $$, esc, calm, toast, open, close, palette, start };
})();
