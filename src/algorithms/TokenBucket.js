/**
 * Token Bucket — The production-grade rate limiting algorithm.
 * 
 * HOW IT WORKS:
 * Imagine each client has a bucket that holds a maximum of N tokens.
 * Tokens refill at a constant rate (e.g., 10 tokens per second).
 * Each request consumes 1 token from the bucket.
 * If the bucket is empty → request is denied (429).
 * 
 * THE MATH (this is what makes it elegant):
 *   On each request, we calculate how many tokens should have refilled
 *   since the last request, without actually running a timer:
 *   
 *   elapsed      = now - lastRefillTime
 *   newTokens    = elapsed * refillRate
 *   tokens       = min(capacity, currentTokens + newTokens)
 *   
 *   This is called "lazy refill" — we don't need a background timer.
 *   We calculate the state just-in-time when a request arrives.
 * 
 * WHY THIS WINS (the interview answer):
 *   - O(1) memory per client: just 2 numbers (tokens + lastRefillTime)
 *   - O(1) time per check: simple arithmetic, no array operations
 *   - No boundary flaw: tokens refill continuously, not at discrete boundaries
 *   - Handles bursts: bucket can fill up during quiet periods and absorb spikes
 *   - Industry standard: used by Stripe, AWS API Gateway, most production systems
 * 
 * TRADE-OFF vs Sliding Window Log:
 *   Token Bucket is slightly less precise — it allows "bursts" up to bucket
 *   capacity. Sliding Window Log is exact. But for 99.9% of use cases,
 *   the O(1) memory wins over exact precision.
 * 
 * EXAMPLE with limit=10, window=60s:
 *   capacity   = 10 tokens
 *   refillRate = 10 / 60000 = 0.000167 tokens per millisecond
 *   
 *   t=0:     tokens=10, request → tokens=9  (ALLOW)
 *   t=100ms: tokens=9 + (100 * 0.000167) = 9.0167 → 9.0167, request → 8.0167 (ALLOW)
 *   ...client sends 10 requests rapidly...
 *   t=500ms: tokens=0.08, request → DENY (bucket empty)
 *   t=6500ms: tokens=0.08 + (6000 * 0.000167) = 1.08, request → 0.08 (ALLOW — refilled!)
 */

const { BaseRateLimiter } = require('./BaseRateLimiter');
const { LRUCache } = require('../cache/LRUCache');

class TokenBucket extends BaseRateLimiter {
    /**
     * @param {Object} options
     * @param {number} options.limit       - Max tokens (bucket capacity)
     * @param {number} options.windowMs    - Time for a full refill in milliseconds
     * @param {number} [options.maxClients=10000] - Max clients to track in LRU cache
     * 
     * Derived values:
     *   capacity   = limit (max tokens in the bucket)
     *   refillRate = limit / windowMs (tokens added per millisecond)
     */
    constructor({ limit, windowMs, maxClients = 10000 }) {
        super({ limit, windowMs });
        this.capacity = limit;
        this.refillRate = limit / windowMs; // tokens per millisecond
        this.cache = new LRUCache(maxClients);
    }

    /**
     * Check if this client's request should be allowed.
     * 
     * Logic:
     *   1. Get or create client state
     *   2. Calculate elapsed time since last refill
     *   3. Add refilled tokens (capped at capacity)
     *   4. If tokens >= 1 → consume one token, allow
     *   5. Otherwise → deny
     * 
     * The "lazy refill" approach means we never need a background timer.
     * We compute the exact token count at the moment of each request.
     */
    isAllowed(clientId) {
        const now = Date.now();

        let state = this.cache.get(clientId);

        if (!state) {
            // New client: give them a full bucket
            state = {
                tokens: this.capacity,
                lastRefillTime: now,
            };
        }

        // LAZY REFILL: calculate how many tokens should have been added
        const elapsed = now - state.lastRefillTime;
        const tokensToAdd = elapsed * this.refillRate;

        // Refill, but never exceed capacity
        state.tokens = Math.min(this.capacity, state.tokens + tokensToAdd);
        state.lastRefillTime = now;

        // Calculate when the client will have a token again (for Retry-After header)
        // If tokens < 1, time until next token = (1 - tokens) / refillRate
        const resetAt = state.tokens >= 1
            ? now + this.windowMs
            : now + Math.ceil((1 - state.tokens) / this.refillRate);

        // Check if the client has a token to spend
        if (state.tokens >= 1) {
            state.tokens -= 1;
            this.cache.put(clientId, state);

            return {
                allowed: true,
                remaining: Math.floor(state.tokens),
                resetAt,
            };
        }

        // Bucket is empty — deny the request
        this.cache.put(clientId, state);

        return {
            allowed: false,
            remaining: 0,
            resetAt,
        };
    }

    /**
     * Reset a client's rate limit state (give them a full bucket).
     */
    reset(clientId) {
        this.cache.delete(clientId);
    }
}

module.exports = { TokenBucket };
