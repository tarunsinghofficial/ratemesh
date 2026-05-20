/**
 * BaseRateLimiter — Abstract base class for all rate limiting algorithms.
 * 
 * Every algorithm (Fixed Window, Sliding Window, Token Bucket) extends this
 * and implements the same isAllowed() interface. This makes them interchangeable —
 * the middleware doesn't care which algorithm is underneath.
 * 
 * WHY THIS MATTERS:
 * In a real system, you might start with Fixed Window for simplicity,
 * then swap to Token Bucket when you discover the boundary flaw.
 * A common interface makes that swap a one-line config change.
 */

class BaseRateLimiter {
    /**
     * @param {Object} options
     * @param {number} options.limit    - Max requests allowed in the window
     * @param {number} options.windowMs - Window size in milliseconds
     */
    constructor({ limit, windowMs }) {
        if (!limit || limit < 1) {
            throw new Error('limit must be a positive integer');
        }
        if (!windowMs || windowMs < 1) {
            throw new Error('windowMs must be a positive integer');
        }

        this.limit = limit;
        this.windowMs = windowMs;
    }

    /**
     * Check if a request from clientId should be allowed.
     * 
     * @param {string} clientId - Unique identifier (IP, API key, userId)
     * @returns {Object} { allowed: boolean, remaining: number, resetAt: number }
     *   - allowed:   true if request should proceed, false if rate limited
     *   - remaining: how many more requests the client can make in this window
     *   - resetAt:   timestamp (ms) when the window resets / tokens refill
     */
    isAllowed(clientId) {
        throw new Error('Subclass must implement isAllowed()');
    }

    /**
     * Reset a specific client's rate limit state.
     * Useful for admin overrides or testing.
     * 
     * @param {string} clientId
     */
    reset(clientId) {
        throw new Error('Subclass must implement reset()');
    }
}

module.exports = { BaseRateLimiter };
