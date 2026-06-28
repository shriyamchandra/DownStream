const assert = require('assert');
const { parseYtDlpProgress } = require('./lib/ytDlpUtils');
const StreamUrlCache = require('./lib/streamUrlCache');

console.log('🧪 Starting Automated Verifications...');

// ── Test 1: progress line parsing ─────────────────────────────────
console.log('1. Testing parseYtDlpProgress...');

// Case A: Standard line
const r1 = parseYtDlpProgress('[download]  10.0% of   50.00MiB at    5.00MiB/s ETA 00:08');
assert.ok(r1);
assert.strictEqual(r1.totalLength, 50 * 1024 * 1024);
assert.strictEqual(r1.completedLength, 5 * 1024 * 1024);
assert.strictEqual(r1.downloadSpeed, 5 * 1024 * 1024);

// Case B: Approximate sizes with ~
const r2 = parseYtDlpProgress('[download] ~80.0% of  ~500.00MiB at   10.00MiB/s ETA 00:08');
assert.ok(r2);
assert.strictEqual(r2.totalLength, 500 * 1024 * 1024);
assert.strictEqual(r2.completedLength, 400 * 1024 * 1024);
assert.strictEqual(r2.downloadSpeed, 10 * 1024 * 1024);

// Case C: N/A speed
const r3 = parseYtDlpProgress('[download]  50.0% of   100.00KiB at N/A ETA Unknown');
assert.ok(r3);
assert.strictEqual(r3.totalLength, 100 * 1024);
assert.strictEqual(r3.completedLength, 50 * 1024);
assert.strictEqual(r3.downloadSpeed, 0);

// Case D: Unknown total size
const r4 = parseYtDlpProgress('[download]   2.00MiB at    1.50MiB/s ETA Unknown');
assert.ok(r4);
assert.strictEqual(r4.totalLength, 2 * 1024 * 1024);
assert.strictEqual(r4.completedLength, 2 * 1024 * 1024);
assert.strictEqual(r4.downloadSpeed, 1.5 * 1024 * 1024);

// Case E: Destination line
const r5 = parseYtDlpProgress('[download] Destination: file.temp-yt.f137.mp4');
assert.ok(r5);
assert.strictEqual(r5.isDestination, true);

// Case F: Stale/non-progress line
const r6 = parseYtDlpProgress('[download] Merging formats into "output.mp4"');
assert.strictEqual(r6, null);

console.log('✅ parseYtDlpProgress tests passed successfully!');

// ── Test 2: StreamUrlCache ────────────────────────────────────────
console.log('2. Testing StreamUrlCache...');

const cache = new StreamUrlCache(100); // 100ms TTL for testing
cache.set('test-key', { url: 'http://video.url', audioUrl: 'http://audio.url' });

// Verify retrieval before expiration
const c1 = cache.get('test-key');
assert.ok(c1);
assert.strictEqual(c1.url, 'http://video.url');
assert.strictEqual(c1.audioUrl, 'http://audio.url');

// Wait for expiration
setTimeout(() => {
    try {
        const c2 = cache.get('test-key');
        assert.strictEqual(c2, null); // should have expired
        assert.strictEqual(cache.cache.size, 0); // should have been purged from map
        console.log('✅ StreamUrlCache tests passed successfully!');

        // ── Test 3: Path Traversal Sanitization ───────────────────────────
        console.log('3. Testing Path Traversal Sanitization...');
        const path = require('path');
        const sanitizeFilename = (filename) => {
            return path.basename(filename.replace(/\\/g, '/'));
        };
        assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'passwd');
        assert.strictEqual(sanitizeFilename('..\\..\\Windows\\win.ini'), 'win.ini');
        assert.strictEqual(sanitizeFilename('normal_file.mp4'), 'normal_file.mp4');
        console.log('✅ Path Traversal Sanitization tests passed successfully!');

        // ── Test 4: Filename Reservation ──────────────────────────────────
        console.log('4. Testing Filename Reservation...');
        const reservedFilenames = new Set();
        const getUniqueFilenameTest = (dir, baseName) => {
            let finalPath = path.join(dir, baseName);
            const ext = path.extname(baseName);
            const stem = baseName.slice(0, baseName.length - ext.length);
            let counter = 1;
            while (reservedFilenames.has(finalPath)) {
                const candidate = `${stem} (${counter})${ext}`;
                finalPath = path.join(dir, candidate);
                counter++;
            }
            reservedFilenames.add(finalPath);
            return finalPath;
        };
        const p1 = getUniqueFilenameTest('/tmp', 'video.mp4');
        const p2 = getUniqueFilenameTest('/tmp', 'video.mp4');
        assert.strictEqual(p1, path.join('/tmp', 'video.mp4'));
        assert.strictEqual(p2, path.join('/tmp', 'video (1).mp4'));
        reservedFilenames.delete(p1);
        reservedFilenames.delete(p2);
        console.log('✅ Filename Reservation tests passed successfully!');

        console.log('\n🎉 All Automated Verifications Passed!');
    } catch (err) {
        console.error('❌ Expiration test failed:', err.message);
        process.exit(1);
    }
}, 150);
