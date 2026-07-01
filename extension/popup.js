(() => {
  'use strict';

  const ARIA2_PORT = 6800;
  const WS_POLL_INTERVAL = 1500;   // ms between tellActive calls
  const REST_POLL_INTERVAL = 2500; // fallback polling interval
  const MAX_RECENT = 8;
  const MAX_HISTORY = 100;

  const CAT_ICONS = {
    Videos:    '\uD83D\uDCF9',
    Audio:     '\uD83C\uDFB5',
    Documents: '\uD83D\uDCC4',
    Archives:  '\uD83D\uDCE6',
    Images:    '\uD83D\uDDBC\uFE0F',
    Software:  '\u2699\uFE0F',
    Other:     '\uD83D\uDCE5',
  };

  let serverPort = 3000;
  let aria2Port = ARIA2_PORT;
  let serverOk = false;
  let ws = null;
  let wsReady = false;
  let pollTimer = null;
  let activeGids = new Map();   // gid → merged download object
  let historyItems = [];        // from /api/history
  const normalisedCache = new Map(); // gid → normalised dl (invalidated on data change)
  let pendingStreamGid = null; // gid for which quality selector is shown in sidebar
  let pendingStreamQualities = new Map(); // gid → formats from /api/qualities
  let streamingItems = new Map(); // gid → { quality, startTime } for showing progress bar during stream prep
  const pendingRpcCallbacks = new Map();
  let cachedActiveMerges = {};
  let activeMergesPollCounter = 0;
  let detectedStreamsList = [];

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const $ = (sel) => document.querySelector(sel);
  const el = {
    statusDot:    () => $('#status-dot'),
    statusLabel:  () => $('#status-label'),
    speedBadge:   () => $('#speed-badge'),
    sectionActive:() => $('#section-active'),
    sectionPaused:() => $('#section-paused'),
    sectionRecent:() => $('#section-recent'),
    activeCount:  () => $('#active-count'),
    pausedCount:  () => $('#paused-count'),
    recentCount:  () => $('#recent-count'),
    activeList:   () => $('#active-list'),
    pausedList:   () => $('#paused-list'),
    recentList:   () => $('#recent-list'),
    emptyState:   () => $('#empty-state'),
    offlineState: () => $('#offline-state'),
    btnDashboard: () => $('#btn-dashboard'),
    sectionStreams:() => $('#section-streams'),
    streamsCount:  () => $('#streams-count'),
    streamsList:   () => $('#streams-list'),
  };

  async function init() {
    bindEvents();
    setStatus('connecting');

    serverOk = await detectServer();

    if (!serverOk) {
      setStatus('disconnected');
      showOffline(true);
      return;
    }

    showOffline(false);
    setStatus('connected');

    await fetchHistory();
    await loadSettings();
    try {
      detectedStreamsList = await fetchDetectedStreams();
    } catch (e) {}
    render();
    connectWS();
    startPolling();
  }

  function bindEvents() {
    el.btnDashboard().addEventListener('click', openDashboard);

    // Event delegation on document body to avoid re-attaching listeners on every poll tick
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        const action = btn.dataset.action;
        const gid = btn.dataset.gid;
        handleAction(action, gid);
        return;
      }

      const streamBtn = e.target.closest('[data-stream-action]');
      if (streamBtn) {
        const action = streamBtn.dataset.streamAction;
        const url = streamBtn.dataset.url;
        handleDetectedStreamAction(action, url);
        return;
      }

      // Quality option card selection
      const qualityOpt = e.target.closest('.quality-opt');
      if (qualityOpt) {
        const container = qualityOpt.closest('.quality-options');
        if (container) {
          container.querySelectorAll('.quality-opt').forEach(o => o.classList.remove('quality-opt--selected'));
          qualityOpt.classList.add('quality-opt--selected');
          const radio = qualityOpt.querySelector('.quality-opt-radio');
          if (radio) radio.checked = true;
        }
      }
    });
  }

  // Settings management
  async function loadSettings() {
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/settings`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const settings = await res.json();
        const speed = parseInt(settings.maxDownloadSpeed, 10) || 0;
        const subs = !!settings.downloadSubtitles;
        const slider = document.getElementById('setting-bandwidth');
        const label = document.getElementById('bandwidth-value');
        const subToggle = document.getElementById('setting-subtitles');
        if (slider) slider.value = speed;
        if (label) label.textContent = speed > 0 ? `${speed} KB/s` : 'Unlimited';
        if (subToggle) subToggle.checked = subs;
      }
    } catch (e) {
      console.warn('[Settings] Failed to load:', e);
    }

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/scheduled`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const scheduled = await res.json();
        const count = document.getElementById('scheduled-count');
        if (count) count.textContent = scheduled.length;
      }
    } catch (e) {}

    // Bind settings controls
    const settingsBtn = document.getElementById('btn-settings');
    const settingsClose = document.getElementById('btn-settings-close');
    const settingsPanel = document.getElementById('settings-panel');
    const slider = document.getElementById('setting-bandwidth');
    const sliderLabel = document.getElementById('bandwidth-value');
    const subToggle = document.getElementById('setting-subtitles');

    if (settingsBtn && settingsPanel) {
      settingsBtn.addEventListener('click', () => {
        settingsPanel.hidden = !settingsPanel.hidden;
      });
    }
    if (settingsClose && settingsPanel) {
      settingsClose.addEventListener('click', () => { settingsPanel.hidden = true; });
    }

    if (slider) {
      slider.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        if (sliderLabel) sliderLabel.textContent = val > 0 ? `${val} KB/s` : 'Unlimited';
      });
      slider.addEventListener('change', async () => {
        const val = parseInt(slider.value, 10);
        try {
          await fetch(`http://localhost:${serverPort}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxDownloadSpeed: val })
          });
        } catch (e) {}
      });
    }

    if (subToggle) {
      subToggle.addEventListener('change', async () => {
        try {
          await fetch(`http://localhost:${serverPort}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadSubtitles: subToggle.checked })
          });
        } catch (e) {}
      });
    }
  }

  // Schedule download
  let pendingScheduleData = null;

  function getLocalDateTimeString(date) {
    const pad = (num) => String(num).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function showScheduleModal(data) {
    pendingScheduleData = data;
    const overlay = document.getElementById('schedule-overlay');
    const datetimeInput = document.getElementById('schedule-datetime');
    if (!overlay || !datetimeInput) return;

    // Default to 1 hour from now
    const defaultTime = new Date(Date.now() + 3600000);
    datetimeInput.value = getLocalDateTimeString(defaultTime);
    datetimeInput.min = getLocalDateTimeString(new Date());
    overlay.hidden = false;
  }

  function hideScheduleModal() {
    const overlay = document.getElementById('schedule-overlay');
    if (overlay) overlay.hidden = true;
    pendingScheduleData = null;
  }

  // Bind schedule modal buttons
  document.getElementById('btn-schedule-cancel')?.addEventListener('click', hideScheduleModal);
  document.getElementById('btn-schedule-ok')?.addEventListener('click', async () => {
    const datetimeInput = document.getElementById('schedule-datetime');
    if (!datetimeInput || !pendingScheduleData) return;

    const scheduledTime = new Date(datetimeInput.value).getTime();
    if (isNaN(scheduledTime) || scheduledTime <= Date.now()) {
      return;
    }

    try {
      await fetch(`http://localhost:${serverPort}/api/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...pendingScheduleData,
          scheduledTime
        })
      });
    } catch (e) {}

    hideScheduleModal();
  });

  async function detectServer() {
    for (const port of [3000, 3999, 8080, 4000]) {
      try {
        const res = await fetch(`http://localhost:${port}/api/ping`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const data = await res.json();
          serverPort = data.webPort || port;
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  }

  async function fetchHistory() {
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/history`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        historyItems = await res.json();
      }
    } catch { /* keep stale */ }
  }

  function connectWS() {
    try {
      ws = new WebSocket(`ws://localhost:${aria2Port}/jsonrpc`);
    } catch {
      wsReady = false;
      return;
    }

    ws.onopen = () => {
      wsReady = true;
      setStatus('connected');
      startPolling();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.method) {
          handleNotification(msg);
        } else if (msg.id && pendingRpcCallbacks.has(msg.id)) {
          const cb = pendingRpcCallbacks.get(msg.id);
          pendingRpcCallbacks.delete(msg.id);
          clearTimeout(cb.timeoutId);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      wsReady = false;
      startPolling();
      setTimeout(connectWS, 5000);
    };

    ws.onerror = () => {
      wsReady = false;
      startPolling();
    };
  }

  function handleNotification(msg) {
    const method = msg.method;
    if (method === 'aria2.onDownloadComplete' || method === 'aria2.onDownloadError') {
      fetchHistory().then(render);
    }
  }

  function aria2Rpc(method, params = []) {
    const id = `popup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      if (!wsReady || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      const timeoutId = setTimeout(() => {
        if (pendingRpcCallbacks.has(id)) {
          pendingRpcCallbacks.delete(id);
          reject(new Error('RPC timeout'));
        }
      }, 4000);

      pendingRpcCallbacks.set(id, { resolve, reject, timeoutId });

      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        pendingRpcCallbacks.delete(id);
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      if (wsReady) {
        await pollAria2WS();
      } else {
        await fetchHistory();
      }
      try {
        detectedStreamsList = await fetchDetectedStreams();
      } catch (e) {
        detectedStreamsList = [];
      }
      render();
    }, wsReady ? WS_POLL_INTERVAL : REST_POLL_INTERVAL);
  }

  async function pollAria2WS() {
    try {
      const hasActiveYt = historyItems.some(h => h.gid && h.gid.startsWith('youtube-') && (h.status === 'active' || h.status === 'merging'));
      if (hasActiveYt || activeMergesPollCounter % 4 === 0) {
        historyItems = await fetch(`http://localhost:${serverPort}/api/history`)
          .then(r => r.json())
          .catch(() => historyItems);
      }

      if (activeMergesPollCounter % 6 === 0) {
        cachedActiveMerges = await fetch(`http://localhost:${serverPort}/api/active-merges`)
          .then(r => r.json())
          .catch(() => ({}));
      }
      activeMergesPollCounter++;
      const activeMerges = cachedActiveMerges;

      const KEYS = ['gid','status','totalLength','completedLength',
                     'downloadSpeed','uploadSpeed','files','errorCode',
                     'errorMessage','dir'];

      const [activeRaw, waitingRaw, stoppedRaw] = await Promise.all([
        aria2Rpc('aria2.tellActive', [KEYS]),
        aria2Rpc('aria2.tellWaiting', [0, 20, KEYS]),
        aria2Rpc('aria2.tellStopped', [0, MAX_RECENT, KEYS]),
      ]);

      const active = [];
      const waiting = [];
      const stopped = [];
      const processedMergedGids = new Set();

      const processItem = (item, targetList) => {
        if (activeMerges && activeMerges[item.gid]) {
          const info = activeMerges[item.gid];
          if (!processedMergedGids.has(info.mergedGid)) {
            processedMergedGids.add(info.mergedGid);

            const allRaw = [...activeRaw, ...waitingRaw, ...stoppedRaw];
            const videoAd = allRaw.find(x => x.gid === info.videoGid) || { totalLength: '0', completedLength: '0', downloadSpeed: '0', status: 'complete' };
            const audioAd = allRaw.find(x => x.gid === info.audioGid) || { totalLength: '0', completedLength: '0', downloadSpeed: '0', status: 'complete' };

            const videoDone = parseInt(videoAd.completedLength) || 0;
            const videoTotal = parseInt(videoAd.totalLength) || 0;
            const audioDone = parseInt(audioAd.completedLength) || 0;
            const audioTotal = parseInt(audioAd.totalLength) || 0;

            const combinedDone = videoDone + audioDone;
            const combinedTotal = videoTotal + audioTotal;
            const combinedSpeed = (parseInt(videoAd.downloadSpeed) || 0) + (parseInt(audioAd.downloadSpeed) || 0);

            let status = item.status;
            if (videoAd.status === 'paused' && audioAd.status === 'paused') {
              status = 'paused';
            }

            targetList.push({
              gid: info.mergedGid,
              status: status,
              totalLength: String(combinedTotal || 1000000),
              completedLength: String(combinedDone),
              downloadSpeed: combinedSpeed,
              dir: info.dir,
              filename: info.finalName,
              files: [{ path: (info.dir ? info.dir.replace(/[/\\]+$/, '') + '/' : '') + info.finalName }],
              category: 'Videos',
              errorCode: videoAd.errorCode || audioAd.errorCode,
              errorMessage: videoAd.errorMessage || audioAd.errorMessage,
              uploadSpeed: (parseInt(videoAd.uploadSpeed) || 0) + (parseInt(audioAd.uploadSpeed) || 0)
            });
          }
        } else {
          if (activeMerges && activeMerges[item.gid]) return;
          targetList.push(item);
        }
      };

      activeRaw.forEach(item => processItem(item, active));
      waitingRaw.forEach(item => processItem(item, waiting));
      stoppedRaw.forEach(item => processItem(item, stopped));

      activeGids.clear();
      for (const dl of [...active, ...waiting]) {
        activeGids.set(dl.gid, normaliseDl(dl));
      }

      for (const dl of stopped) {
        const idx = historyItems.findIndex(h => h.gid === dl.gid);
        const merged = normaliseDl(dl);
        if (idx >= 0) {
          historyItems[idx].status = dl.status;
          historyItems[idx].completedLength = merged.completedLength;
          historyItems[idx].totalLength = merged.totalLength;
          historyItems[idx].downloadSpeed = merged.downloadSpeed;
          historyItems[idx].percent = merged.percent;
          historyItems[idx].errorCode = merged.errorCode;
          historyItems[idx].errorMessage = merged.errorMessage;
        } else {
          historyItems.push(merged);
        }
      }

      // Cap history to prevent unbounded growth
      if (historyItems.length > MAX_HISTORY) {
        historyItems = historyItems.slice(0, MAX_HISTORY);
      }
    } catch {
      if (wsReady) {
        wsReady = false;
        startPolling();
      } else {
        wsReady = false;
      }
      await fetchHistory();
    }
  }

  function normaliseDl(raw) {
    if (!raw || !raw.gid) return null;

    // Cache by gid + status + completedLength to avoid re-creating on every poll
    const cacheKey = `${raw.gid}|${raw.status}|${raw.completedLength}`;
    if (normalisedCache.has(cacheKey)) return normalisedCache.get(cacheKey);

    const total = parseInt(raw.totalLength, 10) || 0;
    const done  = parseInt(raw.completedLength, 10) || 0;
    const speed = parseInt(raw.downloadSpeed, 10) || 0;
    const file  = raw.files?.[0];
    const fname = file?.path ? file.path.split('/').pop() : (raw.filename || 'download');
    const ext   = fname.split('.').pop()?.toLowerCase() || '';
    const cat   = raw.category || guessCategory(ext);

    const result = {
      gid:            raw.gid,
      status:         raw.status || 'unknown',
      filename:       fname,
      totalLength:    total,
      completedLength:done,
      downloadSpeed:  speed,
      errorCode:      raw.errorCode,
      errorMessage:   raw.errorMessage,
      category:       cat,
      dir:            raw.dir || file?.dir || '',
      path:           file?.path || '',
      percent:        total > 0 ? Math.round((done / total) * 100) : 0,
      eta:            speed > 0 && total > done ? Math.ceil((total - done) / speed) : 0,
      phase:          raw.phase,
      url:            raw.url || (raw.urls && raw.urls[0]) || '',
      urls:           raw.urls || []
    };

    // Cap cache to prevent unbounded growth
    if (normalisedCache.size > 200) normalisedCache.clear();
    normalisedCache.set(cacheKey, result);
    return result;
  }

  function guessCategory(ext) {
    const map = {
      Videos:    ['mp4','mkv','avi','mov','webm','flv','wmv','m4v'],
      Audio:     ['mp3','flac','wav','aac','ogg','m4a','wma','opus'],
      Documents: ['pdf','doc','docx','xls','xlsx','ppt','pptx','epub','txt'],
      Archives:  ['zip','rar','7z','tar','gz','iso','cab'],
      Images:    ['jpg','jpeg','png','gif','svg','webp','bmp'],
      Software:  ['exe','msi','dmg','pkg','deb','rpm','apk'],
    };
    for (const [cat, exts] of Object.entries(map)) {
      if (exts.includes(ext)) return cat;
    }
    return 'Other';
  }

  function render() {
    const active  = [];
    const paused  = [];
    const recent  = [];

    const seen = new Set();

    for (const dl of activeGids.values()) {
      seen.add(dl.gid);
      if (dl.status === 'active' || dl.status === 'merging') active.push(dl);
      else if (dl.status === 'paused' || dl.status === 'waiting') paused.push(dl);
    }

    for (const h of historyItems) {
      if (seen.has(h.gid)) continue;
      seen.add(h.gid);
      const dl = normaliseDl(h);
      if (!dl) continue;
      if (dl.status === 'active' || dl.status === 'merging') active.push(dl);
      else if (dl.status === 'paused' || dl.status === 'waiting') paused.push(dl);
      else recent.push(dl);
    }

    recent.sort((a, b) => {
      const oa = order(a.status);
      const ob = order(b.status);
      return oa - ob;
    });
    const recentShown = recent.slice(0, MAX_RECENT);

    const totalSpeed = active.reduce((s, d) => s + d.downloadSpeed, 0);
    updateSpeed(totalSpeed);

    el.sectionActive().hidden = active.length === 0;
    el.sectionPaused().hidden = paused.length === 0;
    el.sectionRecent().hidden = recentShown.length === 0;
    el.emptyState().hidden = active.length + paused.length + recentShown.length > 0;

    el.activeCount().textContent = active.length;
    el.pausedCount().textContent = paused.length;
    el.recentCount().textContent = recentShown.length;

    el.activeList().innerHTML = active.map((dl, i) => cardHTML(dl, i)).join('');
    el.pausedList().innerHTML = paused.map((dl, i) => cardHTML(dl, i)).join('');
    el.recentList().innerHTML = recentShown.map((dl, i) => cardHTML(dl, i)).join('');

    const streams = detectedStreamsList || [];
    const streamsList = el.streamsList();
    const streamsSection = el.sectionStreams();
    const streamsCount = el.streamsCount();

    if (streamsList && streamsSection && streamsCount) {
      streamsCount.textContent = streams.length;
      streamsSection.hidden = streams.length === 0;
      streamsList.innerHTML = streams.map((url, i) => streamCardHTML(url, i)).join('');
    }

    el.emptyState().hidden = (active.length + paused.length + recentShown.length + streams.length) > 0;
  }

  function order(status) {
    if (status === 'error') return 0;
    if (status === 'complete') return 1;
    return 2;
  }

  function updateSpeed(speed) {
    if (speed <= 0) {
      el.speedBadge().textContent = '—';
      return;
    }
    const kb = speed / 1024;
    if (kb < 1024) {
      el.speedBadge().textContent = `${kb.toFixed(1)} KB/s`;
    } else {
      el.speedBadge().textContent = `${(kb / 1024).toFixed(1)} MB/s`;
    }
  }

  function setStatus(status) {
    const dot = el.statusDot();
    const label = el.statusLabel();
    if (!dot || !label) return;

    dot.className = 'status-dot';
    if (status === 'connected') {
      dot.classList.add('connected');
      label.textContent = 'Active';
    } else if (status === 'connecting') {
      dot.classList.add('connecting');
      label.textContent = 'Connecting...';
    } else {
      dot.classList.add('disconnected');
      label.textContent = 'Offline';
    }
  }

  function showOffline(isOffline) {
    el.offlineState().hidden = !isOffline;
    if (isOffline) {
      el.sectionActive().hidden = true;
      el.sectionPaused().hidden = true;
      el.sectionRecent().hidden = true;
      el.emptyState().hidden = true;
      el.speedBadge().textContent = '—';
    }
  }

  function openDashboard() {
    chrome.tabs.create({ url: `http://localhost:${serverPort}` });
  }

  function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function formatEta(seconds) {
    if (!seconds || seconds <= 0 || seconds === Infinity) return '';
    seconds = Math.ceil(seconds);
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }

  function cardHTML(dl, index) {
    if (pendingStreamGid === dl.gid) {
      const formats = pendingStreamQualities.get(dl.gid);
      let optionsHtml = '';
      if (formats) {
        const combined = [...(formats.progressive || []), ...(formats.videoOnly || [])];
        if (combined.length > 0) {
          combined.forEach((f, i) => {
            const fid = f.formatId || f.format_id || 'best';
            const resLabel = f.resolution || fid;
            const sizeStr = f.filesizeStr || '';
            const extStr = f.ext || '';
            const selected = i === 0 ? ' quality-opt--selected' : '';
            optionsHtml += `
              <div class="quality-opt${selected}" data-format-id="${esc(fid)}" data-gid="${esc(dl.gid)}">
                <input type="radio" name="stream-q-${esc(dl.gid)}" class="quality-opt-radio" value="${esc(fid)}"${i === 0 ? ' checked' : ''}>
                <div class="quality-opt-info">
                  <span class="quality-opt-label">${esc(resLabel)}</span>
                  ${sizeStr ? `<span class="quality-opt-meta">${esc(sizeStr)}</span>` : ''}
                </div>
                ${extStr ? `<span class="quality-opt-ext">${esc(extStr)}</span>` : ''}
              </div>`;
          });
        } else {
          optionsHtml = `
            <div class="quality-opt quality-opt--selected" data-format-id="best" data-gid="${dl.gid}">
              <input type="radio" name="stream-q-${dl.gid}" class="quality-opt-radio" value="best" checked>
              <div class="quality-opt-info"><span class="quality-opt-label">Best available</span></div>
            </div>`;
        }
      } else {
        ['best', '4k', '1080p', '720p', '480p'].forEach((q, i) => {
          const label = q === 'best' ? 'Best available' : q.toUpperCase();
          const selected = i === 0 ? ' quality-opt--selected' : '';
          optionsHtml += `
            <div class="quality-opt${selected}" data-format-id="${q}" data-gid="${dl.gid}">
              <input type="radio" name="stream-q-${dl.gid}" class="quality-opt-radio" value="${q}"${i === 0 ? ' checked' : ''}>
              <div class="quality-opt-info"><span class="quality-opt-label">${label}</span></div>
            </div>`;
        });
      }
      return `
        <div class="dl-card quality-selector" data-gid="${esc(dl.gid)}">
          <div class="dl-row-top">
            <div class="dl-name">
              <span class="dl-cat cat-${esc(dl.category)}">${CAT_ICONS[dl.category] || CAT_ICONS.Other}</span>
              <span class="dl-filename" title="${esc(dl.filename)}">${esc(dl.filename)}</span>
            </div>
          </div>
          <div class="quality-chooser">
            <label>Select stream quality:</label>
            <div class="quality-options" id="stream-quality-${dl.gid}">
              ${optionsHtml}
            </div>
            <div class="chooser-actions">
              <button class="dl-btn" data-action="confirm-stream-quality" data-gid="${dl.gid}">Stream</button>
              <button class="dl-btn dl-btn--cancel" data-action="cancel-stream-quality" data-gid="${dl.gid}">Cancel</button>
            </div>
          </div>
        </div>
      `;
    }

    if (streamingItems.has(dl.gid)) {
      const info = streamingItems.get(dl.gid);
      const qText = info.quality ? ` @ ${info.quality}` : '';
      return `
        <div class="dl-card streaming" data-gid="${esc(dl.gid)}">
          <div class="dl-row-top">
            <div class="dl-name">
              <span class="dl-cat cat-${esc(dl.category)}">${CAT_ICONS[dl.category] || CAT_ICONS.Other}</span>
              <span class="dl-filename" title="${esc(dl.filename)}">${esc(dl.filename)}</span>
            </div>
          </div>
          <div class="stream-progress">
            <div class="progress-label">Preparing stream${qText}...</div>
            <div class="progress-bar indeterminate"></div>
          </div>
        </div>
      `;
    }

    const catIcon = CAT_ICONS[dl.category] || CAT_ICONS.Other;
    const isFinished = dl.status === 'complete' || dl.status === 'error' || dl.status === 'removed';
    
    let progClass = dl.status;
    if (dl.status === 'waiting') progClass = 'paused';
    if (dl.status === 'merging') progClass = 'active';
    
    let pctClass = '';
    if (dl.status === 'complete') pctClass = 'complete';
    if (dl.status === 'error') pctClass = 'error';

    let metaHtml = '';
    if (dl.status === 'active') {
      const speedText = dl.downloadSpeed > 0 ? formatBytes(dl.downloadSpeed) + '/s' : '0 B/s';
      const etaText = dl.eta ? formatEta(dl.eta) : '';
      let statusLabel = '';
      if (dl.phase === 'audio') statusLabel = '<span class="dl-status-text">Downloading Audio</span><span class="dl-meta-sep">•</span>';
      else if (dl.phase === 'video') statusLabel = '<span class="dl-status-text">Downloading Video</span><span class="dl-meta-sep">•</span>';

      metaHtml = `
        ${statusLabel}
        <span class="dl-speed">${speedText}</span>
        ${etaText ? `<span class="dl-meta-sep">•</span><span class="dl-eta">${etaText}</span>` : ''}
        <span class="dl-meta-sep">•</span>
        <span>${formatBytes(dl.completedLength)} / ${formatBytes(dl.totalLength)}</span>
      `;
    } else if (dl.status === 'merging') {
      metaHtml = `
        <span class="dl-status-text">Merging audio & video…</span>
        <span class="dl-meta-sep">•</span>
        <span>${formatBytes(dl.totalLength)}</span>
      `;
    } else if (dl.status === 'paused' || dl.status === 'waiting') {
      metaHtml = `
        <span class="dl-status-text">Paused</span>
        <span class="dl-meta-sep">•</span>
        <span>${formatBytes(dl.completedLength)} / ${formatBytes(dl.totalLength)}</span>
      `;
    } else if (dl.status === 'complete') {
      metaHtml = `<span class="dl-status-text complete">Complete</span><span class="dl-meta-sep">•</span><span>${formatBytes(dl.totalLength)}</span>`;
    } else if (dl.status === 'error') {
      const errorMsg = dl.errorMessage || 'Unknown Error';
      metaHtml = `<span class="dl-status-text error" title="${esc(errorMsg)}">Error: ${esc(errorMsg)}</span>`;
    } else {
      metaHtml = `<span class="dl-status-text">${dl.status}</span>`;
    }

    let actionsHtml = '';
    if (dl.status === 'active' || dl.status === 'merging') {
      const showPause = dl.status === 'active';
      actionsHtml = `
        ${showPause ? `<button class="dl-btn dl-btn--cancel" data-action="pause" data-gid="${dl.gid}" title="Pause">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="4" width="4" height="16" rx="1"></rect><rect x="6" y="4" width="4" height="16" rx="1"></rect></svg>
        </button>` : ''}
        <button class="dl-btn dl-btn--cancel" data-action="cancel" data-gid="${dl.gid}" title="Cancel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
    } else if (dl.status === 'paused' || dl.status === 'waiting') {
      actionsHtml = `
        <button class="dl-btn" data-action="resume" data-gid="${dl.gid}" title="Resume">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
        <button class="dl-btn dl-btn--cancel" data-action="cancel" data-gid="${dl.gid}" title="Cancel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
    } else if (dl.status === 'complete') {
      const isVideo = ['Videos', 'Audio'].includes(dl.category);
      actionsHtml = `
        ${isVideo ? `
        <button class="dl-btn dl-btn--stream" data-action="stream" data-gid="${dl.gid}" title="Stream">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>` : ''}
        <button class="dl-btn" data-action="reveal" data-gid="${dl.gid}" title="Show in Finder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </button>
        <button class="dl-btn dl-btn--cancel" data-action="remove" data-gid="${dl.gid}" title="Remove from History">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
    } else if (dl.status === 'error' || dl.status === 'removed') {
      actionsHtml = `
        <button class="dl-btn dl-btn--retry" data-action="retry" data-gid="${dl.gid}" title="Retry">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
        </button>
        <button class="dl-btn dl-btn--cancel" data-action="remove" data-gid="${dl.gid}" title="Remove from History">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
    }

    return `
      <div class="dl-card" data-gid="${esc(dl.gid)}">
        <div class="dl-row-top">
          <div class="dl-name">
            <span class="dl-cat cat-${esc(dl.category)}" title="${esc(dl.category)}">${catIcon}</span>
            <span class="dl-filename" title="${esc(dl.filename)}">${esc(dl.filename)}</span>
          </div>
          <span class="dl-pct ${pctClass}">${dl.percent}%</span>
        </div>
        <div class="dl-progress-track">
          <div class="dl-progress-bar ${progClass}" style="width: ${dl.percent}%"></div>
        </div>
        <div class="dl-row-bottom">
          <div class="dl-meta">
            ${metaHtml}
          </div>
          <div class="dl-actions">
            ${actionsHtml}
          </div>
        </div>
      </div>
    `;
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      const overlay = $('#confirm-overlay');
      const msgEl = $('#confirm-message');
      const btnCancel = $('#btn-confirm-cancel');
      const btnOk = $('#btn-confirm-ok');
      
      if (!overlay || !msgEl || !btnCancel || !btnOk) {
        resolve(false);
        return;
      }

      msgEl.textContent = message;
      overlay.hidden = false;

      const cleanUp = (val) => {
        overlay.hidden = true;
        btnCancel.removeEventListener('click', handleCancel);
        btnOk.removeEventListener('click', handleOk);
        resolve(val);
      };

      const handleCancel = () => cleanUp(false);
      const handleOk = () => cleanUp(true);

      btnCancel.addEventListener('click', handleCancel);
      btnOk.addEventListener('click', handleOk);
    });
  }

  async function handleAction(action, gid) {
    try {
      if (action === 'pause') {
        await fetch(`http://localhost:${serverPort}/api/downloads/pause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gid })
        });
        await fetchHistory();
        render();
      } else if (action === 'resume') {
        await fetch(`http://localhost:${serverPort}/api/downloads/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gid })
        });
        await fetchHistory();
        render();
      } else if (action === 'cancel') {
        const confirmed = await showConfirm('Cancel this download?');
        if (confirmed) {
          try {
            if (wsReady) {
              await aria2Rpc('aria2.forceRemove', [gid]).catch(() => {});
            }
          } catch (e) {}
          await fetch(`http://localhost:${serverPort}/api/history/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gid, deleteFile: false })
          });
          await fetchHistory();
          render();
        }
      } else if (action === 'remove') {
        const confirmed = await showConfirm('Remove from history?');
        if (confirmed) {
          await fetch(`http://localhost:${serverPort}/api/history/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gid, deleteFile: false })
          });
          await fetchHistory();
          render();
        }
      } else if (action === 'retry') {
        await fetch(`http://localhost:${serverPort}/api/history/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gid })
        });
        await fetchHistory();
        render();
      } else if (action === 'stream') {
        const dl = activeGids.get(gid) || historyItems.find(h => h.gid === gid);
        if (!dl) return;
        const isVideo = ['Videos', 'Audio'].includes(dl.category);
        const isVideoLike = isVideo || (dl.filename && /\.(mp4|mkv|webm|mov|avi)$/i.test(dl.filename));
        if (isVideoLike && !pendingStreamGid) {
          pendingStreamGid = gid;
          render();
          const dlUrl = dl.url || (dl.urls && dl.urls[0]) || '';
          if (dlUrl) {
            fetch(`http://localhost:${serverPort}/api/qualities`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: dlUrl })
            }).then(r => r.json()).then(data => {
              if (data && data.success && data.formats) {
                pendingStreamQualities.set(gid, data.formats);
                render();
              }
            }).catch(() => {});
          }
          return;
        }
        const selected = pendingStreamGid ? getSelectedQualityForStream(gid) : null;
        if (pendingStreamGid) {
          pendingStreamGid = null;
          pendingStreamQualities.delete(gid);
        }
        startStreamWithProgress(gid, selected, dl);
      } else if (action === 'confirm-stream-quality') {
        const selected = getSelectedQualityForStream(gid);
        const dl = activeGids.get(gid) || historyItems.find(h => h.gid === gid);
        pendingStreamGid = null;
        pendingStreamQualities.delete(gid);
        if (dl) {
          startStreamWithProgress(gid, selected, dl);
        } else {
          render();
        }
      } else if (action === 'cancel-stream-quality') {
        pendingStreamGid = null;
        pendingStreamQualities.delete(gid);
        render();
      } else if (action === 'reveal') {
        const dl = activeGids.get(gid) || historyItems.find(h => h.gid === gid);
        if (!dl) return;
        await fetch(`http://localhost:${serverPort}/api/showInFinder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gid,
            category: dl.category,
            filename: dl.filename,
            filepath: dl.path || ''
          })
        });
      }
    } catch (err) {
      console.error('Failed to execute action:', action, err);
    }
  }

  function getSelectedQualityForStream(gid) {
    const container = document.getElementById(`stream-quality-${gid}`);
    if (!container) return 'best';
    const selected = container.querySelector('.quality-opt--selected');
    return selected ? selected.dataset.formatId : 'best';
  }

  function startStreamWithProgress(gid, quality, dl) {
    streamingItems.set(gid, { quality: quality || 'default', startTime: Date.now() });
    render();

    const body = {
      gid,
      category: dl.category,
      filename: dl.filename,
      filepath: dl.path || '',
      url: dl.url || (dl.urls && dl.urls[0]) || ''
    };
    if (quality) {
      body.formatId = quality;
      body.quality = quality;
    }

    fetch(`http://localhost:${serverPort}/api/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    }).then(() => {
      setTimeout(() => {
        streamingItems.delete(gid);
        render();
      }, 1400);
    }).catch(() => {
      streamingItems.delete(gid);
      render();
    });
  }

  async function fetchDetectedStreams() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          if (tabs && tabs[0]) {
            chrome.runtime.sendMessage({ type: 'GET_DETECTED_STREAMS', tabId: tabs[0].id }, (response) => {
              if (chrome.runtime.lastError) { resolve([]); return; }
              if (response && response.ok) {
                resolve(response.streams || []);
              } else {
                resolve([]);
              }
            });
          } else {
            resolve([]);
          }
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  function streamCardHTML(streamUrl, index) {
    let cleanName = 'stream.m3u8';
    let hostname = 'unknown';
    try {
      const parsed = new URL(streamUrl);
      const fname = parsed.pathname.split('/').pop() || 'stream.m3u8';
      cleanName = fname.split('?')[0];
      hostname = parsed.hostname;
    } catch (e) {}
    
    const isM3u8 = cleanName.toLowerCase().endsWith('.m3u8');
    const typeLabel = isM3u8 ? 'HLS (M3U8)' : 'DASH (MPD)';

    return `
      <div class="dl-card" style="margin-bottom: 8px;">
        <div class="dl-row-top">
          <div class="dl-name">
            <span class="dl-cat cat-Videos">📺</span>
            <span class="dl-filename" title="${esc(streamUrl)}">${esc(cleanName)}</span>
          </div>
          <span class="dl-pct" style="color: #0a84ff; font-size: 0.75rem;">${typeLabel}</span>
        </div>
        <div class="dl-row-bottom" style="margin-top: 8px; justify-content: space-between; display: flex; align-items: center;">
          <div class="dl-meta" style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            <span class="dl-status-text" title="${esc(streamUrl)}" style="color: #888; font-size: 0.75rem;">${esc(hostname)}</span>
          </div>
          <div class="dl-actions">
            <button class="dl-btn dl-btn--stream" data-stream-action="play" data-url="${esc(streamUrl)}" title="Stream in Player">
              <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </button>
            <button class="dl-btn" data-stream-action="download" data-url="${esc(streamUrl)}" title="Download with DownStream" style="margin-left: 6px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  async function handleDetectedStreamAction(action, url) {
    try {
      const parsed = new URL(url);
      const fname = parsed.pathname.split('/').pop() || 'stream.mp4';
      const cleanName = fname.split('?')[0].replace(/\.(m3u8|mpd)$/i, '.mp4');

      if (action === 'play') {
        await fetch(`http://localhost:${serverPort}/api/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            filename: cleanName,
            category: 'Videos'
          })
        });
      } else if (action === 'download') {
        await fetch(`http://localhost:${serverPort}/api/intercept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            filename: cleanName,
            stream: false
          })
        });
      }
    } catch (err) {
      console.error('Failed to execute stream action:', err);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
