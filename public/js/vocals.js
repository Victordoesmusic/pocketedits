// Vocals tab: split a track into two stems with the chosen RoFormer model.
(() => {
  const statusEl = document.getElementById('split-status');
  const modelSelect = document.getElementById('model-select');
  const modelNote = document.getElementById('model-note');
  const results = Results.create(document.getElementById('split-results'));
  let models = [];

  function currentModel() {
    return models.find((m) => m.id === modelSelect.value);
  }

  function renderModelNote() {
    const model = currentModel();
    if (!model) return;
    modelNote.textContent = model.downloaded ? model.note : `${model.note} · downloads once on first use (roughly 0.5–1GB)`;
  }

  async function loadModels() {
    try {
      models = await (await fetch('/api/models')).json();
      const previous = modelSelect.value;
      modelSelect.innerHTML = '';
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.downloaded ? model.label : `${model.label} — needs download`;
        modelSelect.appendChild(option);
      }
      if (previous) modelSelect.value = previous;
      renderModelNote();
    } catch {
      modelNote.textContent = 'Could not load the model list.';
    }
  }

  modelSelect.addEventListener('change', renderModelNote);
  loadModels();

  wireDropzone({
    zoneId: 'split-dropzone',
    labelId: 'split-label',
    spinnerId: 'split-spinner',
    inputId: 'split-input',
    idleLabel: 'Drop a track to split',
    busyLabel: 'Separating…',
    onFile: async (file) => {
      const controller = new AbortController();
      const untrack = trackController(controller);
      const model = currentModel();
      setStatus(
        statusEl,
        model && !model.downloaded
          ? 'Downloading the separation model first — this happens once and may take a while…'
          : `Separating "${file.name}" — roughly half the track's length…`,
        'info'
      );
      try {
        const formData = new FormData();
        formData.append('model', modelSelect.value);
        formData.append('file', file);
        const response = await fetch('/api/separate', { method: 'POST', body: formData, signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || 'Separation failed.');
        }

        const { jobId, stems, stemNames } = await response.json();
        for (const stem of stems) {
          if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
          setStatus(statusEl, `Saving ${stemNames[stem]}…`, 'info');
          const saved = await saveResponse(await fetch(`/api/separate/${jobId}/${stem}`, { signal: controller.signal }));
          results.add(saved, 'MP3 · 320 kbps');
        }
        statusEl.classList.add('hidden');
        loadModels();
      } catch (err) {
        setStatus(statusEl, err.name === 'AbortError' ? 'Stopped.' : err.message || 'Something went wrong.', 'error');
      } finally {
        untrack();
      }
    },
  });
})();
