// Convert tab: audio or video files in, audio in the chosen format out. Every item keeps its own
// state (ready → converting → saved / failed / cancelled), so nothing is silently dropped:
// failed items can be retried, saved ones played or revealed, and the queue stays until
// the user clears it.
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('convert-form');
  const button = $('convert-btn');
  const buttonLabel = $('convert-btn-label');
  const cancelBtn = $('convert-cancel');
  const hint = $('convert-hint');
  const fileInput = $('convert-file-input');
  const fileList = $('convert-file-list');
  const drop = $('convert-drop');
  const picker = FormatPicker.create($('convert-format'), { id: 'convert' });

  const PENDING = ['ready', 'failed', 'cancelled'];

  let files = []; // queue items for Files
  let nextId = 1;
  let running = false;
  let controller = null;

  const items = () => files;

  // ---------- Files ----------

  const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toUpperCase();

  // Reads the length from the browser's own metadata parser; formats it can't read
  // (e.g. MKV, AVI) simply show no duration.
  function probeDuration(file) {
    return new Promise((resolve) => {
      const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);
      const el = document.createElement(isVideo ? 'video' : 'audio');
      const url = URL.createObjectURL(file);
      let settled = false;
      const finish = (d) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        el.removeAttribute('src');
        resolve(Number.isFinite(d) && d > 0 ? d : null);
      };
      el.preload = 'metadata';
      el.onloadedmetadata = () => finish(el.duration);
      el.onerror = () => finish(null);
      setTimeout(() => finish(null), 5000);
      el.src = url;
    });
  }

  function addFiles(list) {
    for (const file of list) {
      if (files.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const item = { id: nextId++, kind: 'file', file, name: file.name, ext: extOf(file.name), duration: null, state: 'ready' };
      files.push(item);
      probeDuration(file).then((d) => {
        item.duration = d;
        updateRow(item);
      });
    }
    refresh();
  }

  function removeItem(item) {
    if (item.saved) URL.revokeObjectURL(item.saved.objectUrl);
    files = files.filter((it) => it !== item);
    refresh();
  }

  drop.addEventListener('click', () => !running && fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !running) {
      e.preventDefault();
      fileInput.click();
    }
  });
  $('convert-add').addEventListener('click', () => fileInput.click());
  $('convert-clear').addEventListener('click', () => {
    Playback.stop();
    files.forEach((it) => it.saved && URL.revokeObjectURL(it.saved.objectUrl));
    files = [];
    refresh();
    drop.focus();
  });
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  // Files dropped anywhere on the card are added to the queue.
  wireDropTarget(form, {
    accepts: () => !running,
    highlight: () => (files.length ? fileList : drop),
    onDrop: (dt) => dt.files && dt.files.length && addFiles([...dt.files]),
  });

  // ---------- Rendering ----------

  const ICONS = {
    ready: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
    working: '<span class="spinner w-3.5 h-3.5 rounded-full" aria-hidden="true"></span>',
    done: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
    failed: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    cancelled: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
  };
  const REMOVE_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function stateText(item) {
    switch (item.state) {
      case 'working':
        return item.progress == null ? `${item.stage || 'Starting'}…` : `${item.stage} ${Math.round(item.progress * 100)}%`;
      case 'done':
        return `Saved as ${item.saved.savedPath ? item.saved.savedPath.split('/').pop() : item.saved.filename}`;
      case 'failed':
        return item.error;
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Ready';
    }
  }

  function rowFor(item) {
    const li = document.createElement('li');
    li.className = 'q-row';
    li.dataset.id = item.id;
    li.dataset.state = item.state;
    const label = item.name;
    const meta = [
      `<span class="badge">${escapeHtml(item.ext)}</span>`,
      item.duration ? `<span>${AudioTools.formatTime(item.duration, 0)}</span>` : '',
      `<span class="q-state" title="${escapeHtml(stateText(item))}">${escapeHtml(stateText(item))}</span>`,
    ].join('');
    const actions = [];
    if (item.state === 'done') {
      actions.push('<button type="button" class="play-btn" data-play></button>');
      if (bridge && item.saved.savedPath) actions.push(`<button type="button" class="icon-btn" data-reveal title="${Results.revealLabel}" aria-label="${Results.revealLabel}: ${escapeHtml(label)}">${Results.FOLDER_ICON}</button>`);
    }
    if (item.state === 'failed') actions.push(`<button type="button" class="text-btn" data-retry aria-label="Retry ${escapeHtml(label)}">Retry</button>`);
    if (item.state !== 'working') actions.push(`<button type="button" class="icon-btn" data-remove aria-label="Remove ${escapeHtml(label)}">${REMOVE_ICON}</button>`);

    li.innerHTML = `
      <span class="q-icon">${ICONS[item.state]}</span>
      <div class="min-w-0 flex-1">
        <p class="q-name" title="${escapeHtml(label)}">${escapeHtml(label)}</p>
        <p class="q-meta">${meta}</p>
      </div>
      ${actions.join('')}
      ${item.state === 'working' && item.progress != null ? `<span class="q-bar" style="transform:scaleX(${item.progress})"></span>` : ''}`;

    li.querySelector('[data-play]') && Results.wirePlay(li.querySelector('[data-play]'), li, item.saved.objectUrl, label);
    li.querySelector('[data-reveal]')?.addEventListener('click', () => bridge.showInFolder(item.saved.savedPath));
    li.querySelector('[data-retry]')?.addEventListener('click', () => runItems([item]));
    li.querySelector('[data-remove]')?.addEventListener('click', () => removeItem(item));
    li.querySelectorAll('button').forEach((b) => (b.disabled = running && !b.matches('[data-play], [data-reveal]')));
    return li;
  }

  function updateRow(item) {
    const old = document.querySelector(`.q-row[data-id="${item.id}"]`);
    if (old) old.replaceWith(rowFor(item));
  }

  function renderList(listEl, list) {
    listEl.innerHTML = '';
    list.forEach((item) => listEl.appendChild(rowFor(item)));
  }

  // Redraws the queue, the drop zone/queue swap, and the button and its explanation.
  function refresh() {
    renderList(fileList, files);
    drop.classList.toggle('hidden', files.length > 0);
    $('convert-queue-wrap').classList.toggle('hidden', files.length === 0);
    $('convert-queue-count').textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
    $('convert-add').disabled = running;
    $('convert-clear').disabled = running;

    if (!running) updateButton();
  }

  // ---------- Button ----------

  function blocker() {
    return files.length ? null : 'Add audio or video files to convert.';
  }

  function targets() {
    const pending = items().filter((it) => PENDING.includes(it.state));
    return pending.length ? pending : items();
  }

  function updateButton() {
    const reason = blocker();
    button.disabled = Boolean(reason);
    button.removeAttribute('aria-disabled');
    if (reason) {
      buttonLabel.textContent = 'Convert';
      hint.textContent = reason;
      return;
    }
    const n = targets().length;
    const noun = n === 1 ? 'file' : 'files';
    buttonLabel.textContent = `Convert ${n} ${noun} to ${picker.label}`;
    hint.textContent = items().every((it) => it.state === 'done')
        ? 'Everything here is converted. Converting again saves new copies.'
        : '';
  }
  picker.onChange(() => !running && updateButton());

  function showProgress(text, progress) {
    button.classList.add('is-busy');
    button.classList.toggle('is-indeterminate', progress === null);
    $('convert-btn-fill').style.transform = `scaleX(${progress === null ? 1 : Math.max(0.02, progress)})`;
    buttonLabel.textContent = progress === null ? `${text}…` : `${text} ${Math.round(progress * 100)}%`;
  }

  // ---------- Jobs (server side: /api/jobs/*) ----------

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
    });

  // fetch() can't report upload progress, so files go up through XHR.
  function upload(url, body, { signal, onProgress }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => resolve({ ok: xhr.status < 400, data: xhr.response || {} });
      xhr.onerror = () => reject(new Error('Upload failed.'));
      xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body);
    });
  }

  // Polls a job until it's done (reporting stage/progress), then saves its file.
  async function followJob(jobId, { signal, onProgress }) {
    const cancel = () => fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        const r = await fetch(`/api/jobs/${jobId}`, { signal });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.state === 'error') throw new Error(d.error || 'Conversion failed.');
        if (d.state === 'done') break;
        onProgress(d.stage, d.progress);
        await sleep(250, signal);
      }
      onProgress('Saving', null);
      return await saveResponse(await fetch(`/api/jobs/${jobId}/file`, { signal }));
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async function convertItem(item, output, opts) {
    // Upload is the first 15% of a file's progress; the server's encode is the rest.
    const body = new FormData();
    Object.entries(output).forEach(([k, v]) => body.append(k, v));
    body.append('file', item.file);
    const { ok, data } = await upload('/api/jobs/convert-file', body, {
      signal: opts.signal,
      onProgress: (p) => opts.onProgress('Uploading', 0.15 * p),
    });
    if (!ok) throw new Error(data.error || 'Conversion failed.');
    return followJob(data.jobId, { ...opts, onProgress: (stage, p) => opts.onProgress(stage, p === null ? null : 0.15 + 0.85 * p) });
  }

  // ---------- Run ----------

  async function runItems(list) {
    if (running || !list.length) return;
    running = true;
    // Cancel sits next to the button here, so the floating Stop isn't used.
    controller = new AbortController();
    const output = picker.value;
    button.setAttribute('aria-disabled', 'true');
    cancelBtn.classList.remove('hidden');
    hint.textContent = '';
    list.forEach((it) => {
      if (it.saved) URL.revokeObjectURL(it.saved.objectUrl);
      Object.assign(it, { state: 'ready', saved: null, error: '', progress: null });
    });
    refresh();

    const total = list.length;
    let done = 0;
    let failed = 0;
    for (let i = 0; i < total; i++) {
      const item = list[i];
      if (controller.signal.aborted) break;
      Object.assign(item, { state: 'working', stage: 'Starting', progress: null });
      updateRow(item);
      const prefix = total > 1 ? `${i + 1} of ${total} · ` : '';
      try {
        const saved = await convertItem(item, output, {
          signal: controller.signal,
          onProgress: (stage, p) => {
            Object.assign(item, { stage, progress: p });
            updateRow(item);
            showProgress(`${prefix}${stage}`, p === null ? null : total > 1 ? (i + p) / total : p);
          },
        });
        if (!saved.saved) throw new Error('The file could not be written to the save folder.');
        Object.assign(item, { state: 'done', saved });
        done++;
      } catch (err) {
        if (err.name === 'AbortError') {
          item.state = 'cancelled';
          updateRow(item);
          break;
        }
        Object.assign(item, { state: 'failed', error: err.message || 'Conversion failed.' });
        failed++;
      }
      updateRow(item);
    }

    const cancelled = controller.signal.aborted;
    running = false;
    controller = null;
    button.classList.remove('is-busy', 'is-indeterminate');
    $('convert-btn-fill').style.transform = 'scaleX(0)';
    cancelBtn.classList.add('hidden');
    refresh();
    const where = Destination.name ? ` to ${Destination.name}` : '';
    hint.textContent = cancelled
      ? `Cancelled. ${done} saved before stopping.`
      : failed
      ? `${done} saved${where}, ${failed} failed. Use Retry to try again.`
      : `${done} saved${where}.`;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running || blocker()) return;
    runItems(targets());
  });
  cancelBtn.addEventListener('click', () => controller?.abort());

  refresh();
})();
