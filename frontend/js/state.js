export const state = {
    downloads: [],
    currentFilter: 'all',
    appConfig: { preferredPlayer: 'vlc', downloadDir: '' },
    speedHistory: [],
    expandedGids: new Set(),
    activeMerges: {}
};

export const MAX_SPEED_POINTS = 30;
