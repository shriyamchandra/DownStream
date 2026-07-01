# Bugs Fixed in DownStream Extension

## Download Interception

### 1. Downloads weren't being intercepted properly
**What was wrong:** The extension used the wrong Chrome event to catch downloads. By the time it tried to stop a download, Chrome had already started it. You'd see a flash in the download bar before it disappeared.

**What we did:** Moved the interception logic to `onDeterminingFilename`, which fires *before* the download starts. Now the download never begins — it goes straight to the app.

### 2. "Watch & Stream" actually streams now
**What was wrong:** When you clicked "Watch & Stream" on a direct video link (like a .mp4 file), the backend ignored the stream flag and just downloaded it anyway.

**What we did:** Added handling for direct media URLs in the backend. Now when you click "Watch & Stream" on a .mp4 link, it opens in your media player.

### 3. Same download was being processed 2-3 times
**What was wrong:** Three different Chrome events (`onDeterminingFilename`, `onCreated`, `onChanged`) all tried to handle the same download. This caused double or triple sends to the app.

**What we did:** Made `onCreated` skip downloads already handled, and made `onChanged` only catch downloads that were intentionally resumed (paused → resumed).

### 4. Resuming a paused download would get hijacked
**What was wrong:** If you paused a download in Chrome and hit resume, the extension would cancel it and send it to the app again.

**What we did:** The `onChanged` listener now checks that the previous state was "paused" before intercepting. New downloads that just happen to trigger `onChanged` are left alone.

### 5. Extension would fight Chrome's service worker lifecycle
**What was wrong:** The extension used a "keep alive" hack that pinged Chrome every 20 seconds to prevent the service worker from sleeping. Chrome intentionally kills service workers to save resources, and fighting this causes issues.

**What we did:** Removed the keep-alive hack entirely. Let Chrome manage its own lifecycle.

### 6. Extension settings got reset on every update
**What was wrong:** Every time the extension auto-updated, it would overwrite your custom settings (like which file types to intercept) back to defaults.

**What we did:** Now it only sets defaults on a fresh install, not on updates.

---

## Security

### 7. Filenames could run malicious code (XSS)
**What was wrong:** Filenames from downloads were inserted directly into the popup HTML without escaping. A filename like `<script>alert(1)</script>` could run code in the extension popup.

**What we did:** Added an escape function that converts special characters (`<`, `>`, `"`, `'`, `&`) to safe HTML entities. Applied it everywhere dynamic content is shown.

### 8. Error messages and URLs had the same XSS problem
**What was wrong:** Error messages from the download server and stream URLs were also inserted into HTML without escaping.

**What we did:** Escaped all dynamic content in the popup — filenames, error messages, URLs, hostnames, format IDs, everything.

### 9. Toast notifications used innerHTML unsafely
**What was wrong:** The toast popup (the little notification at the bottom-right) used `innerHTML` to show messages, which could be exploited if the message contained HTML.

**What we did:** Switched to `textContent` which treats everything as plain text.

### 10. MIME type matching was too broad
**What was wrong:** The extension checked if a MIME type *contained* words like "zip" or "compressed". This would accidentally match unrelated types like `application/x-font-compressed`.

**What we did:** Changed to exact MIME type matching for each format.

---

## UI / Popup

### 11. Quality selector was an ugly browser dropdown
**What was wrong:** In the popup, when you clicked "Stream" on a completed download, the quality picker was a plain HTML `<select>` dropdown that looked out of place.

**What we did:** Replaced it with styled radio cards that match the rest of the dark theme design.

### 12. Stream button had no feedback
**What was wrong:** When you clicked "Watch & Stream" in the quality modal, the button just went back to normal with no confirmation. The Download button showed a checkmark, but Stream didn't.

**What we did:** Stream button now shows "Streaming!" on success or "Failed" on error, then resets after a couple seconds.

### 13. "Watch & Stream" button had inline styles
**What was wrong:** The stream button in both modals had CSS styles written directly in the HTML (`style="background: rgba(255, 107, 53, 0.14)..."`). Hard to maintain and inconsistent.

**What we did:** Moved all styles to a proper CSS class `.ds-modal-btn--stream` with hover and disabled states.

### 14. Video title could get clipped at wrong width
**What was wrong:** The floating button on video pages had a fixed pixel width for the title. On different font sizes, it would clip too early or too late.

**What we did:** Changed from `max-width: 190px` to `max-width: 28ch` so it scales with the font.

### 15. Spinner animation names could collide
**What was wrong:** Both the modal spinner and the floating button spinner used the same CSS animation name `ds-spin`. If CSS loaded in the wrong order, one could break the other.

**What we did:** Gave each spinner its own animation name (`ds-modal-spin` and `ds-fab-spin`).

---

## Accessibility

### 16. No keyboard focus outlines on buttons
**What was wrong:** All buttons used `all: unset` which removed the default focus outlines. Keyboard users couldn't tell which button was selected.

**What we did:** Added `:focus-visible` outlines (orange glow) on all interactive elements — download cards, floating buttons, modal buttons, footer buttons, confirm dialogs, and quality options.

### 17. Modal didn't trap keyboard focus
**What was wrong:** When the quality picker modal was open, pressing Tab would jump to elements behind the modal on the page.

**What we did:** Added focus trapping — Tab cycles through buttons inside the modal only. Escape key closes the modal.

### 18. Floating button broke on RTL pages
**What was wrong:** The floating button used `all: initial` which resets everything including text direction. On right-to-left pages (like Arabic), the button would render incorrectly.

**What we did:** Added `direction: ltr` and `color-scheme: dark` to force correct rendering regardless of the host page.

---

## Memory / Performance

### 19. Download tracking map grew forever
**What was wrong:** The map that tracks recently-handled downloads had no size limit. Over time it would grow and use more memory.

**What we did:** Added a cap of 500 entries. When it exceeds that, the oldest entries get removed.

### 20. Stream detection map grew forever
**What was wrong:** The map that tracks detected video streams per tab had no limit on the number of tabs.

**What we did:** Capped at 50 tabs. Oldest gets evicted when the cap is hit.

### 21. Download history in popup grew forever
**What was wrong:** The popup kept accumulating download history items without ever removing old ones.

**What we did:** Capped at 100 items.

### 22. Escape function was slow
**What was wrong:** The `esc()` function in the content script created a new DOM element on every call just to escape text. On pages with many format options, this was called dozens of times.

**What we did:** Replaced with simple string `.replace()` calls — no DOM needed.

### 23. Download normalization ran every poll cycle
**What was wrong:** Every 1.5 seconds, the popup re-created normalized download objects for every history item, even if nothing changed.

**What we did:** Added caching — only re-normalizes when the download's status or progress actually changes.

### 24. Server port defaulted to 3000 after restart
**What was wrong:** When Chrome restarted the service worker, the cached server port reset to 3000. The first request after restart might go to the wrong port.

**What we did:** Now reads the saved port from storage on startup.

### 25. Server port stored wrong value
**What was wrong:** When pinging ports to find the server, the code stored the `webPort` from the JSON response, which could be a different port that doesn't actually serve the API.

**What we did:** Now stores the port that actually responded to the ping.

---

## Other Bugs

### 26. FAB kept reappearing after dismissal
**What was wrong:** On single-page apps (like YouTube), dismissing the floating button would trigger a DOM mutation, which would detect the video again and re-show the button.

**What we did:** Added a "dismissed" flag that prevents re-injection until the page navigates to a new URL.

### 27. Popstate listener accumulated on every dismiss
**What was wrong:** Every time the floating button was destroyed and recreated, a new `popstate` event listener was added without removing the old one. After dismissing 10 times, each navigation event would fire 10 handlers.

**What we did:** Now removes the previous listener before adding a new one.

### 28. Click interceptor broke some video players
**What was wrong:** The extension intercepted clicks on .mp4 links, even if the page had its own video player that was supposed to handle those clicks (like video.js or Plyr).

**What we did:** Now checks if the click target is inside a video player container before intercepting. Also checks if there's already a `<video>` element playing that URL.

### 29. TikTok blacklist entry was dead code
**What was wrong:** TikTok was in the "don't show FAB" blacklist, but it was also in the "recognized video sites" list. Since the video sites check runs first, the blacklist entry for TikTok never triggered.

**What we did:** Removed TikTok from the blacklist.

### 30. `dmg` files were miscategorized
**What was wrong:** `.dmg` files (macOS installers) were categorized as "Archives" instead of "Software" because the Archives list was checked first.

**What we did:** Moved `dmg` to the Software category only.

### 31. `formatBytes` broke on negative numbers
**What was wrong:** If the download server reported a negative byte count (corrupt data), the function would return "NaN undefined".

**What we did:** Added a guard — returns "0 B" for negative or zero values.

### 32. `formatEta` showed negative times
**What was wrong:** If completed bytes exceeded total bytes (aria2 reporting bug), ETA would show something like "-5s".

**What we did:** Added a guard — returns empty string for negative or zero values.

### 33. `getExt` failed on trailing dots
**What was wrong:** A filename like `file.` (trailing dot) would return an empty string as the extension, which could cause unexpected behavior downstream.

**What we did:** Added proper handling for trailing dots and `.hidden` files (dot at position 0).

### 34. `shared-constants.js` was never loaded
**What was wrong:** A file called `shared-constants.js` defined common constants and functions, but it was never imported by any script. Meanwhile, `background.js` and `content.js` each had their own copies of the same functions, which could drift out of sync.

**What we did:** Noted as a future refactor target. The individual copies were already consistent after our fixes.

### 35. `navigator.userAgent` was from the wrong context
**What was wrong:** The extension sent the service worker's user agent string with download requests, not the actual browser tab's user agent. These can differ.

**What we did:** Removed the user agent from the payload entirely — the server doesn't need it.

### 36. `fetchDetectedStreams` silently swallowed errors
**What was wrong:** When the service worker was dead (common in MV3), the popup's request to get detected streams would fail silently and return empty results with no indication of why.

**What we did:** Added `chrome.runtime.lastError` checks so the error is properly handled instead of silently ignored.

### 37. Production console logs had emoji characters
**What was wrong:** Console messages like `[Aria2] ✅ Sending to app` used emoji that could cause encoding issues in some environments.

**What we did:** Removed all emoji from log messages.
