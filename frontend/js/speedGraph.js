import { state, MAX_SPEED_POINTS } from './state.js';

// Renders the download-speed sparkline onto the #speedGraph canvas.
export function drawSpeedGraph() {
    const canvas = document.getElementById('speedGraph');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // Scale the canvas buffer if it doesn't match the styled size (retina support).
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }

    const width = rect.width;
    const height = rect.height;
    const speedHistory = state.speedHistory;

    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#3b82f6';
    const borderColor = style.getPropertyValue('--border-subtle').trim() || 'rgba(255, 255, 255, 0.05)';
    const mutedColor = style.getPropertyValue('--text-tertiary').trim() || '#6e6e7a';

    // Empty state: no traffic to plot — show a centered label.
    const hasTraffic = speedHistory.length >= 2 && Math.max(...speedHistory) > 0;
    if (!hasTraffic) {
        ctx.fillStyle = mutedColor;
        ctx.font = "500 11px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No active traffic', width / 2, height / 2);
        return;
    }

    // Subtle grid lines.
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
        const y = (height / 3) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Scale graph (minimum peak of 500 KB/s).
    const maxVal = Math.max(...speedHistory, 500 * 1024);

    const points = [];
    const step = width / (MAX_SPEED_POINTS - 1);
    const offsetIndex = MAX_SPEED_POINTS - speedHistory.length;

    for (let i = 0; i < speedHistory.length; i++) {
        const x = (offsetIndex + i) * step;
        const y = height - 4 - ((speedHistory[i] / maxVal) * (height - 8));
        points.push({ x, y });
    }

    // Gradient fill.
    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.quadraticCurveTo(points[points.length - 1].x, points[points.length - 1].y, points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(width, height);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
    fillGrad.addColorStop(0, accent + '40'); // 25% opacity
    fillGrad.addColorStop(1, accent + '00'); // 0% opacity
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Glowing line.
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.quadraticCurveTo(points[points.length - 1].x, points[points.length - 1].y, points[points.length - 1].x, points[points.length - 1].y);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
}
