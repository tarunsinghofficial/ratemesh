/**
 * MemoryStorage — In-memory storage backend backed by your LRU Cache.
 * 
 * WHY THIS EXISTS:
 * When running a single Node.js server, you don't need Redis.
 * MemoryStorage wraps your hand-built LRU cache with an async interface
 * that matches RedisStorage — so the middleware doesn't care which one
 * is underneath. Swap 'memory' for 'redis' in config, zero code changes.
 * 
 * WHEN TO USE:
 *   - Single server deployments
 *   - Development / testing
 *   - When you don't want a Redis dependency
 * 
 * LIMITATION:
 *   - State is lost on server restart
 *   - Not shared across multiple Node.js instances
 *   - That's exactly why RedisStorage exists (Phase 3)
 */

const { LRUCache } = require('../cache/LRUCache');

class MemoryStorage {
    /**
     * @param {Object} [options]
     * @param {number} [options.maxClients=10000] - Max entries in LRU cache
     */
    constructor({ maxClients = 10000 } = {}) {
        this.cache = new LRUCache(maxClients);
    }

    /**
     * Get a value by key. Marks it as recently used (LRU behavior).
     * Async to match RedisStorage interface.
     */
    async get(key) {
        return this.cache.get(key);
    }

    /**
     * Set a key-value pair. Evicts LRU entry if at capacity.
     */
    async set(key, value) {
        this.cache.put(key, value);
    }

    /**
     * Delete a key.
     */
    async delete(key) {
        return this.cache.delete(key);
    }

    /**
     * Check if a key exists without updating recency.
     */
    async has(key) {
        return this.cache.peek(key) !== null;
    }

    /**
     * Current number of entries.
     */
    size() {
        return this.cache.size();
    }

    /**
     * Clear all entries.
     */
    async clear() {
        this.cache.clear();
    }

    /**
     * No-op for memory storage. Exists so the interface matches RedisStorage.
     */
    async close() {
        // Nothing to close — memory is freed with the process
    }
}

module.exports = { MemoryStorage };
