export function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('theme-light');
        root.classList.remove('theme-dark');
    } else if (theme === 'dark') {
        root.classList.add('theme-dark');
        root.classList.remove('theme-light');
    } else {
        root.classList.remove('theme-light', 'theme-dark');
    }
}

export function initTheme() {
    applyTheme(localStorage.getItem('appTheme') || 'system');
}
