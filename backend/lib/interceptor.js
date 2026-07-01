const path = require('path');
const fs = require('fs');
const { resolveStreamUrls } = require('./ytDlpUtils');
const { launchPlayer, isUrlExpired, USER_AGENT } = require('./playerLauncher');

module.exports = function createInterceptor({
    config,
    rpc,
    history,
    notifier,
    events,
    streamUrlCache,
    startYoutubeDownload,
    getAriaReady,
    queuePendingIntercept
}) {
    const activeStreamResolutions = new Map();

    const isVideoPageUrl = (urlStr) => {
        try {
            const parsed = new URL(urlStr);
            const host = parsed.hostname.toLowerCase();
            const pathName = parsed.pathname;
            
            const ext = pathName.split('.').pop().toLowerCase();
            if (['mp4', 'mkv', 'webm', 'avi', 'mov', 'mp3', 'm4a', 'aac', 'flac'].includes(ext)) {
                return false;
            }
            
            if (host.includes('youtube.com')) {
                if (pathName === '/watch' && parsed.searchParams.has('v')) {
                    return true;
                }
                if (pathName.startsWith('/shorts/') || pathName.startsWith('/embed/')) {
                    return true;
                }
                return false;
            }
            if (host.includes('youtu.be')) {
                return pathName.length > 1;
            }
            if (host.includes('vimeo.com')) {
                return /^\/\d+$/.test(pathName) || /\/videos?\/\d+$/.test(pathName);
            }
            if (host.includes('dailymotion.com')) {
                return pathName.startsWith('/video/');
            }
            if (host.includes('twitch.tv')) {
                if (pathName.startsWith('/videos/')) return true;
                const segments = pathName.split('/').filter(Boolean);
                if (segments.length === 1) {
                    const blacklisted = ['directory', 'search', 'p', 'downloads', 'jobs', 'press', 'store'];
                    return !blacklisted.includes(segments[0].toLowerCase());
                }
                return false;
            }
            if (host.includes('tiktok.com')) {
                return /\/video\/\d+/.test(pathName);
            }
        } catch (e) {}
        return false;
    };

    const isStreamPlaylistUrl = (urlStr) => {
        try {
            const parsed = new URL(urlStr);
            const pathName = parsed.pathname.toLowerCase();
            return pathName.endsWith('.m3u8') || pathName.endsWith('.mpd') ||
                   urlStr.includes('.m3u8?') || urlStr.includes('.mpd?');
        } catch (e) {}
        return false;
    };

    const isDirectMediaUrl = (urlStr) => {
        try {
            const parsed = new URL(urlStr);
            const ext = parsed.pathname.split('.').pop().toLowerCase();
            const mediaExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts',
                               'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac'];
            return mediaExts.includes(ext);
        } catch (e) {}
        return false;
    };

    return async function handleIntercept(data = {}) {
        const { url, filename, referrer, userAgent, cookies, formatId, formatExt } = data;
        if (!url) throw new Error('URL is required');

        const isStream = data.stream === true || data.stream === 'true' || data.stream === '1';

        if (isVideoPageUrl(url) || isStreamPlaylistUrl(url)) {
            const chosenExt = formatExt || 'mp4';
            let cleanFilename = filename || 'video';
            cleanFilename = cleanFilename.replace(/\\/g, '/');
            cleanFilename = path.basename(cleanFilename);
            if (cleanFilename === '.' || cleanFilename === '..' || !cleanFilename) {
                cleanFilename = 'video';
            }
            
            const extname = path.extname(cleanFilename).toLowerCase();
            if (extname === '.m3u8' || extname === '.mpd') {
                const targetExt = `.${chosenExt}`;
                cleanFilename = cleanFilename.slice(0, -extname.length) + targetExt;
            } else {
                const targetExt = `.${chosenExt}`;
                if (extname && extname !== targetExt) {
                    cleanFilename = cleanFilename.slice(0, -extname.length) + targetExt;
                } else if (!extname) {
                    cleanFilename = cleanFilename + targetExt;
                }
            }

            if (!isStream) {
                const duplicate = history.items.find(x => x.urls && x.urls.includes(url) && (x.status === 'active' || x.status === 'waiting' || x.status === 'merging'));
                if (duplicate) {
                    console.log(`[Intercept] URL is already downloading (GID: ${duplicate.gid}). Ignoring duplicate request.`);
                    if (notifier) notifier.notify('DownStream', `Already downloading: ${cleanFilename.substring(0, 45)}`);
                    return { success: true, queued: true, duplicate: true };
                }

                if (notifier) notifier.notify('DownStream', `Resolving video link for: ${cleanFilename.substring(0, 45)}...`);
                
                const gid = 'youtube-' + Math.random().toString(36).substring(2, 10);
                
                const newItem = {
                    gid,
                    filename: cleanFilename,
                    urls: [url],
                    totalLength: 0,
                    completedLength: 0,
                    downloadSpeed: 0,
                    status: 'active',
                    dir: config.data.downloadDir,
                    files: [{ path: path.join(config.data.downloadDir, cleanFilename) }],
                    category: 'Videos',
                    addedDate: new Date().toISOString(),
                    completedDate: null,
                    errorMessage: '',
                    formatId,
                    chosenExt,
                    referrer
                };
                history.items.unshift(newItem);
                history.save();
                
                startYoutubeDownload(gid, url, cleanFilename, formatId, chosenExt, referrer);
                
                return { success: true, queued: true };
            }

            const packagedYtDlp = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
            const localYtDlp = path.join(config.projectRoot, 'bin', 'yt-dlp');
            const ytDlpPath = (packagedYtDlp && fs.existsSync(packagedYtDlp)) ? packagedYtDlp : localYtDlp;

            const player = config.data.preferredPlayer !== undefined ? config.data.preferredPlayer : 'vlc';

            const cacheKey = `${url}|${formatId || 'best'}`;
            const cached = formatId ? streamUrlCache.get(cacheKey) : (streamUrlCache.get(cacheKey) || streamUrlCache.get(url));
            if (cached) {
                if (isUrlExpired(cached.url) || (cached.audioUrl && isUrlExpired(cached.audioUrl))) {
                    console.log(`[Stream] Cache hit for key "${cacheKey}" is expired or near expiration. Re-resolving.`);
                } else {
                    console.log(`[Stream] Cache hit for key "${cacheKey}" (HasAudio: ${!!cached.audioUrl}) — launching player instantly`);
                    launchPlayer({
                        player,
                        targetUrl: cached.url,
                        audioUrl: cached.audioUrl,
                        originalUrl: url,
                        formatId,
                        streamUrlCache,
                        notifier,
                        title: cleanFilename
                    });
                    return { success: true, streaming: true };
                }
            }

            if (notifier) notifier.notify('DownStream', `Resolving stream for: ${cleanFilename.substring(0, 45)}...`);

            let resolvePromise = activeStreamResolutions.get(url);
            if (!resolvePromise) {
                // Skip cookies for streaming to avoid Keychain prompts
                resolvePromise = resolveStreamUrls(ytDlpPath, config, url, formatId, USER_AGENT, null);
                activeStreamResolutions.set(url, resolvePromise);
            }

            try {
                const { videoFormatId, videoUrl, audioFormatId, audioUrl } = await resolvePromise;
                activeStreamResolutions.delete(url);
                
                const resolvedKey = `${url}|${videoFormatId}`;
                streamUrlCache.set(resolvedKey, { url: videoUrl, audioUrl });
                
                if (!formatId || videoFormatId === formatId || formatId === 'best' || ['4k','2160p','1080p','720p','480p'].includes(formatId)) {
                    const cacheKey = `${url}|${formatId || 'best'}`;
                    streamUrlCache.set(cacheKey, { url: videoUrl, audioUrl });
                }
                
                launchPlayer({
                    player,
                    targetUrl: videoUrl,
                    audioUrl,
                    originalUrl: url,
                    formatId,
                    streamUrlCache,
                    notifier,
                    title: cleanFilename
                });
            } catch (err) {
                activeStreamResolutions.delete(url);
                console.error('[yt-dlp] Failed to extract stream URL, falling back to watch URL:', err.message);
                launchPlayer({
                    player,
                    targetUrl: url,
                    audioUrl: null,
                    originalUrl: url,
                    formatId,
                    streamUrlCache,
                    notifier,
                    title: cleanFilename
                });
            }

            return { success: true, streaming: true };
        }

        let cleanFilename = filename;
        if (cleanFilename) {
            cleanFilename = cleanFilename.replace(/\\/g, '/');
            cleanFilename = path.basename(cleanFilename);
            if (cleanFilename === '.' || cleanFilename === '..' || !cleanFilename) {
                cleanFilename = 'downloaded_file';
            }
        }

        // Stream direct media URLs (e.g. .mp4 links) instead of downloading
        if (isStream && (isStreamPlaylistUrl(url) || isDirectMediaUrl(url))) {
            const player = config.data.preferredPlayer !== undefined ? config.data.preferredPlayer : 'vlc';
            if (notifier) notifier.notify('DownStream', `Streaming: ${cleanFilename || 'media'}...`);

            launchPlayer({
                player,
                targetUrl: url,
                audioUrl: null,
                originalUrl: url,
                formatId,
                streamUrlCache,
                notifier,
                title: cleanFilename || 'media'
            });
            return { success: true, streaming: true };
        }

        if (!getAriaReady()) {
            queuePendingIntercept(data);
            return { success: true, queued: true };
        }

        // Check for duplicate active downloads
        const activeDupe = history.items.find(x => x.urls && x.urls.includes(url) && (x.status === 'active' || x.status === 'waiting'));
        if (activeDupe) {
            if (notifier) notifier.notify('DownStream', `Already downloading: ${(cleanFilename || '').substring(0, 45)}`);
            return { success: true, queued: true, duplicate: true };
        }

        // Check for completed duplicate on disk
        const completedDupe = history.items.find(x => x.urls && x.urls.includes(url) && x.status === 'complete');
        if (completedDupe) {
            const dupePath = completedDupe.files?.[0]?.path || '';
            if (dupePath && fs.existsSync(dupePath)) {
                if (notifier) notifier.notify('DownStream', `File already exists: ${cleanFilename || 'file'}`);
                return { success: true, duplicate: true, status: 'completed', filepath: dupePath };
            }
        }

        const options = {};
        if (cleanFilename) options.out = cleanFilename;
        if (referrer) options.referer = referrer;
        if (userAgent) options['user-agent'] = userAgent;

        const customHeaders = [];
        if (cookies) {
            customHeaders.push(`Cookie: ${cookies}`);
        }
        if (referrer) {
            customHeaders.push(`Referer: ${referrer}`);
            try {
                const originUrl = new URL(referrer);
                customHeaders.push(`Origin: ${originUrl.origin}`);
            } catch (err) {}
        }
        if (customHeaders.length > 0) {
            options.header = customHeaders;
        }

        const response = await rpc.call('addUri', [[url], options]);
        if (response.error) {
            throw new Error(response.error.message);
        }
        if (notifier) notifier.notify('DownStream', `Captured: ${cleanFilename || 'large_file'}... downloading at max speed!`);
        events.emit('intercept', { url, filename: cleanFilename });
        return { success: true, gid: response.result };
    };
};
