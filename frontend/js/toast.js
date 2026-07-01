import { escapeHtml } from './format.js';

let toastContainer = null;

function ensureToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
    return toastContainer;
}

export function showToast(title, desc = '', type = 'success') {
    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = 'toast';

    let iconSvg = '';
    if (type === 'success') {
        iconSvg = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        `;
    } else if (type === 'error') {
        iconSvg = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        `;
    } else {
        iconSvg = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
        `;
    }

    toast.innerHTML = `
        <div class="toast-icon ${type}">
            ${iconSvg}
        </div>
        <div class="toast-content">
            <div class="toast-title">${escapeHtml(title)}</div>
            ${desc ? `<div class="toast-desc">${escapeHtml(desc)}</div>` : ''}
        </div>
    `;

    container.appendChild(toast);

    const removeTimer = setTimeout(() => {
        removeToast(toast);
    }, 3500);

    toast.style.cursor = 'pointer';
    toast.addEventListener('click', () => {
        clearTimeout(removeTimer);
        removeToast(toast);
    });
}

function removeToast(toast) {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => {
        toast.remove();
        if (toastContainer && toastContainer.childNodes.length === 0) {
            toastContainer.remove();
            toastContainer = null;
        }
    });
}
