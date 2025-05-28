class MemoryCache {
    constructor() {
        this.cache = new Map();
        this.staleCheckInterval = 1000 * 60 * 60; // 1 hour
        this.rankCache = new Map();

        setInterval(() => this.cleanup(), this.staleCheckInterval);
    }

    connect() {
        return Promise.resolve();
    }

    getItemData(links) {
        if (!Array.isArray(links)) {
            return Promise.resolve([]);
        }

        const results = [];
        for (const link of links) {
            const params = link.getParams ? link.getParams() : link;
            const key = this.generateKey(params);
            const cachedData = this.cache.get(key);
            if (cachedData) {
                results.push(cachedData.item);
            }
        }
        return Promise.resolve(results);
    }

    insertItemData(item, price) {
        const key = this.generateKey(item);
        this.cache.set(key, {
            item: Object.assign({}, item),
            price: price || null,
            timestamp: Date.now()
        });
        return Promise.resolve();
    }

    updateItemPrice(assetId, price) {
        for (const [, value] of this.cache.entries()) {
            if (value.item.a === assetId) {
                value.price = price;
                break;
            }
        }
        return Promise.resolve();
    }

    getItemRank(assetId) {
        const rank = this.rankCache.get(assetId) || {};
        return Promise.resolve(rank);
    }

    generateKey(item) {
        return `${item.a || ''}_${item.d || ''}_${item.s || item.m || ''}`;
    }

    cleanup() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > this.staleCheckInterval) {
                this.cache.delete(key);
            }
        }
    }
}

module.exports = MemoryCache;