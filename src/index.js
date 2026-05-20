/**
 * RateMesh — Distributed API Rate Limiting Engine
 * 
 * Main entry point. Import everything from here.
 * 
 * Usage:
 *   const { RateMesh } = require('ratemesh');
 *   const limiter = new RateMesh({ limit: 100, window: 60000 });
 *   app.use(limiter.middleware());
 */

// The main middleware class (what most developers use)
const { RateMesh } = require('./middleware/RateMesh');

// Individual algorithms (for advanced usage or direct access)
const { FixedWindow } = require('./algorithms/FixedWindow');
const { SlidingWindowLog } = require('./algorithms/SlidingWindowLog');
const { TokenBucket } = require('./algorithms/TokenBucket');
const { BaseRateLimiter } = require('./algorithms/BaseRateLimiter');

// Storage backends
const { MemoryStorage } = require('./storage/MemoryStorage');
const { RedisStorage } = require('./storage/RedisStorage');

// Core data structure
const { LRUCache } = require('./cache/LRUCache');

// Metrics
const { MetricsCollector } = require('./metrics/MetricsCollector');

module.exports = {
    // Primary export
    RateMesh,

    // Algorithms
    FixedWindow,
    SlidingWindowLog,
    TokenBucket,
    BaseRateLimiter,

    // Storage
    MemoryStorage,
    RedisStorage,

    // Data structures
    LRUCache,

    // Metrics
    MetricsCollector,
};
