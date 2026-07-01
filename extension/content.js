(function () {
  const FAB_ID = 'downstream-fab';
  const EXCLUDED_PORTS = ['3000', '3999', '8080', '4000'];
  const SPA_DEBOUNCE_MS = 600;
  const INITIAL_DELAY_MS = 1200;
  let currentHref = '';
  let fab = null;
  let observer = null;
  let qualitiesPromise = null;
  let fabDismissed = false;

  function safeSendMessage(message, callback) {
    if (!chrome.runtime?.id) {
      if (callback) callback({ ok: false, error: 'Extension updated. Please refresh the page.' });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (callback) callback({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          if (callback) callback(response);
        }
      });
    } catch (e) {
      if (callback) callback({ ok: false, error: 'Please refresh the page to reload the extension.' });
    }
  }

  const VIDEO_SITES = [
    { test: /youtube\.com\/watch/i,    title: () => document.title.replace(/ - YouTube$/, '') },
    { test: /youtube\.com\/shorts\//i, title: () => document.title.replace(/ - YouTube$/, '') },
    { test: /youtube\.com\/embed\//i,  title: () => document.title.replace(/ - YouTube$/, '') },
    { test: /youtu\.be\//i,           title: () => document.title.replace(/ - YouTube$/, '') },
    { test: /vimeo\.com\/\d+/i,       title: () => document.title.replace(/ on Vimeo$/, '') },
    { test: /dailymotion\.com\/video/i, title: () => document.title.replace(/ - Dailymotion$/, '') },
    { test: /twitch\.tv\/videos/i,    title: () => document.title.replace(/ - Twitch$/, '') },
    { test: /tiktok\.com\/@.*\/video/i, title: () => document.title.replace(/ | TikTok$/, '') },
  ];

  const MEDIA_RE = /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|mp3|flac|wav|aac|ogg|m4a|opus)(\?|#|$)/i;

  function getSiteMatch() {
    const href = location.href;
    for (const site of VIDEO_SITES) {
      if (site.test.test(href)) return site;
    }
    return null;
  }

  function isVideoPage() {
    if (getSiteMatch()) return true;

    const host = location.hostname.toLowerCase();
    const blacklist = [
        'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'reddit.com',
        'linkedin.com', 'pinterest.com', 'tumblr.com',
        'cnn.com', 'bbc.com', 'nytimes.com', 'washingtonpost.com', 'reuters.com'
    ];
    if (blacklist.some(domain => host.includes(domain))) {
        return false;
    }

    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      const viewportArea = window.innerWidth * window.innerHeight;
      if (r.width > 480 && r.height > 360 && area > viewportArea * 0.25) {
        return true;
      }
    }
    return false;
  }

  function isDirectMediaUrl() {
    return MEDIA_RE.test(location.pathname) || MEDIA_RE.test(location.search);
  }

  function getVideoTitle() {
    const site = getSiteMatch();
    if (site) {
      try { return site.title(); } catch { /* fall through */ }
    }

    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content;

    const v = document.querySelector('video[title]');
    if (v?.title) return v.title;

    return document.title || null;
  }

  function injectFAB() {
    if (document.getElementById(FAB_ID)) return;
    if (fabDismissed) return;
    if (!isVideoPage() && !isDirectMediaUrl()) return;

    if (EXCLUDED_PORTS.includes(location.port)) return;
    if (!location.protocol.startsWith('http')) return;

    if (observer) {
      try { observer.disconnect(); } catch (e) {}
      observer = null;
    }

    const title = getVideoTitle() || 'Download this file';
    const isDirect = isDirectMediaUrl();
    const label = isDirect ? 'Download File' : 'Download & Stream';

    if (getSiteMatch()) {
      const urlToFetch = location.href;
      qualitiesPromise = new Promise((resolve, reject) => {
        safeSendMessage({
          type: 'GET_QUALITIES',
          url: urlToFetch
        }, (response) => {
          if (response && response.ok) {
            resolve(response.data);
          } else {
            reject(response?.error || 'Failed to fetch qualities');
          }
        });
      });
      qualitiesPromise.catch(() => {
        qualitiesPromise = null;
      });
    } else {
      qualitiesPromise = null;
    }

    const wrap = document.createElement('div');
    wrap.id = FAB_ID;
    wrap.innerHTML = `
      <div class="ds-fab-card">
        <div class="ds-fab-stripe"></div>
        <div class="ds-fab-body">
          <div class="ds-fab-info">
            ${downloadSvg()}
            <div class="ds-fab-text">
              <span class="ds-fab-label">${esc(label)}</span>
              <span class="ds-fab-title">${esc(trunc(title, 52))}</span>
            </div>
          </div>
          <div class="ds-fab-actions">
            <button class="ds-fab-btn ds-fab-btn--dl" title="Download" aria-label="Download">
              ${downloadSvg()}
            </button>
            <button class="ds-fab-btn ds-fab-btn--stream" title="Download & Stream" aria-label="Stream">
              ${playSvg()}
            </button>
            <button class="ds-fab-btn ds-fab-btn--close" title="Dismiss" aria-label="Dismiss">&times;</button>
          </div>
        </div>
      </div>`;

    wrap.querySelector('.ds-fab-btn--dl').addEventListener('click', () => {
      pauseSiteVideo();
      if (getSiteMatch()) {
        showQualitiesModal();
      } else {
        trigger(false);
      }
    });
    wrap.querySelector('.ds-fab-btn--stream').addEventListener('click', () => {
      pauseSiteVideo();
      const btn = wrap.querySelector('.ds-fab-btn--stream');
      const origHtml = btn.innerHTML;
      btn.innerHTML = spinnerSvg();
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.7';

      trigger(true, () => {
        btn.innerHTML = origHtml;
        btn.style.pointerEvents = 'auto';
        btn.style.opacity = '1';
      });
    });
    wrap.querySelector('.ds-fab-btn--close').addEventListener('click', dismissFAB);

    document.body.appendChild(wrap);
    fab = wrap;

    requestAnimationFrame(() => wrap.classList.add('ds-fab--visible'));
  }

  function destroyFAB() {
    if (!fab) return;
    fab.classList.remove('ds-fab--visible');
    fab.classList.add('ds-fab--exit');
    const el = fab;
    fab = null;
    setTimeout(() => el.remove(), 320);
    startWatching();
  }

  function dismissFAB() {
    fabDismissed = true;
    destroyFAB();
  }

  function pauseSiteVideo() {
    try {
      const videos = document.querySelectorAll('video');
      videos.forEach(video => {
        if (video && !video.paused) {
          video.pause();
        }
      });
    } catch (e) {
      console.warn('Failed to pause page videos:', e);
    }
  }

  function trigger(stream, callback) {
    safeSendMessage({
      type: 'DOWNLOAD',
      url: location.href,
      filename: getVideoTitle() || undefined,
      pageUrl: location.href,
      referrer: location.href,
      stream,
    }, (response) => {
      if (callback) callback(response);
    });
  }

  function showQualitiesModal() {
    if (document.getElementById('downstream-modal-overlay')) return;

    const title = getVideoTitle() || 'Video';

    const overlay = document.createElement('div');
    overlay.id = 'downstream-modal-overlay';
    overlay.innerHTML = `
      <div id="downstream-modal">
        <div class="ds-modal-header">
          <span class="ds-modal-title">Choose Quality (Download or Stream)</span>
          <button class="ds-modal-close" id="ds-modal-close-btn">&times;</button>
        </div>
        <div class="ds-modal-body" id="ds-modal-body-content">
          <div class="ds-video-info">
            <span class="ds-video-title">${esc(title)}</span>
          </div>
          <div class="ds-loading-container">
            <div class="ds-spinner"></div>
            <span class="ds-loading-text">Fetching available qualities...</span>
          </div>
        </div>
        <div class="ds-modal-footer">
          <button class="ds-modal-btn ds-modal-btn--cancel" id="ds-modal-cancel-btn">Cancel</button>
          <button class="ds-modal-btn ds-modal-btn--stream" id="ds-modal-stream-btn" disabled>Watch / Stream</button>
          <button class="ds-modal-btn ds-modal-btn--dl" id="ds-modal-dl-btn" disabled>Download</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('ds-modal--visible'));

    const closeModal = () => {
      overlay.classList.remove('ds-modal--visible');
      setTimeout(() => overlay.remove(), 300);
    };

    overlay.querySelector('#ds-modal-close-btn').addEventListener('click', closeModal);
    overlay.querySelector('#ds-modal-cancel-btn').addEventListener('click', closeModal);

    // Focus trap: keep Tab inside the modal, Escape to close
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = overlay.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    if (!qualitiesPromise) {
      const urlToFetch = location.href;
      qualitiesPromise = new Promise((resolve, reject) => {
        safeSendMessage({
          type: 'GET_QUALITIES',
          url: urlToFetch
        }, (response) => {
          if (response && response.ok) {
            resolve(response.data);
          } else {
            reject(response?.error || 'Failed to fetch qualities');
          }
        });
      });
    }

    qualitiesPromise.then((data) => {
      if (!overlay.parentNode) return;
      const bodyContent = overlay.querySelector('#ds-modal-body-content');
      
      const { formats } = data;
      const { progressive = [], videoOnly = [], audioOnly = [] } = formats || {};

      const combinedVideo = [];
      progressive.forEach(f => {
        combinedVideo.push({ ...f, isSplit: false });
      });
      videoOnly.forEach(f => {
        combinedVideo.push({ ...f, isSplit: true });
      });

      combinedVideo.sort((a, b) => {
        if (b.height !== a.height) {
          return b.height - a.height;
        }
        if (a.isSplit !== b.isSplit) {
          return a.isSplit ? 1 : -1;
        }
        if (a.ext === 'mp4' && b.ext !== 'mp4') return -1;
        if (b.ext === 'mp4' && a.ext !== 'mp4') return 1;
        return 0;
      });

      const seenHeightExt = new Set();
      const uniqueCombinedVideo = [];
      for (const f of combinedVideo) {
        const key = `${f.height}|${f.ext}`;
        if (!seenHeightExt.has(key)) {
          seenHeightExt.add(key);
          uniqueCombinedVideo.push(f);
        }
      }

      bodyContent.innerHTML = `
        <div class="ds-video-info">
          <span class="ds-video-title" style="font-weight: 600;">${esc(data.title || title)}</span>
        </div>
        <div class="ds-modal-tabs">
          <button class="ds-modal-tab-btn ds-tab-btn--active" data-tab="progressive">Video</button>
          <button class="ds-modal-tab-btn" data-tab="videoOnly">Video Only</button>
          <button class="ds-modal-tab-btn" data-tab="audioOnly">Audio Only</button>
        </div>
        
        <div class="ds-tab-pane ds-tab-pane--active" id="pane-progressive">
          ${renderFormatsList(uniqueCombinedVideo, 'progressive')}
        </div>
        <div class="ds-tab-pane" id="pane-videoOnly">
          ${renderFormatsList(videoOnly.map(f => ({ ...f, isSplit: false })), 'videoOnly')}
        </div>
        <div class="ds-tab-pane" id="pane-audioOnly">
          ${renderFormatsList(audioOnly.map(f => ({ ...f, isSplit: false })), 'audioOnly')}
        </div>
      `;

      let activeTab = 'progressive';
      const tabs = overlay.querySelectorAll('.ds-modal-tab-btn');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('ds-tab-btn--active'));
          overlay.querySelectorAll('.ds-tab-pane').forEach(p => p.classList.remove('ds-tab-pane--active'));
          
          tab.classList.add('ds-tab-btn--active');
          activeTab = tab.dataset.tab;
          const targetPane = overlay.querySelector(`#pane-${activeTab}`);
          if (targetPane) targetPane.classList.add('ds-tab-pane--active');
        });
      });

      const dlBtn = overlay.querySelector('#ds-modal-dl-btn');
      const streamBtn = overlay.querySelector('#ds-modal-stream-btn');
      let selectedFormat = null;

      const options = overlay.querySelectorAll('.ds-format-option');
      options.forEach(opt => {
        opt.addEventListener('click', () => {
          options.forEach(o => o.classList.remove('ds-format--selected'));
          opt.classList.add('ds-format--selected');
          
          const radio = opt.querySelector('.ds-radio-input');
          if (radio) radio.checked = true;

          selectedFormat = {
            formatId: opt.dataset.formatId,
            ext: opt.dataset.ext,
            isSplit: opt.dataset.isSplit === 'true'
          };
          dlBtn.disabled = false;
          if (streamBtn) streamBtn.disabled = false;
        });
      });

      dlBtn.addEventListener('click', () => {
        if (!selectedFormat) return;
        
        pauseSiteVideo();

        safeSendMessage({
          type: 'DOWNLOAD',
          url: location.href,
          filename: data.title || title,
          pageUrl: location.href,
          referrer: location.href,
          stream: false,
          formatId: selectedFormat.formatId,
          formatExt: selectedFormat.ext,
          isSplit: selectedFormat.isSplit
        });

        const origText = dlBtn.textContent;
        const origTextStream = streamBtn ? streamBtn.textContent : '';
        dlBtn.textContent = '✓ Sent!';
        dlBtn.disabled = true;
        if (streamBtn) streamBtn.disabled = true;
        setTimeout(() => {
          dlBtn.textContent = origText;
          dlBtn.disabled = false;
          if (streamBtn) {
            streamBtn.textContent = origTextStream;
            streamBtn.disabled = false;
          }
        }, 1500);
      });

      if (streamBtn) {
        streamBtn.addEventListener('click', () => {
          if (!selectedFormat) return;
          
          pauseSiteVideo();
          
          const origText = streamBtn.textContent;
          streamBtn.textContent = 'Resolving...';
          streamBtn.disabled = true;
          dlBtn.disabled = true;

          safeSendMessage({
            type: 'DOWNLOAD',
            url: location.href,
            filename: data.title || title,
            pageUrl: location.href,
            referrer: location.href,
            stream: true,
            formatId: selectedFormat.formatId,
            formatExt: selectedFormat.ext,
            isSplit: selectedFormat.isSplit
          }, (response) => {
            if (response && response.ok) {
              streamBtn.textContent = '✓ Streaming!';
              setTimeout(() => {
                streamBtn.textContent = origText;
                streamBtn.disabled = false;
                dlBtn.disabled = false;
              }, 2000);
            } else {
              streamBtn.textContent = 'Failed';
              setTimeout(() => {
                streamBtn.textContent = origText;
                streamBtn.disabled = false;
                dlBtn.disabled = false;
              }, 1500);
            }
          });
        });
      }

    }).catch((err) => {
      qualitiesPromise = null;
      if (!overlay.parentNode) return;
      const bodyContent = overlay.querySelector('#ds-modal-body-content');
      bodyContent.innerHTML = `
        <div class="ds-video-info">
          <span class="ds-video-title">${esc(title)}</span>
        </div>
        <div class="ds-no-formats" style="color: #ef4444; font-weight: 500; text-align: center; padding: 20px 0;">
          ${esc(err)}
        </div>
      `;
    });
  }

  function renderFormatsList(formats, type) {
    if (!formats || formats.length === 0) {
      let emptyMsg = 'No combined video formats found.';
      if (type === 'videoOnly') emptyMsg = 'No video-only formats found.';
      if (type === 'audioOnly') emptyMsg = 'No audio-only formats found.';
      return `<span class="ds-no-formats">${emptyMsg}</span>`;
    }

    return formats.map(f => {
      const formatDetailsLabel = type === 'audioOnly' 
        ? `${f.ext.toUpperCase()} Audio` 
        : `${f.resolution} (${f.fps ? f.fps + ' fps' : 'standard'})`;

      return `
        <div class="ds-format-option" data-format-id="${esc(f.formatId)}" data-ext="${esc(f.ext)}" data-is-split="${f.isSplit ? 'true' : 'false'}">
          <input type="radio" name="ds-format" class="ds-radio-input">
          <div class="ds-format-details">
            <div class="ds-format-row">
              <span class="ds-format-res">${esc(formatDetailsLabel)}</span>
              <span class="ds-format-ext">${esc(f.ext)}</span>
            </div>
            <div class="ds-format-row" style="margin-top: 2px;">
              <span class="ds-format-size">${esc(f.filesizeStr)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function downloadSvg() {
    return `<svg class="ds-fab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 17h12"/></svg>`;
  }

  function playSvg() {
    return `<svg class="ds-fab-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.5v11l9-5.5z"/></svg>`;
  }

  function spinnerSvg() {
    return `<svg class="ds-fab-icon ds-spinner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: ds-fab-spin 1s linear infinite;">
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)"/>
      <path d="M12 2a10 10 0 0 1 10 10"/>
    </svg>`;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

  function check() {
    if (location.href !== currentHref) {
      currentHref = location.href;
      fabDismissed = false;
      destroyFAB();
      qualitiesPromise = null;
      setTimeout(injectFAB, INITIAL_DELAY_MS);
    } else {
      if (!document.getElementById(FAB_ID) && isVideoPage()) {
        injectFAB();
      }
    }
  }

  let popstateHandler = null;

  function startWatching() {
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
      observer = null;
    }
    let timer = null;
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(check, SPA_DEBOUNCE_MS);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (popstateHandler) {
      window.removeEventListener('popstate', popstateHandler);
    }
    popstateHandler = () => setTimeout(check, 300);
    window.addEventListener('popstate', popstateHandler);
  }

  const knownExtensions = [
      'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg',
      'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac',
      'zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz', 'iso', 'img', 'cab', 'z', 'jar',
      'dmg', 'pkg', 'bin', 'exe', 'msi', 'apk', 'app',
      'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'torrent'
  ];

  function getExt(href) {
      let path = href || '';
      try {
          path = new URL(href).pathname;
      } catch (e) {
          path = (href || '').split('?')[0].split('#')[0];
      }
      const segment = path.split('/').pop() || '';
      const dot = segment.lastIndexOf('.');
      return dot > -1 ? segment.slice(dot + 1).toLowerCase() : '';
  }

  function isDownloadAnchor(anchor, href) {
      if (anchor.hasAttribute('download')) return true;
      if (knownExtensions.includes(getExt(href))) return true;
      return false;
  }

  const videoExtensions = [
      'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg',
      'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac'
  ];

  const clickInterceptExtensions = [
      'zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz', 'iso', 'img', 'cab', 'z', 'jar',
      'dmg', 'pkg', 'bin', 'exe', 'msi', 'apk', 'app',
      'torrent'
  ];

  function isClickInterceptAnchor(anchor, href) {
      if (anchor.hasAttribute('data-ds-bypass')) return false;
      if (anchor.hasAttribute('download')) return true;
      const ext = getExt(href);
      if (clickInterceptExtensions.includes(ext)) return true;
      if (videoExtensions.includes(ext)) {
          // Don't intercept if the anchor is inside a video player container
          // (e.g., video.js, Plyr, or custom players that handle .mp4 clicks)
          if (anchor.closest('video, .video-js, .plyr, .jw-video, [data-plyr], .html5-video-container')) return false;
          // Don't intercept if there's a video element on the page that might be using this URL
          const videos = document.querySelectorAll('video');
          for (const v of videos) {
              if (v.src === href || v.currentSrc === href) return false;
          }
          return true;
      }
      return false;
  }

  function showDirectMediaModal(href, filename) {
    if (document.getElementById('downstream-modal-overlay')) return;

    const title = filename || getExt(href).toUpperCase() + ' Media';

    const overlay = document.createElement('div');
    overlay.id = 'downstream-modal-overlay';
    overlay.innerHTML = `
      <div id="downstream-modal">
        <div class="ds-modal-header">
          <span class="ds-modal-title">DownStream Intercept</span>
          <button class="ds-modal-close" id="ds-modal-close-btn">&times;</button>
        </div>
        <div class="ds-modal-body">
          <div class="ds-video-info">
            <span class="ds-video-title" style="font-weight: 600;">${esc(title)}</span>
          </div>
          <div style="padding: 20px 0; text-align: center; color: #e1e1e1;">
            Do you want to download this media file or stream it directly to your media player?
          </div>
        </div>
        <div class="ds-modal-footer">
          <button class="ds-modal-btn ds-modal-btn--cancel" id="ds-modal-cancel-btn">Cancel</button>
          <button class="ds-modal-btn ds-modal-btn--schedule" id="ds-modal-schedule-btn">Schedule</button>
          <button class="ds-modal-btn ds-modal-btn--stream" id="ds-modal-stream-btn">Watch / Stream</button>
          <button class="ds-modal-btn ds-modal-btn--dl" id="ds-modal-dl-btn">Download</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('ds-modal--visible'));

    const closeModal = () => {
      overlay.classList.remove('ds-modal--visible');
      setTimeout(() => overlay.remove(), 300);
    };

    overlay.querySelector('#ds-modal-close-btn').addEventListener('click', closeModal);
    overlay.querySelector('#ds-modal-cancel-btn').addEventListener('click', closeModal);

    // Focus trap: keep Tab inside the modal, Escape to close
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = overlay.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    overlay.querySelector('#ds-modal-dl-btn').addEventListener('click', () => {
      closeModal();
      safeSendMessage({
        type: 'DOWNLOAD',
        url: href,
        filename: filename,
        referrer: location.href,
        stream: false
      });
      showToast('Sending download to DownStream...');
    });

    overlay.querySelector('#ds-modal-stream-btn').addEventListener('click', () => {
      closeModal();
      pauseSiteVideo();
      safeSendMessage({
        type: 'DOWNLOAD',
        url: href,
        filename: filename,
        referrer: location.href,
        stream: true
      });
      showToast('Streaming media...');
    });

    overlay.querySelector('#ds-modal-schedule-btn').addEventListener('click', () => {
      // Remove current modal immediately (skip animation) so schedule picker can open
      overlay.remove();
      showSchedulePicker(href, filename);
    });
  }

  function showSchedulePicker(url, filename) {
    if (document.getElementById('downstream-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'downstream-modal-overlay';
    overlay.innerHTML = `
      <div id="downstream-modal">
        <div class="ds-modal-header">
          <span class="ds-modal-title">Schedule Download</span>
          <button class="ds-modal-close" id="ds-modal-close-btn">&times;</button>
        </div>
        <div class="ds-modal-body">
          <div class="ds-video-info">
            <span class="ds-video-title" style="font-weight: 600;">${esc(filename || url)}</span>
          </div>
          <div style="padding: 12px 0;">
            <label style="font-size: 13px; color: #e1e1e1; display: block; margin-bottom: 8px;">Download at:</label>
            <input type="datetime-local" id="ds-schedule-time"
              style="width: 100%; background: rgba(255,255,255,0.05); color: #f0ece4; border: 1px solid rgba(255,255,255,0.1);
              border-radius: 8px; padding: 10px 12px; font-size: 14px; font-family: inherit; box-sizing: border-box;">
          </div>
        </div>
        <div class="ds-modal-footer">
          <button class="ds-modal-btn ds-modal-btn--cancel" id="ds-modal-cancel-btn">Cancel</button>
          <button class="ds-modal-btn ds-modal-btn--dl" id="ds-modal-confirm-schedule">Schedule</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('ds-modal--visible'));

    function getLocalDateTimeString(date) {
      const pad = (num) => String(num).padStart(2, '0');
      const year = date.getFullYear();
      const month = pad(date.getMonth() + 1);
      const day = pad(date.getDate());
      const hours = pad(date.getHours());
      const minutes = pad(date.getMinutes());
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    }

    // Default to 1 hour from now
    const timeInput = overlay.querySelector('#ds-schedule-time');
    const defaultTime = new Date(Date.now() + 3600000);
    timeInput.value = getLocalDateTimeString(defaultTime);
    timeInput.min = getLocalDateTimeString(new Date());

    const closeModal = () => {
      overlay.classList.remove('ds-modal--visible');
      setTimeout(() => overlay.remove(), 300);
    };

    overlay.querySelector('#ds-modal-close-btn').addEventListener('click', closeModal);
    overlay.querySelector('#ds-modal-cancel-btn').addEventListener('click', closeModal);

    overlay.querySelector('#ds-modal-confirm-schedule').addEventListener('click', () => {
      const scheduledTime = new Date(timeInput.value).getTime();
      if (isNaN(scheduledTime) || scheduledTime <= Date.now()) {
        showToast('Please select a future time');
        return;
      }
      safeSendMessage({
        type: 'SCHEDULE',
        url: url,
        filename: filename,
        referrer: location.href,
        scheduledTime: scheduledTime
      });
      closeModal();
      showToast('Download scheduled!');
    });

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); return; }
    });
  }

  document.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      if (!chrome.runtime?.id) return;

      const anchor = e.target.closest('a[href]');
      if (!anchor) return;

      const href = anchor.href;
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      try {
          const parsed = new URL(href);
          if (EXCLUDED_PORTS.includes(parsed.port) || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return;
      } catch (err) {
          return;
      }

      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (anchor.target === '_blank') return;

      if (!isClickInterceptAnchor(anchor, href)) return;

      e.preventDefault();

      const filename = anchor.getAttribute('download') || '';
      const ext = getExt(href);

      if (videoExtensions.includes(ext)) {
          showDirectMediaModal(href, filename);
      } else {
          safeSendMessage({
              type: 'DOWNLOAD',
              url: href,
              filename: filename,
              referrer: location.href
          }, (response) => {
              if (!response || !response.ok) {
                  console.warn('[Aria2] Extension failed to intercept click, falling back to browser:', response?.error);
                  const clone = anchor.cloneNode(true);
                  clone.setAttribute('data-ds-bypass', 'true');
                  clone.style.display = 'none';
                  document.body.appendChild(clone);
                  clone.click();
                  clone.remove();
              } else {
                  showToast('Sending download to DownStream...');
              }
          });
      }
  });

  function showToast(message) {
      let toast = document.getElementById('downstream-toast');
      if (!toast) {
          toast = document.createElement('div');
          toast.id = 'downstream-toast';
          Object.assign(toast.style, {
              position: 'fixed',
              bottom: '24px',
              right: '24px',
              background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
              color: '#e1e1e1',
              border: '1px solid #0a84ff',
              padding: '12px 20px',
              borderRadius: '10px',
              boxShadow: '0 4px 24px rgba(10,132,255,0.3)',
              zIndex: '2147483647',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              fontSize: '0.85rem',
              fontWeight: '500',
              transition: 'opacity 0.3s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
          });
          document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.style.opacity = '1';
      clearTimeout(toast._timeout);
      toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
  }

  function boot() {
    if (!location.protocol.startsWith('http')) return;
    if (EXCLUDED_PORTS.includes(location.port)) return;

    currentHref = location.href;
    setTimeout(injectFAB, INITIAL_DELAY_MS);
    startWatching();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
