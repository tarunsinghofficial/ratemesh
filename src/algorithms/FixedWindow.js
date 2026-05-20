/**
 * Fixed Window Counter — The simplest rate limiting algorithm.
 * 
 * HOW IT WORKS:
 * Time is divided into fixed windows (e.g., every 60 seconds).
 * Each client gets a counter that resets at the start of each window.
 * 
 * Timeline:  |----window 1----|----window 2----|
 *            0s              60s             120s
 * 
 * PROS:
 *   - Dead simple to understand and implement
 *   - O(1) memory per client (just a count + window start)
 *   - O(1) time per check
 * 
 * CONS — THE BOUNDARY FLAW:
 *   Client sends 5 requests at t=59s → ALLOWED (window 1 has capacity)
 *   Client sends 5 requests at t=61s → ALLOWED (new window, counter resets)
 *   Result: 10 requests in 2 seconds with a limit of 5 per 60s!
 * 
 *   This is not a bug in your code — it's a fundamental flaw of the algorithm.
 *   We implement it to understand it, then move to better algorithms.
 * 
 * USED BY: Quick-and-dirty rate limiters, internal tools where precision
 * doesn't matter much. NOT suitable for billing or security-critical paths.
 */

const { BaseRateLimiter } = require('./BaseRateLimiter');
const { LRUCache } = require('../cache/LRUCache');

class FixedWindow extends BaseRateLimiter {
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
     *   1. Get or create client state from cache
     *   2. If current time is past the window boundary → reset counter
     *   3. If count < limit → increment and allow
     *   4. Otherwise → deny
     */
    isAllowed(clientId) {
        const now = Date.now();

        // Try to get existing state for this client
        let state = this.cache.get(clientId);

        // New client or window has expired → start a fresh window
        if (!state || now - state.windowStart >= this.windowMs) {
            state = {
                count: 0,
                windowStart: now,
            };
        }

        // Calculate when this window resets
        const resetAt = state.windowStart + this.windowMs;

        // Check if the client is within their limit
        if (state.count < this.limit) {
            state.count++;
            this.cache.put(clientId, state);

            return {
                allowed: true,
                remaining: this.limit - state.count,
                resetAt,
            };
        }

        // Client has exceeded their limit for this window
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
}

module.exports = { FixedWindow };
