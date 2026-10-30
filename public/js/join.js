// Join tab: decode several files, put them in order, and stitch them into one track with
// optional gaps or crossfades. Everything is brought to one sample rate and channel count.
(() => {
  const T = AudioTools;
  const $ = (id) => document.getElementById(id);
  const list = $('join-list');
  const statusEl = $('join-status');
  const picker = FormatPicker.create($('join-format'), { id: 'join' });
  const results = Results.create($('join-results'));

  let items = []; // { id, name, audio | null, error | null }
  let nextId = 1;
  let joined = null; // { key, audio } — reused between Preview and Save
  let previewing = false;

  function status(message, kind = 'info') {
    if (!message) return statusEl.classList.add('hidden');
    setStatus(statusEl, message, kind);
    statusEl.classList.remove('mt-4');
  }

  // ---------- Adding files ----------

  let queue = Promise.resolve();
  function addFiles(files) {
    for (const file of files) {
      const item = { id: nextId++, name: file.name.replace(/\.[^.]+$/, ''), audio: null, error: null };
      items.push(item);
      // Decode one at a time so a big batch doesn't swamp the local server.
      queue = queue.then(async () => {
        try {
          item.audio = await T.decodeFile(file);
          if (item.audio.channels.length > 2) item.audio.channels = item.audio.channels.slice(0, 2);
        } catch (err) {
          item.error = err.message || 'Could not open this file.';
        }
        render();
      });
    }
    status(null);
    render();
  }

  const dropzone = $('join-dropzone');
  const input = $('join-input');
  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
  // Files can be dropped anywhere on the card. Rows being reordered are drags too, so
  // those are ignored here and handled by the rows themselves.
  wireDropTarget(dropzone.closest('.card'), {
    accepts: () => draggedId === null,
    onDrop: (dt) => addFiles([...(dt.files || [])]),
  });

  // ---------- List ----------

  function move(id, toIndex) {
    const from = items.findIndex((it) => it.id === id);
    if (from < 0) return;
    const [it] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, it);
    render();
    list.querySelector(`[data-id="${id}"]`)?.focus();
  }

  let draggedId = null;

  function render() {
    stopPreview();
    joined = null;
    list.innerHTML = '';
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'join-row rounded-lg pl-2 pr-1.5 py-1.5 flex items-center gap-2';
      li.draggable = true;
      li.tabIndex = 0;
      li.dataset.id = item.id;
      li.setAttribute('aria-label', `${item.name}, position ${index + 1}. Alt+arrow keys to move.`);
      const detail = item.error
        ? `<span class="text-[11px] text-red-300 truncate max-w-[45%]" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</span>`
        : item.audio
        ? `<span class="text-[11px] text-stone-500 tabular-nums">${T.formatTime(T.duration(item.audio))}</span>`
        : '<span class="spinner w-3.5 h-3.5 rounded-full"></span>';
      li.innerHTML = `
        <span class="join-handle px-1" aria-hidden="true">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="11.5" r="1.3"/><circle cx="7.5" cy="11.5" r="1.3"/></svg>
        </span>
        <span class="text-[11px] text-stone-500 tabular-nums w-4 text-right">${index + 1}</span>
        <span class="text-xs text-stone-200 truncate flex-1">${escapeHtml(item.name)}</span>
        ${detail}
        <button type="button" class="btn-secondary btn-icon rounded-md" style="width:26px;height:26px" aria-label="Remove ${escapeHtml(item.name)}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>`;

      li.querySelector('button').addEventListener('click', () => {
        items = items.filter((it) => it.id !== item.id);
        render();
      });
      li.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        move(item.id, index + (e.key === 'ArrowUp' ? -1 : 1));
      });

      li.addEventListener('dragstart', (e) => {
        draggedId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(item.id));
        requestAnimationFrame(() => li.classList.add('dragging'));
      });
      li.addEventListener('dragend', () => {
        draggedId = null;
        list.querySelectorAll('.join-row').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      li.addEventListener('dragover', (e) => {
        if (draggedId === null) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        li.classList.toggle('drop-before', before);
        li.classList.toggle('drop-after', !before);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', (e) => {
        if (draggedId === null) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const from = items.findIndex((it) => it.id === draggedId);
        let to = index + (before ? 0 : 1);
        if (from < to) to -= 1;
        move(draggedId, to);
      });

      list.appendChild(li);
    });
    summarize();
  }

  // ---------- Settings + summary ----------

  function mode() {
    return document.querySelector('[data-join-mode][aria-checked="true"]').dataset.joinMode;
  }
  function seconds() {
    return Math.max(0, Number($('join-seconds').value) || 0);
  }

  document.querySelectorAll('[data-join-mode]').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-join-mode]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      $('join-seconds-row').classList.toggle('hidden', btn.dataset.joinMode === 'none');
      joined = null;
      stopPreview();
      summarize();
    })
  );
  $('join-seconds').addEventListener('input', () => {
    joined = null;
    stopPreview();
    summarize();
  });

  // The joined file uses the highest sample rate among the inputs (so nothing loses
  // detail) and is stereo if any input is stereo.
  function outputFormat(ready) {
    return {
      rate: Math.max(...ready.map((it) => it.audio.sampleRate)),
      channels: ready.some((it) => it.audio.channels.length === 2) ? 2 : 1,
    };
  }

  function summarize() {
    const el = $('join-summary');
    const ready = items.filter((it) => it.audio);
    if (!items.length) {
      el.textContent = 'Files are joined top to bottom.';
      return;
    }
    if (!ready.length) {
      el.textContent = 'Opening files…';
      return;
    }
    const m = mode();
    let total = ready.reduce((sum, it) => sum + T.duration(it.audio), 0);
    if (m === 'gap') total += seconds() * (ready.length - 1);
    if (m === 'crossfade') {
      for (let i = 1; i < ready.length; i++) {
        total -= Math.min(seconds(), T.duration(ready[i - 1].audio) / 2, T.duration(ready[i].audio) / 2);
      }
    }
    const { rate, channels } = outputFormat(ready);
    el.textContent = `${ready.length} file${ready.length === 1 ? '' : 's'} · ${T.formatTime(total)} total · output ${(rate / 1000).toFixed(1)} kHz ${channels === 2 ? 'stereo' : 'mono'}`;
  }

  // ---------- Join, preview, save ----------

  async function build() {
    if (items.some((it) => !it.audio && !it.error)) throw new Error('Still opening files — one moment.');
    const ready = items.filter((it) => it.audio);
    if (ready.length < 2) throw new Error('Add at least two files to join.');
    const key = JSON.stringify([ready.map((it) => it.id), mode(), seconds()]);
    if (joined && joined.key === key) return joined.audio;

    const { rate, channels } = outputFormat(ready);
    const clips = [];
    for (const it of ready) clips.push(T.withChannels(await T.resample(it.audio, rate), channels));
    const audio = T.join(clips, { mode: mode(), seconds: seconds() });
    joined = { key, audio };
    return audio;
  }

  function stopPreview() {
    if (previewing) T.player.stop();
  }

  function setPreviewUi(on) {
    previewing = on;
    $('join-preview').textContent = on ? 'Stop' : 'Preview';
  }

  $('join-preview').addEventListener('click', async () => {
    if (previewing) return stopPreview();
    try {
      const audio = await build();
      T.player.play(audio, 0, T.duration(audio), () => setPreviewUi(false));
      setPreviewUi(true);
      status(null);
    } catch (err) {
      status(err.message, 'error');
    }
  });

  Tabs.onChange((tab) => tab !== 'join' && stopPreview());

  $('join-save').addEventListener('click', async () => {
    const btn = $('join-save');
    if (btn.disabled) return;
    btn.disabled = true;
    const controller = new AbortController();
    const untrack = trackController(controller);
    try {
      stopPreview();
      status('Joining…');
      const audio = await build();
      const ready = items.filter((it) => it.audio);
      const title = `${ready[0].name} + ${ready.length - 1} more (joined)`;
      const saved = await T.save(audio, picker.value, title, { signal: controller.signal });
      results.add(saved, picker.describe());
      status(saved.saved ? null : 'Not saved.');
    } catch (err) {
      status(err.name === 'AbortError' ? 'Stopped.' : err.message || 'Something went wrong.', 'error');
    } finally {
      untrack();
      btn.disabled = false;
    }
  });

  render();
})();
