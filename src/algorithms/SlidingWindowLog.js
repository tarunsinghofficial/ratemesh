/**
 * Sliding Window Log — The most accurate rate limiting algorithm.
 * 
 * HOW IT WORKS:
 * Instead of fixed time blocks, we keep a LOG of every request timestamp
 * per client. On each new request, we:
 *   1. Remove all timestamps older than (now - windowMs)
 *   2. Count remaining timestamps
 *   3. If count < limit → ALLOW, add current timestamp to the log
 *   4. Else → DENY
 * 
 * This is a "sliding" window because it always looks back exactly windowMs
 * from the current moment. There are no boundaries to straddle.
 * 
 * PROS:
 *   - Most accurate — no boundary flaw
 *   - Easy to reason about: "did this client send more than N requests
 *     in the last M seconds?" is answered precisely
 * 
 * CONS — THE MEMORY PROBLEM:
 *   Memory per client = O(number of requests in the window)
 *   If a client sends 10,000 requests in a window, you store 10,000 timestamps.
 *   That's 10,000 * 8 bytes = 80KB per client. With 100k clients = 8GB.
 *   
 *   Compare to Fixed Window: just 2 numbers per client (16 bytes).
 *   Compare to Token Bucket: just 2 numbers per client (16 bytes).
 * 
 * USED BY: Systems where accuracy matters more than memory — audit logging,
 * compliance-sensitive rate limiting. Not ideal for high-throughput APIs.
 */

const { BaseRateLimiter } = require('./BaseRateLimiter');
const { LRUCache } = require('../cache/LRUCache');

class SlidingWindowLog extends BaseRateLimiter {
    /**
     * @param {Object} options
     * @param {number} options.limit      - Max requests per window
     * @param {number} options.windowMs   - Window size in milliseconds
     * @param {number} [options.maxClients=10000] - Max clients to track in LRU cache
     */
    constructor({ limit, windowMs, maxClients = 10000 }) {
        super({ limit, windowMs });
        this.cache = new LRUCache(maxClients);
    }

    /**
     * Check if this client's request should be allowed.
     * 
     * Logic:
     *   1. Get or create the client's timestamp log
     *   2. Prune timestamps that have fallen outside the window
     *   3. If the log is under the limit → add timestamp, allow
     *   4. Otherwise → deny
     * 
     * The key insight: we always look back exactly windowMs from NOW.
     * This eliminates the boundary flaw of Fixed Window.
     */
    isAllowed(clientId) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        // Get existing log or create empty one
        let state = this.cache.get(clientId);

        if (!state) {
            state = { timestamps: [] };
        }

        // PRUNE: Remove all timestamps that have fallen outside the window.
        // This is O(n) where n = number of timestamps in the log.
        // We use a while-loop from the front since timestamps are in order.
        while (state.timestamps.length > 0 && state.timestamps[0] <= windowStart) {
            state.timestamps.shift();
        }

        // Calculate the reset time:
        // If there are timestamps, the window resets when the oldest one expires.
        // If empty, the window resets after a full window from now.
        const resetAt = state.timestamps.length > 0
            ? state.timestamps[0] + this.windowMs
            : now + this.windowMs;

        // Check if the client is within their limit
        if (state.timestamps.length < this.limit) {
            state.timestamps.push(now);
            this.cache.put(clientId, state);

            return {
                allowed: true,
                remaining: this.limit - state.timestamps.length,
                resetAt,
            };
        }

        // Client has exceeded their limit
        this.cache.put(clientId, state); // save pruned state back
        return {
            allowed: false,
            remaining: 0,
            resetAt,
        };
    }

    /**
     * Reset a client's rate limit state.
     */
    reset(clientId) {
        this.cache.delete(clientId);
    }

    /**
     * Get the current memory usage for a client (number of stored timestamps).
     * Useful for demonstrating the O(n) memory problem in benchmarks.
     */
    getLogSize(clientId) {
        const state = this.cache.peek(clientId);
        return state ? state.timestamps.length : 0;
    }
}

module.exports = { SlidingWindowLog };
