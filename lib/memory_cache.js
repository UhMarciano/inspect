class MemoryCache {
    constructor(maxEntries = 2000) {
        this.cache = new Map();
        this.rankCache = new Map();
        this.maxEntries = maxEntries;
        this.staleCheckInterval = 1000 * 60 * 15;
        setInterval(() => this.cleanup(), this.staleCheckInterval);
    }

    generateKey(item) {
        return item.a;
    }

    insertItemData(item, price) {
        const key = this.generateKey(item);

        // Enforce max size
        if (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, {
            item: Object.assign({}, item),
            price: price || null,
            timestamp: Date.now()
        });

        return Promise.resolve();
    }

    updateItemPrice(assetId, price) {
        const entry = this.cache.get(assetId);
        if (entry) {
            entry.price = price;
        }
    }

    getItemData(keys) {
        const result = [];
        for (const key of keys) {
            const entry = this.cache.get(key);
            if (entry) {
                result.push(Object.assign({}, entry.item, { price: entry.price }));
            }
        }
        return Promise.resolve(result);
    }

    getItemRank(a) {
        return Promise.resolve(this.rankCache.get(a) || {});
    }

    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if ((now - entry.timestamp) > 60 * 60 * 1000) { // 1 hour
                this.cache.delete(key);
            }
        }
    }
}

module.exports = MemoryCache;
