class StreamUrlCache {
    constructor(ttlMs = 50 * 1000) {
        this.cache = new Map();
        this.ttl = ttlMs;
    }

    get(key) {
        this.clean();
        const entry = this.cache.get(key);
        if (entry && (Date.now() - entry.timestamp < this.ttl)) {
            return entry;
        }
        if (entry) {
            this.cache.delete(key);
        }
        return null;
    }

    has(key) {
        return this.get(key) !== null;
    }

    set(key, value) {
        this.clean();
        this.cache.set(key, {
            ...value,
            timestamp: Date.now()
        });
    }

    clean() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp >= this.ttl) {
                this.cache.delete(key);
            }
        }
    }
}

module.exports = StreamUrlCache;
