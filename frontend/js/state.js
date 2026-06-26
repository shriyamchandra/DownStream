// Shared, mutable application state. Modules import this single object and
// read/write its fields, so updates are visible everywhere (this replaces the
// old top-level `let` variables that a split into modules would have isolated).
export const state = {
    downloads: [],
    currentFilter: 'all',
    appConfig: { preferredPlayer: 'vlc', downloadDir: '' },
    speedHistory: [],
    expandedGids: new Set()
};

export const MAX_SPEED_POINTS = 30;
