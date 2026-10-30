// Key & BPM tab: analyze a dropped audio or video file.
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('analyze-status');
  const resultEl = $('analyze-result');

  function showAnalysis(data) {
    $('analyze-title').textContent = data.title;
    // Audio with no steady beat (speech, ambience) comes back as 0.
    $('analyze-bpm').textContent = data.bpm >= 1 ? Math.round(data.bpm) : '—';
    // Fraunces has no ♭/♯ glyphs, and the default fallback spaces them oddly, so they get their own font.
    const keyEl = $('analyze-key');
    keyEl.textContent = '';
    for (const part of data.key.split(/([♭♯])/)) {
      if (!part) continue;
      const span = document.createElement('span');
      span.textContent = part;
      if (part === '♭' || part === '♯') span.className = 'accidental';
      keyEl.appendChild(span);
    }
    statusEl.classList.add('hidden');
    resultEl.classList.remove('hidden');
  }

  // Sends the request, shows progress, then the result or error.
  async function runAnalysisRequest(makeRequest, message) {
    const controller = new AbortController();
    const untrack = trackController(controller);
    resultEl.classList.add('hidden');
    setStatus(statusEl, message, 'info');
    try {
      const response = await makeRequest(controller.signal);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Analysis failed.');
      showAnalysis(data);
    } catch (err) {
      setStatus(statusEl, err.name === 'AbortError' ? 'Stopped.' : err.message || 'Something went wrong.', 'error');
    } finally {
      untrack();
    }
  }

  wireDropzone({
    zoneId: 'analyze-dropzone',
    labelId: 'analyze-label',
    spinnerId: 'analyze-spinner',
    inputId: 'analyze-input',
    idleLabel: 'Drop a track to analyze',
    busyLabel: 'Listening…',
    onFile: (file) =>
      runAnalysisRequest((signal) => {
        const formData = new FormData();
        formData.append('file', file);
        return fetch('/api/analyze', { method: 'POST', body: formData, signal });
      }, `Analyzing "${file.name}" — usually under 30 seconds…`),
  });

})();
