/**
 * RateMesh — The main middleware class that developers import and use.
 * 
 * This is the developer-facing API. It ties together:
 *   - Algorithms (Token Bucket, Fixed Window, Sliding Window)
 *   - Storage backends (Memory via LRU, Redis for distributed)
 *   - Express middleware (extracts client ID, checks limit, sets headers)
 * 
 * USAGE:
 *   const { RateMesh } = require('ratelime');
 * 
 *   // Simple — protect all routes
 *   const limiter = new RateMesh({ limit: 100, window: 60000 });
 *   app.use(limiter.middleware());
 * 
 *   // Advanced — multiple rules, Redis, custom key
 *   const limiter = new RateMesh({
 *     algorithm: 'token-bucket',
 *     storage: 'redis',
 *     redis: { host: 'localhost', port: 6379 },
 *     rules: [
 *       { limit: 1000, window: 60000 },                          // global
 *       { match: '/api/auth/*', limit: 10, window: 60000 },      // strict for auth
 *     ],
 *   });
 * 
 * RESPONSE HEADERS (standard HTTP):
 *   X-RateLimit-Limit:     max requests allowed in the window
 *   X-RateLimit-Remaining: requests left in the current window
 *   X-RateLimit-Reset:     Unix timestamp (seconds) when the window resets
 *   Retry-After:           seconds to wait before retrying (only on 429)
 */

const { FixedWindow } = require('../algorithms/FixedWindow');
const { SlidingWindowLog } = require('../algorithms/SlidingWindowLog');
const { TokenBucket } = require('../algorithms/TokenBucket');
const { RedisStorage } = require('../storage/RedisStorage');
const { MetricsCollector } = require('../metrics/MetricsCollector');

class RateLime {
    /**
     * @param {Object} options
     * @param {string}   [options.algorithm='token-bucket']  - 'token-bucket' | 'fixed-window' | 'sliding-window'
     * @param {string}   [options.storage='memory']          - 'memory' | 'redis'
     * @param {number}   [options.limit=100]                 - Default max requests per window
     * @param {number}   [options.window=60000]              - Default window size in ms
     * @param {Function} [options.keyGenerator]              - (req) => string, extracts client ID
     * @param {Object}   [options.redis]                     - ioredis connection options
     * @param {Array}    [options.rules]                     - Route-specific rules
     * @param {Function} [options.onDenied]                  - Custom deny handler (req, res)
     * @param {number}   [options.maxClients=10000]          - Max clients for in-memory LRU
     */
    constructor(options = {}) {
        this.algorithm = options.algorithm || 'token-bucket';
        this.storageType = options.storage || 'memory';
        this.defaultLimit = options.limit || 100;
        this.defaultWindow = options.window || 60000;
        this.keyGenerator = options.keyGenerator || ((req) => req.ip || 'unknown');
        this.onDenied = options.onDenied || null;
        this.maxClients = options.maxClients || 10000;

        // Built-in metrics (zero-dependency, zero-config)
        this.metrics = new MetricsCollector();

        // Parse rules — if none provided, create a default rule
        this.rules = (options.rules || []).map(rule => ({
            match: rule.match || null,
            identifier: rule.identifier || null,
            limit: rule.limit || this.defaultLimit,
            window: rule.window || this.defaultWindow,
        }));

        if (this.rules.length === 0) {
            this.rules.push({
                match: null,
                identifier: null,
                limit: this.defaultLimit,
                window: this.defaultWindow,
            });
        }

        // Initialize storage + algorithm engines
        if (this.storageType === 'redis') {
            this.redis = new RedisStorage(options.redis || {});
            // Redis mode: Lua scripts handle the algorithm logic
            // No need for in-memory algorithm instances
        } else {
            // Memory mode: create an algorithm instance per unique limit/window combo
            this._engines = new Map();
            for (const rule of this.rules) {
                const engineKey = `${rule.limit}:${rule.window}`;
                if (!this._engines.has(engineKey)) {
                    this._engines.set(engineKey, this._createAlgorithm(rule));
                }
            }
        }
    }

    /**
     * Create an algorithm instance for a given rule (memory mode only).
     */
    _createAlgorithm(rule) {
        const opts = {
            limit: rule.limit,
            windowMs: rule.window,
            maxClients: this.maxClients,
        };

        switch (this.algorithm) {
            case 'token-bucket':
                return new TokenBucket(opts);
            case 'fixed-window':
                return new FixedWindow(opts);
            case 'sliding-window':
                return new SlidingWindowLog(opts);
            default:
                throw new Error(`Unknown algorithm: ${this.algorithm}`);
        }
    }

    /**
     * Get the algorithm engine for a rule (memory mode).
     */
    _getEngine(rule) {
        const engineKey = `${rule.limit}:${rule.window}`;
        if (!this._engines.has(engineKey)) {
            this._engines.set(engineKey, this._createAlgorithm(rule));
        }
        return this._engines.get(engineKey);
    }

    /**
     * Check if a request path matches a rule's pattern.
     * 
     * Supports:
     *   - null/undefined → matches everything (global rule)
     *   - '/api/auth/*'  → matches /api/auth/login, /api/auth/register, etc.
     *   - '/api/data'    → exact match
     */
    _matchPath(path, pattern) {
        if (!pattern) return true;

        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -2);
            return path === prefix || path.startsWith(prefix + '/');
        }

        return path === pattern;
    }

    /**
     * Run a rate limit check for one client + rule.
     * Returns { allowed, remaining, resetAt }
     */
    async _check(clientId, rule) {
        if (this.storageType === 'redis') {
            return this.redis.check(this.algorithm, clientId, {
                limit: rule.limit,
                windowMs: rule.window,
            });
        }

        // Memory mode — use in-process algorithm
        const engine = this._getEngine(rule);
        return engine.isAllowed(clientId);
    }

    /**
     * Returns Express middleware function.
     * 
     * @param {Object} [overrides] - Override limit/window for this specific route
     * @param {number} [overrides.limit]
     * @param {number} [overrides.window]
     * @returns {Function} Express middleware (req, res, next)
     * 
     * Usage:
     *   app.use(limiter.middleware())                          // all routes
     *   app.post('/login', limiter.middleware({ limit: 5 }))   // stricter for login
     */
    middleware(overrides) {
        return async (req, res, next) => {
            try {
                // Find all rules that match this request's path
                let matchingRules = this.rules.filter(rule =>
                    this._matchPath(req.path, rule.match)
                );

                // If overrides provided, use them as a single rule
                if (overrides) {
                    matchingRules = [{
                        match: null,
                        identifier: null,
                        limit: overrides.limit || this.defaultLimit,
                        window: overrides.window || this.defaultWindow,
                    }];
                }

                // Check each matching rule. If ANY denies, the request is denied.
                // Use the most restrictive result for headers.
                let mostRestrictive = null;
                let checkClientId = null;
                const checkStart = Date.now();

                for (const rule of matchingRules) {
                    // Extract client identifier
                    const identifier = rule.identifier
                        ? rule.identifier(req)
                        : this.keyGenerator(req);

                    checkClientId = identifier;
                    const result = await this._check(identifier, rule);
                    result._rule = rule;

                    // Track the most restrictive result (lowest remaining or denied)
                    if (!mostRestrictive
                        || !result.allowed
                        || result.remaining < mostRestrictive.remaining) {
                        mostRestrictive = result;
                    }

                    // Short-circuit on denial
                    if (!result.allowed) break;
                }

                // Record metrics
                const latencyMs = Date.now() - checkStart;
                if (mostRestrictive && checkClientId) {
                    this.metrics.record({
                        algorithm: this.algorithm,
                        clientId: checkClientId,
                        allowed: mostRestrictive.allowed,
                        latencyMs,
                    });
                }

                if (!mostRestrictive) {
                    return next(); // no rules matched (shouldn't happen)
                }

                const rule = mostRestrictive._rule;

                // Always set rate limit headers (even on allow)
                res.set('X-RateLimit-Limit', String(rule.limit));
                res.set('X-RateLimit-Remaining', String(mostRestrictive.remaining));
                res.set('X-RateLimit-Reset', String(Math.ceil(mostRestrictive.resetAt / 1000)));

                if (!mostRestrictive.allowed) {
                    // DENIED — 429 Too Many Requests
                    const retryAfter = Math.max(
                        1,
                        Math.ceil((mostRestrictive.resetAt - Date.now()) / 1000)
                    );
                    res.set('Retry-After', String(retryAfter));

                    if (this.onDenied) {
                        return this.onDenied(req, res);
                    }

                    return res.status(429).json({
                        error: 'Rate limit exceeded',
                        retryAfter,
                    });
                }

                // ALLOWED — pass to next middleware / route handler
                next();
            } catch (err) {
                // If rate limiting fails (e.g., Redis down), fail open
                // This is a design choice — fail open = allow the request
                // Some systems fail closed = deny. Document this in DECISIONS.md.
                console.error('[RateMesh] Error during rate limit check:', err.message);
                next();
            }
        };
    }

    /**
     * Connect to Redis (only needed for redis storage).
     */
    async connect() {
        if (this.storageType === 'redis' && this.redis) {
            await this.redis.connect();
        }
    }

    /**
     * Close connections and clean up.
     */
    async close() {
        if (this.storageType === 'redis' && this.redis) {
            await this.redis.close();
        }
    }

    /**
     * Get current metrics snapshot.
     * @returns {Object} Metrics data (requests, latency, top denied clients, etc.)
     */
    getMetrics() {
        return this.metrics.getMetrics();
    }

    /**
     * Reset all metrics counters.
     */
    resetMetrics() {
        this.metrics.reset();
    }
}

module.exports = { RateLime };
