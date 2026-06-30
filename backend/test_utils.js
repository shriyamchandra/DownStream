const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseYtDlpProgress } = require('./lib/ytDlpUtils');
const StreamUrlCache = require('./lib/streamUrlCache');
const { isPathSafe } = require('./config/pathSafety');
const { getUniqueFilename, reservedFilenames } = require('./lib/filenameReservation');

console.log('🧪 Starting Automated Verifications...');

async function runTests() {
    try {
        console.log('1. Testing parseYtDlpProgress...');
        
        const r1 = parseYtDlpProgress('[download]  10.0% of   50.00MiB at    5.00MiB/s ETA 00:08');
        assert.ok(r1);
        assert.strictEqual(r1.totalLength, 50 * 1024 * 1024);
        assert.strictEqual(r1.completedLength, 5 * 1024 * 1024);
        assert.strictEqual(r1.downloadSpeed, 5 * 1024 * 1024);

        const r2 = parseYtDlpProgress('[download] ~80.0% of  ~500.00MiB at   10.00MiB/s ETA 00:08');
        assert.ok(r2);
        assert.strictEqual(r2.totalLength, 500 * 1024 * 1024);
        assert.strictEqual(r2.completedLength, 400 * 1024 * 1024);
        assert.strictEqual(r2.downloadSpeed, 10 * 1024 * 1024);

        const r3 = parseYtDlpProgress('[download]  50.0% of   100.00KiB at N/A ETA Unknown');
        assert.ok(r3);
        assert.strictEqual(r3.totalLength, 100 * 1024);
        assert.strictEqual(r3.completedLength, 50 * 1024);
        assert.strictEqual(r3.downloadSpeed, 0);

        const r4 = parseYtDlpProgress('[download]   2.00MiB at    1.50MiB/s ETA Unknown');
        assert.ok(r4);
        assert.strictEqual(r4.totalLength, 2 * 1024 * 1024);
        assert.strictEqual(r4.completedLength, 2 * 1024 * 1024);
        assert.strictEqual(r4.downloadSpeed, 1.5 * 1024 * 1024);

        const r5 = parseYtDlpProgress('[download] Destination: file.temp-yt.f137.mp4');
        assert.ok(r5);
        assert.strictEqual(r5.isDestination, true);

        const r6 = parseYtDlpProgress('[download] Merging formats into "output.mp4"');
        assert.strictEqual(r6, null);

        const r7 = parseYtDlpProgress('');
        assert.strictEqual(r7, null);

        const r8 = parseYtDlpProgress('[download]  20.0% of   10.00MiB at  2.00MiB/s ETA 00:04\r');
        assert.ok(r8);
        assert.strictEqual(r8.totalLength, 10 * 1024 * 1024);
        assert.strictEqual(r8.completedLength, 2 * 1024 * 1024);

        console.log('✅ parseYtDlpProgress tests passed successfully!');
    } catch (err) {
        console.error('❌ parseYtDlpProgress tests failed:', err.message);
        process.exit(1);
    }

    try {
        console.log('2. Testing StreamUrlCache...');
        const cache = new StreamUrlCache(100);
        cache.set('test-key', { url: 'http://video.url', audioUrl: 'http://audio.url' });

        const c1 = cache.get('test-key');
        assert.ok(c1);
        assert.strictEqual(c1.url, 'http://video.url');
        assert.strictEqual(c1.audioUrl, 'http://audio.url');

        await new Promise(resolve => setTimeout(resolve, 150));

        const c2 = cache.get('test-key');
        assert.strictEqual(c2, null);
        console.log('✅ StreamUrlCache tests passed successfully!');
    } catch (err) {
        console.error('❌ StreamUrlCache tests failed:', err.message);
        process.exit(1);
    }

    try {
        console.log('3. Testing Path Traversal Security (isPathSafe)...');
        
        const homeDir = os.homedir();
        const safeDir = path.join(homeDir, 'Downloads');
        
        assert.strictEqual(isPathSafe(safeDir), true);
        assert.strictEqual(isPathSafe(path.join(safeDir, 'some_folder', 'file.mp4')), true);
        
        assert.strictEqual(isPathSafe(path.join(safeDir, '../../etc/passwd')), false);
        assert.strictEqual(isPathSafe(path.join(safeDir, '..', '..', 'Windows', 'win.ini')), false);
        
        assert.strictEqual(isPathSafe(path.join(homeDir, '.ssh')), false);
        assert.strictEqual(isPathSafe(path.join(homeDir, 'Library', 'Preferences')), false);

        console.log('✅ Path Traversal Security tests passed successfully!');
    } catch (err) {
        console.error('❌ Path Traversal Security tests failed:', err.message);
        process.exit(1);
    }

    const testTempDir = path.join(__dirname, 'test_temp_reservation');
    try {
        console.log('4. Testing Filename Reservation...');
        
        if (!fs.existsSync(testTempDir)) {
            fs.mkdirSync(testTempDir, { recursive: true });
        }

        const p1 = getUniqueFilename(testTempDir, 'video.mp4');
        const p2 = getUniqueFilename(testTempDir, 'video.mp4');

        assert.strictEqual(p1, path.join(testTempDir, 'video.mp4'));
        assert.strictEqual(p2, path.join(testTempDir, 'video (1).mp4'));

        assert.ok(fs.existsSync(p1));
        assert.ok(fs.existsSync(p2));

        fs.unlinkSync(p1);
        fs.unlinkSync(p2);
        reservedFilenames.delete(p1);
        reservedFilenames.delete(p2);

        console.log('✅ Filename Reservation tests passed successfully!');
    } catch (err) {
        console.error('❌ Filename Reservation tests failed:', err.message);
        process.exit(1);
    } finally {
        try {
            if (fs.existsSync(testTempDir)) {
                fs.rmdirSync(testTempDir);
            }
        } catch (e) {}
    }

    console.log('\n🎉 All Automated Verifications Passed Successfully!');
}

runTests();
