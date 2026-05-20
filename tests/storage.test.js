const { MemoryStorage } = require('../src/storage/MemoryStorage');

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY STORAGE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('MemoryStorage', () => {
    let storage;

    beforeEach(() => {
        storage = new MemoryStorage({ maxClients: 5 });
    });

    describe('basic operations', () => {
        test('get returns null for missing key', async () => {
            expect(await storage.get('missing')).toBeNull();
        });

        test('set and get a value', async () => {
            await storage.set('client1', { tokens: 10 });
            expect(await storage.get('client1')).toEqual({ tokens: 10 });
        });

        test('set overwrites existing value', async () => {
            await storage.set('client1', { tokens: 10 });
            await storage.set('client1', { tokens: 5 });
            expect(await storage.get('client1')).toEqual({ tokens: 5 });
        });

        test('delete removes a key', async () => {
            await storage.set('client1', { tokens: 10 });
            expect(await storage.delete('client1')).toBe(true);
            expect(await storage.get('client1')).toBeNull();
        });

        test('delete returns false for missing key', async () => {
            expect(await storage.delete('missing')).toBe(false);
        });

        test('has returns true for existing key', async () => {
            await storage.set('client1', { tokens: 10 });
            expect(await storage.has('client1')).toBe(true);
        });

        test('has returns false for missing key', async () => {
            expect(await storage.has('missing')).toBe(false);
        });

        test('size reflects entries', async () => {
            await storage.set('a', 1);
            await storage.set('b', 2);
            expect(storage.size()).toBe(2);
        });
    });

    describe('LRU eviction', () => {
        test('evicts least recently used when at capacity', async () => {
            // Capacity is 5
            await storage.set('a', 1);
            await storage.set('b', 2);
            await storage.set('c', 3);
            await storage.set('d', 4);
            await storage.set('e', 5);
            await storage.set('f', 6); // should evict 'a'

            expect(await storage.get('a')).toBeNull();
            expect(await storage.get('f')).toBe(6);
        });

        test('accessing a key prevents its eviction', async () => {
            await storage.set('a', 1);
            await storage.set('b', 2);
            await storage.set('c', 3);
            await storage.set('d', 4);
            await storage.set('e', 5);

            await storage.get('a'); // moves 'a' to most recent
            await storage.set('f', 6); // should evict 'b', not 'a'

            expect(await storage.get('a')).toBe(1);
            expect(await storage.get('b')).toBeNull();
        });
    });

    describe('clear and close', () => {
        test('clear empties all entries', async () => {
            await storage.set('a', 1);
            await storage.set('b', 2);
            await storage.clear();
            expect(storage.size()).toBe(0);
        });

        test('close is a no-op (does not throw)', async () => {
            await expect(storage.close()).resolves.toBeUndefined();
        });
    });

    describe('async interface compatibility', () => {
        test('all methods return promises', () => {
            expect(storage.get('x')).toBeInstanceOf(Promise);
            expect(storage.set('x', 1)).toBeInstanceOf(Promise);
            expect(storage.delete('x')).toBeInstanceOf(Promise);
            expect(storage.has('x')).toBeInstanceOf(Promise);
            expect(storage.clear()).toBeInstanceOf(Promise);
            expect(storage.close()).toBeInstanceOf(Promise);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REDIS STORAGE TESTS
// These only run if Redis is available. Skipped otherwise.
// ═══════════════════════════════════════════════════════════════════════════════

const { RedisStorage } = require('../src/storage/RedisStorage');

describe('RedisStorage', () => {
    let redis;
    let redisAvailable = false;

    beforeAll(async () => {
        redis = new RedisStorage({
            host: 'localhost',
            port: 6379,
            keyPrefix: 'ratemesh:test:',
        });
        try {
            await redis.connect();
            redisAvailable = await redis.ping();
        } catch (e) {
            redisAvailable = false;
        }
    });

    afterAll(async () => {
        if (redisAvailable) {
            // Clean up test keys
            const keys = await redis.client.keys('ratemesh:test:*');
            if (keys.length > 0) {
                await redis.client.del(...keys);
            }
            await redis.close();
        }
    });

    // Helper to skip tests when Redis isn't running
    const redisTest = (...args) => {
        if (redisAvailable) {
            test(...args);
        } else {
            test.skip(...args);
        }
    };

    describe('Token Bucket (Redis)', () => {
        redisTest('allows requests under the limit', async () => {
            const result = await redis.tokenBucketCheck('redis-tb-1', {
                limit: 5,
                windowMs: 60000,
            });
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(4);
            expect(typeof result.resetAt).toBe('number');
        });

        redisTest('denies when bucket is empty', async () => {
            for (let i = 0; i < 5; i++) {
                await redis.tokenBucketCheck('redis-tb-2', {
                    limit: 5,
                    windowMs: 60000,
                });
            }
            const result = await redis.tokenBucketCheck('redis-tb-2', {
                limit: 5,
                windowMs: 60000,
            });
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });
    });

    describe('Fixed Window (Redis)', () => {
        redisTest('allows requests under the limit', async () => {
            const result = await redis.fixedWindowCheck('redis-fw-1', {
                limit: 5,
                windowMs: 60000,
            });
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(4);
        });

        redisTest('denies over the limit', async () => {
            for (let i = 0; i < 5; i++) {
                await redis.fixedWindowCheck('redis-fw-2', {
                    limit: 5,
                    windowMs: 60000,
                });
            }
            const result = await redis.fixedWindowCheck('redis-fw-2', {
                limit: 5,
                windowMs: 60000,
            });
            expect(result.allowed).toBe(false);
        });
    });

    describe('Sliding Window (Redis)', () => {
        redisTest('allows requests under the limit', async () => {
            const result = await redis.slidingWindowCheck('redis-sw-1', {
                limit: 5,
                windowMs: 60000,
            });
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(4);
        });

        redisTest('denies over the limit', async () => {
            for (let i = 0; i < 5; i++) {
                await redis.slidingWindowCheck('redis-sw-2', {
                    limit: 5,
                    windowMs: 60000,
                });
            }
            const result = await redis.slidingWindowCheck('redis-sw-2', {
                limit: 5,
                windowMs: 60000,
            });
            expect(result.allowed).toBe(false);
        });
    });

    describe('Generic check dispatch', () => {
        redisTest('dispatches to correct algorithm', async () => {
            const tbResult = await redis.check('token-bucket', 'redis-dispatch-tb', {
                limit: 10, windowMs: 60000,
            });
            expect(tbResult.allowed).toBe(true);

            const fwResult = await redis.check('fixed-window', 'redis-dispatch-fw', {
                limit: 10, windowMs: 60000,
            });
            expect(fwResult.allowed).toBe(true);

            const swResult = await redis.check('sliding-window', 'redis-dispatch-sw', {
                limit: 10, windowMs: 60000,
            });
            expect(swResult.allowed).toBe(true);
        });

        redisTest('throws on unknown algorithm', async () => {
            await expect(
                redis.check('unknown-algo', 'client1', { limit: 10, windowMs: 60000 })
            ).rejects.toThrow('Unknown algorithm');
        });
    });

    describe('Atomicity (the whole point of Lua scripts)', () => {
        redisTest('concurrent requests with 1 token — only 1 allowed', async () => {
            // Give the client exactly 1 token by draining to 1
            for (let i = 0; i < 4; i++) {
                await redis.tokenBucketCheck('redis-race-1', {
                    limit: 5,
                    windowMs: 60000,
                });
            }
            // 1 token remaining

            // Fire 3 concurrent requests — only 1 should succeed
            const results = await Promise.all([
                redis.tokenBucketCheck('redis-race-1', { limit: 5, windowMs: 60000 }),
                redis.tokenBucketCheck('redis-race-1', { limit: 5, windowMs: 60000 }),
                redis.tokenBucketCheck('redis-race-1', { limit: 5, windowMs: 60000 }),
            ]);

            const allowed = results.filter(r => r.allowed).length;
            const denied = results.filter(r => !r.allowed).length;

            // Exactly 1 should be allowed (Lua script atomicity guarantees this)
            expect(allowed).toBe(1);
            expect(denied).toBe(2);
        });
    });
});
