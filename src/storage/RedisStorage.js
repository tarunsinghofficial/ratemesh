/**
 * RedisStorage — Distributed storage backend using Redis + Lua scripts.
 * 
 * WHY REDIS FOR RATE LIMITING:
 * When you have multiple Node.js instances (which every production system does),
 * in-memory LRU cache doesn't work — Server A doesn't know about Server B's
 * requests. Redis is the shared state that all servers talk to.
 * 
 * WHY LUA SCRIPTS (the key insight):
 * Redis is single-threaded. A Lua script runs atomically — no other command
 * can execute while your script is running. This eliminates the race condition:
 * 
 *   WRONG (race condition):
 *     Server A: GET tokens → 1
 *     Server B: GET tokens → 1     (reads same value!)
 *     Server A: SET tokens → 0
 *     Server B: SET tokens → 0     (both think they got the last token)
 *     Result: 2 requests allowed with 1 token → BUG
 * 
 *   RIGHT (Lua script):
 *     Server A: EVAL lua_script → reads 1, decrements to 0, returns ALLOW
 *     Server B: EVAL lua_script → reads 0, returns DENY
 *     Result: exactly 1 request allowed → CORRECT
 * 
 * Each algorithm is implemented as a self-contained Lua script that runs
 * entirely on Redis's thread. The Node.js side just sends the script
 * and reads the result.
 */

const Redis = require('ioredis');

// ═══════════════════════════════════════════════════════════════════════════════
// LUA SCRIPTS — These run atomically on Redis's single thread
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Token Bucket — Lua script
 * 
 * Uses a Redis hash to store { tokens, lastRefill } per client.
 * Performs lazy refill calculation, then checks/decrements atomically.
 * 
 * KEYS[1] = client key (e.g., "ratelime:tb:192.168.1.1")
 * ARGV[1] = capacity (max tokens)
 * ARGV[2] = refillRate (tokens per millisecond, as string for precision)
 * ARGV[3] = now (current timestamp in ms)
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Get current state from Redis hash
local tokens = tonumber(redis.call('HGET', key, 'tokens'))
local lastRefill = tonumber(redis.call('HGET', key, 'lastRefill'))

if tokens == nil then
    -- New client: start with a full bucket
    tokens = capacity
    lastRefill = now
else
    -- Lazy refill: calculate tokens added since last check
    local elapsed = now - lastRefill
    if elapsed > 0 then
        tokens = math.min(capacity, tokens + elapsed * refillRate)
        lastRefill = now
    end
end

local allowed = 0
local remaining = 0

if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
    remaining = math.floor(tokens)
end

-- Save state back to Redis
redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefill', tostring(lastRefill))

-- Set TTL so keys don't live forever for inactive clients
local ttlSec = math.ceil(capacity / refillRate / 1000) + 60
redis.call('EXPIRE', key, ttlSec)

-- Calculate resetAt
local resetAt = now
if tokens < 1 then
    resetAt = now + math.ceil((1 - tokens) / refillRate)
else
    resetAt = now + math.ceil(capacity / refillRate)
end

return {allowed, remaining, tostring(resetAt)}
`;

/**
 * Fixed Window — Lua script
 * 
 * Uses a Redis hash to store { count, windowStart } per client.
 * Resets the counter when the window expires.
 * 
 * KEYS[1] = client key
 * ARGV[1] = limit (max requests per window)
 * ARGV[2] = windowMs
 * ARGV[3] = now
 */
const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local windowStart = tonumber(redis.call('HGET', key, 'windowStart'))
local count = tonumber(redis.call('HGET', key, 'count'))

if windowStart == nil or (now - windowStart) >= windowMs then
    windowStart = now
    count = 0
end

local resetAt = windowStart + windowMs
local allowed = 0
local remaining = 0

if count < limit then
    count = count + 1
    allowed = 1
    remaining = limit - count
end

redis.call('HSET', key, 'windowStart', tostring(windowStart), 'count', tostring(count))

local ttlSec = math.ceil(windowMs / 1000) + 60
redis.call('EXPIRE', key, ttlSec)

return {allowed, remaining, tostring(resetAt)}
`;

/**
 * Sliding Window Log — Lua script
 * 
 * Uses a Redis Sorted Set (ZSET) — the perfect data structure for this.
 * Each request timestamp is a member with its value as the score.
 * ZREMRANGEBYSCORE efficiently prunes old entries.
 * ZCARD gives the count in O(1).
 * 
 * This is more efficient than the in-memory array approach because
 * Redis sorted sets use skip lists internally — O(log n) insert/delete.
 * 
 * KEYS[1] = client key
 * ARGV[1] = limit
 * ARGV[2] = windowMs
 * ARGV[3] = now
 * ARGV[4] = unique request ID (to avoid ZSET dedup on same-ms requests)
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local reqId = ARGV[4]

local windowStart = now - windowMs

-- Prune timestamps outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', tostring(windowStart))

-- Count remaining
local count = redis.call('ZCARD', key)

local allowed = 0
local remaining = 0

if count < limit then
    -- Add this request (score = timestamp, member = unique ID)
    redis.call('ZADD', key, tostring(now), reqId)
    count = count + 1
    allowed = 1
    remaining = limit - count
end

local ttlSec = math.ceil(windowMs / 1000) + 60
redis.call('EXPIRE', key, ttlSec)

-- ResetAt: when the oldest entry in the window expires
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = now + windowMs
if #oldest >= 2 then
    resetAt = tonumber(oldest[2]) + windowMs
end

return {allowed, remaining, tostring(resetAt)}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// REDIS STORAGE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class RedisStorage {
    /**
     * @param {Object} [options] - ioredis connection options
     * @param {string} [options.host='localhost']
     * @param {number} [options.port=6379]
     * @param {string} [options.password]
     * @param {string} [options.keyPrefix='ratelime:'] - prefix for all keys
     */
    constructor(options = {}) {
        this.keyPrefix = options.keyPrefix || 'ratelime:';
        this.client = new Redis({
            host: options.host || 'localhost',
            port: options.port || 6379,
            password: options.password,
            // Don't throw on connection error — let health checks handle it
            lazyConnect: true,
            maxRetriesPerRequest: 1,
        });
        this._requestCounter = 0;
    }

    /**
     * Connect to Redis. Call this before using the storage.
     */
    async connect() {
        await this.client.connect();
    }

    /**
     * Check if Redis is reachable.
     */
    async ping() {
        const result = await this.client.ping();
        return result === 'PONG';
    }

    /**
     * Run the Token Bucket algorithm atomically on Redis.
     * 
     * @param {string} clientId
     * @param {Object} options
     * @param {number} options.limit - bucket capacity
     * @param {number} options.windowMs - full refill time in ms
     * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
     */
    async tokenBucketCheck(clientId, { limit, windowMs }) {
        const key = `${this.keyPrefix}tb:${clientId}`;
        const refillRate = limit / windowMs;
        const now = Date.now();

        const result = await this.client.eval(
            TOKEN_BUCKET_SCRIPT,
            1,          // number of KEYS
            key,        // KEYS[1]
            limit,      // ARGV[1]
            refillRate, // ARGV[2]
            now         // ARGV[3]
        );

        return {
            allowed: result[0] === 1,
            remaining: result[1],
            resetAt: parseInt(result[2], 10),
        };
    }

    /**
     * Run the Fixed Window algorithm atomically on Redis.
     */
    async fixedWindowCheck(clientId, { limit, windowMs }) {
        const key = `${this.keyPrefix}fw:${clientId}`;
        const now = Date.now();

        const result = await this.client.eval(
            FIXED_WINDOW_SCRIPT,
            1,
            key,
            limit,
            windowMs,
            now
        );

        return {
            allowed: result[0] === 1,
            remaining: result[1],
            resetAt: parseInt(result[2], 10),
        };
    }

    /**
     * Run the Sliding Window Log algorithm atomically on Redis.
     */
    async slidingWindowCheck(clientId, { limit, windowMs }) {
        const key = `${this.keyPrefix}sw:${clientId}`;
        const now = Date.now();
        // Unique ID to prevent ZSET dedup for same-millisecond requests
        const reqId = `${now}:${++this._requestCounter}`;

        const result = await this.client.eval(
            SLIDING_WINDOW_SCRIPT,
            1,
            key,
            limit,
            windowMs,
            now,
            reqId
        );

        return {
            allowed: result[0] === 1,
            remaining: result[1],
            resetAt: parseInt(result[2], 10),
        };
    }

    /**
     * Generic check — dispatches to the right algorithm.
     * This is what the middleware calls.
     */
    async check(algorithm, clientId, { limit, windowMs }) {
        switch (algorithm) {
            case 'token-bucket':
                return this.tokenBucketCheck(clientId, { limit, windowMs });
            case 'fixed-window':
                return this.fixedWindowCheck(clientId, { limit, windowMs });
            case 'sliding-window':
                return this.slidingWindowCheck(clientId, { limit, windowMs });
            default:
                throw new Error(`Unknown algorithm: ${algorithm}`);
        }
    }

    /**
     * Delete a client's rate limit state.
     */
    async reset(clientId, algorithm) {
        const prefixes = { 'token-bucket': 'tb', 'fixed-window': 'fw', 'sliding-window': 'sw' };
        const prefix = prefixes[algorithm] || 'tb';
        await this.client.del(`${this.keyPrefix}${prefix}:${clientId}`);
    }

    /**
     * Close the Redis connection.
     */
    async close() {
        await this.client.quit();
    }
}

module.exports = { RedisStorage };
