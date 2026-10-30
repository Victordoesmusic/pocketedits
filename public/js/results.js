// "Finished" list: one row per saved file, with play/pause and reveal-in-folder.
// Playback uses the blob the file was saved from, so it works without touching disk.
const Results = (() => {
  const PLAY_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
  const PAUSE_ICON =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>';
  const FOLDER_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const revealLabel = (bridge && bridge.revealLabel) || 'Show in Finder';

  Tabs.onChange(() => Playback.stop());

  // Wires a play button to a blob URL; the row gets .is-playing while it plays.
  function wirePlay(button, row, url, name) {
    const set = (on) => {
      button.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
      button.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} ${name}`);
      button.setAttribute('aria-pressed', String(on));
      row.classList.toggle('is-playing', on);
    };
    set(false);
    button.addEventListener('click', () => Playback.toggle(url, set));
  }

  function create(container) {
    container.classList.add('results', 'hidden');
    container.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="field-label">Saved</span>
        <button type="button" class="text-btn" data-clear>Clear list</button>
      </div>
      <ul class="flex flex-col gap-1" data-list></ul>`;
    const list = container.querySelector('[data-list]');
    const items = [];

    container.querySelector('[data-clear]').addEventListener('click', () => {
      Playback.stop();
      items.forEach((it) => URL.revokeObjectURL(it.objectUrl));
      items.length = 0;
      list.innerHTML = '';
      container.classList.add('hidden');
    });

    // saved: the object from saveResponse(); detail: e.g. "MP3, 320 kbps".
    function add(saved, detail) {
      if (!saved.saved) {
        URL.revokeObjectURL(saved.objectUrl);
        return;
      }
      const row = document.createElement('li');
      row.className = 'result-row fade-in';
      const canReveal = Boolean(bridge && saved.savedPath);
      row.innerHTML = `
        <button type="button" class="play-btn" data-play></button>
        <div class="min-w-0 flex-1">
          <p class="q-name" title="${escapeHtml(saved.savedPath || saved.filename)}">${escapeHtml(saved.savedPath ? saved.savedPath.split('/').pop() : saved.filename)}</p>
          <p class="q-meta"><span>${escapeHtml(detail || '')}</span><span>${formatBytes(saved.size)}</span></p>
        </div>
        ${canReveal ? `<button type="button" class="icon-btn" data-reveal title="${revealLabel}" aria-label="${revealLabel}: ${escapeHtml(saved.filename)}">${FOLDER_ICON}</button>` : ''}`;
      wirePlay(row.querySelector('[data-play]'), row, saved.objectUrl, saved.filename);
      if (canReveal) row.querySelector('[data-reveal]').addEventListener('click', () => bridge.showInFolder(saved.savedPath));
      list.prepend(row);
      items.push({ row, objectUrl: saved.objectUrl });
      container.classList.remove('hidden');
    }

    return { add };
  }

  return { create, wirePlay, revealLabel, FOLDER_ICON, stop: () => Playback.stop() };
})();
