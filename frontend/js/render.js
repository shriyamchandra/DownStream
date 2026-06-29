import { state } from './state.js';
import { STREAM_BUFFER_THRESHOLD } from './shared-constants.js';
import {
    escapeHtml, formatBytes, formatTime, getFileName, isVideoFile,
    getStatusClass, getStatusText, getFileIconClass, getFileIconText,
    iconPause, iconPlay, iconCancel, iconTrash, iconRestart, iconFolder
} from './format.js';

// Update a navbar count badge.
export function updateBadge(id, count) {
    const badge = document.getElementById(id);
    if (!badge) return;
    if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// Build the expanded-row detail panel (files, peers, error, metadata).
export function getDetailsHtml(d) {
    const addedStr = d.addedDate ? new Date(d.addedDate).toLocaleString() : 'Unknown';
    const completedStr = d.completedDate ? new Date(d.completedDate).toLocaleString() : '';

    let filesHtml = '';
    if (d.files && d.files.length > 0) {
        const showFileList = d.files.length > 1 || d.bittorrent;
        if (showFileList) {
            filesHtml += `
                <div class="details-section files-list-section">
                    <h4>Files in Download (${d.files.length})</h4>
                    <div class="details-files-container">
            `;
            d.files.forEach((f, idx) => {
                const fLength = parseInt(f.length) || 0;
                const fCompleted = parseInt(f.completedLength) || 0;
                const fPct = fLength === 0 ? 0 : Math.floor((fCompleted / fLength) * 100);
                let fPath = f.path || 'Pending...';
                if (f.path && d.dir) {
                    if (f.path.startsWith(d.dir)) {
                        fPath = f.path.slice(d.dir.length).replace(/^[/\\]+/, '');
                    } else {
                        fPath = f.path.split('/').pop();
                    }
                }
                filesHtml += `
                    <div class="details-file-row">
                        <div class="file-row-info">
                            <span class="file-row-index">${idx + 1}</span>
                            <span class="file-row-name" title="${escapeHtml(fPath)}">${escapeHtml(fPath)}</span>
                            <span class="file-row-size">${formatBytes(fCompleted)} / ${formatBytes(fLength)}</span>
                        </div>
                        <div class="file-row-progress-container">
                            <div class="file-row-progress-bar" style="width: ${fPct}%"></div>
                        </div>
                    </div>
                `;
            });
            filesHtml += `
                    </div>
                </div>
            `;
        }
    }

    let metaStatsHtml = '';
    if (d.status === 'active') {
        const conns = d.connections || 0;
        const seeders = d.numSeeders !== undefined ? ` · Seeds: ${d.numSeeders}` : '';
        const upload = parseInt(d.uploadSpeed) || 0;
        metaStatsHtml = `
            <div class="detail-meta-item">
                <strong>Connections:</strong> <span>${conns}${seeders}</span>
            </div>
            <div class="detail-meta-item">
                <strong>Upload Speed:</strong> <span>${formatBytes(upload)}/s</span>
            </div>
        `;
    }

    let errorBlock = '';
    if (d.status === 'error' && d.errorMessage) {
        errorBlock = `
            <div class="details-error-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                <span><strong>Error Details:</strong> ${escapeHtml(d.errorMessage)}</span>
            </div>
        `;
    }

    const downloadDirDisplay = d.dir || state.appConfig.downloadDir || 'Default';
    const sourceUrl = (d.urls && d.urls.length > 0) ? d.urls[0] : 'Magnet / Torrent file';

    return `
        <div class="row-details">
            ${errorBlock}
            <div class="details-grid">
                <div class="detail-meta-item full-width">
                    <strong>Source URL:</strong> <span class="url-text" title="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</span>
                </div>
                <div class="detail-meta-item full-width">
                    <strong>Save Path:</strong> <span class="path-text" title="${escapeHtml(downloadDirDisplay)}">${escapeHtml(downloadDirDisplay)}</span>
                </div>
                <div class="detail-meta-item">
                    <strong>Date Added:</strong> <span>${addedStr}</span>
                </div>
                ${completedStr ? `
                <div class="detail-meta-item">
                    <strong>Date Completed:</strong> <span>${completedStr}</span>
                </div>
                ` : ''}
                ${metaStatsHtml}
            </div>
            ${filesHtml}
        </div>
    `;
}

// Build the action-button cluster for a download row.
function actionsHtml(d, canStream, canShowInFinder) {
    return `
        ${d.status === 'active' ? `<button class="btn-icon-small" data-action="pause" data-gid="${d.gid}" title="Pause">${iconPause}</button>` : ''}
        ${d.status === 'paused' ? `<button class="btn-icon-small" data-action="resume" data-gid="${d.gid}" title="Resume">${iconPlay}</button>` : ''}
        ${(d.status === 'active' || d.status === 'paused' || d.status === 'merging') ? `<button class="btn-icon-small" data-action="delete" data-gid="${d.gid}" data-historical="false" title="Cancel">${iconCancel}</button>` : ''}
        ${(d.status === 'complete' || d.status === 'error' || d.status === 'removed') ? `<button class="btn-icon-small" data-action="delete" data-gid="${d.gid}" data-historical="true" title="Delete">${iconTrash}</button>` : ''}
        ${(d.status === 'error' || d.status === 'removed') ? `<button class="btn-icon-small" style="color:var(--warning);" data-action="restart" data-gid="${d.gid}" title="Retry">${iconRestart}</button>` : ''}
        ${canShowInFinder ? `<button class="btn-icon-small" data-action="show-in-finder" data-gid="${d.gid}" title="Show in Finder">${iconFolder}</button>` : ''}
        ${canStream ? `<button class="btn-stream" data-action="stream" data-gid="${d.gid}">▶ Stream</button>` : ''}
    `;
}

// Apply the sidebar filter, search, and sort to the download list.
function getFilteredDownloads() {
    let list = state.downloads;

    if (state.currentFilter === 'active') {
        list = list.filter(d => d.status === 'active' || d.status === 'waiting' || d.status === 'paused' || d.status === 'merging');
    } else if (state.currentFilter === 'complete') {
        list = list.filter(d => d.status === 'complete');
    } else if (state.currentFilter === 'failed') {
        list = list.filter(d => d.status === 'error' || d.status === 'removed');
    }

    const searchVal = document.getElementById('searchBar').value.toLowerCase().trim();
    if (searchVal) {
        list = list.filter(d => {
            const filename = getFileName(d).toLowerCase();
            const urls = (d.urls || []).join(' ').toLowerCase();
            return filename.includes(searchVal) || urls.includes(searchVal);
        });
    }

    const sortVal = document.getElementById('sortSelect').value;
    if (sortVal === 'date-desc') {
        list.sort((a, b) => new Date(b.addedDate || Date.now()) - new Date(a.addedDate || Date.now()));
    } else if (sortVal === 'date-asc') {
        list.sort((a, b) => new Date(a.addedDate || Date.now()) - new Date(b.addedDate || Date.now()));
    } else if (sortVal === 'name-asc') {
        list.sort((a, b) => getFileName(a).localeCompare(getFileName(b)));
    } else if (sortVal === 'name-desc') {
        list.sort((a, b) => getFileName(b).localeCompare(getFileName(a)));
    } else if (sortVal === 'size-desc') {
        list.sort((a, b) => (parseInt(b.totalLength) || 0) - (parseInt(a.totalLength) || 0));
    } else if (sortVal === 'size-asc') {
        list.sort((a, b) => (parseInt(a.totalLength) || 0) - (parseInt(b.totalLength) || 0));
    }

    return list;
}

export function renderDownloads() {
    const list = document.getElementById('downloadsList');
    if (!list) return;

    const filteredDownloads = getFilteredDownloads();

    if (filteredDownloads.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📂</div>
                <h3>No Downloads Found</h3>
                <p>Try pasting a URL above or adjust your search filters.</p>
            </div>
        `;
        list.dataset.gidOrder = '';
        return;
    }

    const currentGidString = filteredDownloads.map(d => d.gid).join(',');
    const oldGidString = list.dataset.gidOrder || '';

    if (currentGidString !== oldGidString) {
        // Full re-render when the set/order of rows changed.
        let html = '';
        filteredDownloads.forEach(d => {
            const total = parseInt(d.totalLength) || 0;
            const completed = parseInt(d.completedLength) || 0;
            const speed = parseInt(d.downloadSpeed) || 0;
            const pct = total === 0 ? 0 : Math.floor((completed / total) * 100);
            const etaSeconds = speed === 0 ? 0 : Math.floor((total - completed) / speed);

            const filename = getFileName(d);
            const canStream = (d.status === 'complete' || completed > STREAM_BUFFER_THRESHOLD) && isVideoFile(filename);
            const canShowInFinder = d.status === 'complete' || (completed > 0 && d.files && d.files.length > 0);
            const showSpeed = d.status === 'active';
            const speedInner = showSpeed ? `Speed: ${formatBytes(speed)}/s <span class="eta">· ETA ${formatTime(etaSeconds)}</span>` : '';

            const isExpanded = state.expandedGids.has(d.gid);
            const detailsHtml = isExpanded ? getDetailsHtml(d) : '';

            html += `
                <div class="download-row ${isExpanded ? 'expanded' : ''}" id="dl-${d.gid}" data-action="toggle-expand" data-gid="${d.gid}">
                    <div class="row-top">
                        <div class="file-icon ${getFileIconClass(filename)}">
                            ${getFileIconText(filename)}
                        </div>
                        <div class="file-info">
                            <div class="row-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
                            <div class="row-meta">
                                <span class="row-size">${formatBytes(completed)} / ${total > 0 ? formatBytes(total) : '??'}</span>
                                <span class="status-badge ${getStatusClass(d.status)}">${getStatusText(d.status, d.phase)}</span>
                                <span class="row-speed"${showSpeed ? '' : ' hidden'}>${speedInner}</span>
                            </div>
                        </div>
                        <div class="row-actions" data-status="${d.status}" data-streamable="${canStream ? '1' : '0'}">
                            ${actionsHtml(d, canStream, canShowInFinder)}
                        </div>
                    </div>
                    <div class="row-progress-container">
                        <div class="row-progress-bar ${d.status === 'merging' ? 'merging' : ''}" style="width:${d.status === 'merging' ? 100 : pct}%"></div>
                    </div>
                    ${detailsHtml}
                </div>
            `;
        });
        list.innerHTML = html;
        list.dataset.gidOrder = currentGidString;
    } else {
        // Fast in-place updates when only values changed.
        filteredDownloads.forEach(d => {
            const row = document.getElementById(`dl-${d.gid}`);
            if (!row) return;

            const total = parseInt(d.totalLength) || 0;
            const completed = parseInt(d.completedLength) || 0;
            const speed = parseInt(d.downloadSpeed) || 0;
            const pct = total === 0 ? 0 : Math.floor((completed / total) * 100);
            const etaSeconds = speed === 0 ? 0 : Math.floor((total - completed) / speed);

            const filename = getFileName(d);
            const canStream = (d.status === 'complete' || completed > 200000) && isVideoFile(filename);
            const canShowInFinder = d.status === 'complete' || (completed > 0 && d.files && d.files.length > 0);
            const showSpeed = d.status === 'active';
            const speedInner = showSpeed ? `Speed: ${formatBytes(speed)}/s <span class="eta">· ETA ${formatTime(etaSeconds)}</span>` : '';

            const bar = row.querySelector('.row-progress-bar');
            if (bar) {
                bar.style.width = (d.status === 'merging' ? 100 : pct) + '%';
                if (d.status === 'merging') {
                    bar.classList.add('merging');
                } else {
                    bar.classList.remove('merging');
                }
            }

            const sizeSpan = row.querySelector('.row-size');
            if (sizeSpan) sizeSpan.innerText = `${formatBytes(completed)} / ${total > 0 ? formatBytes(total) : '??'}`;

            const badge = row.querySelector('.status-badge');
            if (badge) {
                badge.className = `status-badge ${getStatusClass(d.status)}`;
                badge.innerText = getStatusText(d.status, d.phase);
            }

            const speedSpan = row.querySelector('.row-speed');
            if (speedSpan) {
                speedSpan.hidden = !showSpeed;
                speedSpan.innerHTML = speedInner;
            }

            // Rebuild actions when status or streamability changes.
            const actionsContainer = row.querySelector('.row-actions');
            const streamableFlag = canStream ? '1' : '0';
            if (actionsContainer && (actionsContainer.dataset.status !== d.status || actionsContainer.dataset.streamable !== streamableFlag)) {
                actionsContainer.innerHTML = actionsHtml(d, canStream, canShowInFinder);
                actionsContainer.dataset.status = d.status;
                actionsContainer.dataset.streamable = streamableFlag;
            }

            // Expanded/collapsed details.
            const isExpanded = state.expandedGids.has(d.gid);
            const detailsContainer = row.querySelector('.row-details');

            if (isExpanded) {
                if (!row.classList.contains('expanded')) row.classList.add('expanded');
                if (!detailsContainer) {
                    row.insertAdjacentHTML('beforeend', getDetailsHtml(d));
                } else {
                    // Update in place to avoid re-triggering the entrance animation.
                    if (d.status === 'active') {
                        const conns = d.connections || 0;
                        const seeders = d.numSeeders !== undefined ? ` · Seeds: ${d.numSeeders}` : '';
                        const upload = parseInt(d.uploadSpeed) || 0;
                        const metaGrid = detailsContainer.querySelector('.details-grid');
                        if (metaGrid) {
                            metaGrid.querySelectorAll('.detail-meta-item').forEach(item => {
                                const header = item.querySelector('strong');
                                const valueSpan = item.querySelector('span');
                                if (header && valueSpan) {
                                    const headerText = header.innerText.toUpperCase();
                                    if (headerText.includes('CONNECTIONS')) {
                                        valueSpan.innerText = `${conns}${seeders}`;
                                    } else if (headerText.includes('UPLOAD SPEED')) {
                                        valueSpan.innerText = `${formatBytes(upload)}/s`;
                                    }
                                }
                            });
                        }
                    }

                    if (d.files && d.files.length > 0) {
                        d.files.forEach((f, idx) => {
                            const fLength = parseInt(f.length) || 0;
                            const fCompleted = parseInt(f.completedLength) || 0;
                            const fPct = fLength === 0 ? 0 : Math.floor((fCompleted / fLength) * 100);
                            const fileRow = detailsContainer.querySelector(`.details-file-row:nth-child(${idx + 1})`);
                            if (fileRow) {
                                const fileBar = fileRow.querySelector('.file-row-progress-bar');
                                if (fileBar) fileBar.style.width = fPct + '%';
                                const fileSize = fileRow.querySelector('.file-row-size');
                                if (fileSize) fileSize.innerText = `${formatBytes(fCompleted)} / ${formatBytes(fLength)}`;
                            }
                        });
                    }
                }
            } else {
                if (row.classList.contains('expanded')) row.classList.remove('expanded');
                if (detailsContainer) detailsContainer.remove();
            }
        });
    }
}
