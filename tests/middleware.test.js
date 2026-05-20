const express = require('express');
const request = require('supertest');
const { RateLime } = require('../src/middleware/RateLime');

// ─── Helper: fake time control ───────────────────────────────────────────────
let mockNow;

function setMockTime(ms) {
    mockNow = ms;
    jest.spyOn(Date, 'now').mockReturnValue(ms);
}

function advanceTime(ms) {
    mockNow += ms;
    Date.now.mockReturnValue(mockNow);
}

afterEach(() => {
    jest.restoreAllMocks();
});

// ─── Helper: create an Express app with RateLime ─────────────────────────────
function createApp(RateLimeOptions, routes) {
    const app = express();
    const limiter = new RateLime(RateLimeOptions);

    // Apply middleware
    if (routes) {
        // Route-specific middleware
        for (const [method, path, ...handlers] of routes) {
            const mw = handlers.length > 1 ? handlers[0] : limiter.middleware();
            const handler = handlers.length > 1 ? handlers[1] : handlers[0];
            app[method](path, mw, handler);
        }
    } else {
        // Global middleware
        app.use(limiter.middleware());
        app.get('/test', (req, res) => res.json({ message: 'ok' }));
        app.get('/api/data', (req, res) => res.json({ data: 'hello' }));
        app.post('/api/auth/login', (req, res) => res.json({ token: 'abc' }));
    }

    return { app, limiter };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASIC MIDDLEWARE BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe('RateLime Middleware', () => {

    describe('basic rate limiting', () => {
        test('allows requests under the limit', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                storage: 'memory',
                limit: 5,
                window: 60000,
            });

            const res = await request(app).get('/test');
            expect(res.status).toBe(200);
            expect(res.body.message).toBe('ok');
        });

        test('returns 429 when limit exceeded', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                storage: 'memory',
                limit: 3,
                window: 60000,
            });

            // Use up all 3 tokens
            await request(app).get('/test');
            await request(app).get('/test');
            await request(app).get('/test');

            // 4th request should be denied
            const res = await request(app).get('/test');
            expect(res.status).toBe(429);
            expect(res.body.error).toBe('Rate limit exceeded');
            expect(res.body.retryAfter).toBeGreaterThan(0);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // RESPONSE HEADERS
    // ═══════════════════════════════════════════════════════════════════════════

    describe('response headers', () => {
        test('sets X-RateLimit-Limit header', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 100,
                window: 60000,
            });

            const res = await request(app).get('/test');
            expect(res.headers['x-ratelimit-limit']).toBe('100');
        });

        test('sets X-RateLimit-Remaining header', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 5,
                window: 60000,
            });

            const res = await request(app).get('/test');
            expect(res.headers['x-ratelimit-remaining']).toBe('4'); // 5 - 1
        });

        test('sets X-RateLimit-Reset header', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 5,
                window: 60000,
            });

            const res = await request(app).get('/test');
            expect(res.headers['x-ratelimit-reset']).toBeDefined();
            // Should be a Unix timestamp in seconds
            const resetAt = parseInt(res.headers['x-ratelimit-reset'], 10);
            expect(resetAt).toBeGreaterThan(1000);
        });

        test('sets Retry-After header on 429', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 1,
                window: 60000,
            });

            await request(app).get('/test'); // use the 1 token
            const res = await request(app).get('/test');

            expect(res.status).toBe(429);
            expect(res.headers['retry-after']).toBeDefined();
            const retryAfter = parseInt(res.headers['retry-after'], 10);
            expect(retryAfter).toBeGreaterThanOrEqual(1);
        });

        test('remaining decreases with each request', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 5,
                window: 60000,
            });

            const r1 = await request(app).get('/test');
            const r2 = await request(app).get('/test');
            const r3 = await request(app).get('/test');

            expect(r1.headers['x-ratelimit-remaining']).toBe('4');
            expect(r2.headers['x-ratelimit-remaining']).toBe('3');
            expect(r3.headers['x-ratelimit-remaining']).toBe('2');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ALL THREE ALGORITHMS
    // ═══════════════════════════════════════════════════════════════════════════

    describe('algorithm selection', () => {
        const algorithms = ['token-bucket', 'fixed-window', 'sliding-window'];

        test.each(algorithms)('%s — allows then denies', async (algorithm) => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm,
                limit: 2,
                window: 60000,
            });

            const r1 = await request(app).get('/test');
            const r2 = await request(app).get('/test');
            const r3 = await request(app).get('/test');

            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            expect(r3.status).toBe(429);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CUSTOM KEY GENERATOR
    // ═══════════════════════════════════════════════════════════════════════════

    describe('custom key generator', () => {
        test('uses custom keyGenerator to identify clients', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 2,
                window: 60000,
                // Use X-API-Key header instead of IP
                keyGenerator: (req) => req.headers['x-api-key'] || 'anonymous',
            });

            // key-A gets 2 requests
            await request(app).get('/test').set('X-API-Key', 'key-A');
            await request(app).get('/test').set('X-API-Key', 'key-A');
            const r3 = await request(app).get('/test').set('X-API-Key', 'key-A');
            expect(r3.status).toBe(429);

            // key-B is a different client — should be allowed
            const r4 = await request(app).get('/test').set('X-API-Key', 'key-B');
            expect(r4.status).toBe(200);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // RULES (route-specific limits)
    // ═══════════════════════════════════════════════════════════════════════════

    describe('rules', () => {
        test('applies stricter limits to matching routes', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                rules: [
                    { limit: 100, window: 60000 },                      // global: generous
                    { match: '/api/auth/*', limit: 2, window: 60000 },  // auth: strict
                ],
            });

            // Auth endpoint gets the stricter limit
            await request(app).post('/api/auth/login');
            await request(app).post('/api/auth/login');
            const authRes = await request(app).post('/api/auth/login');
            expect(authRes.status).toBe(429);

            // Data endpoint uses the global limit (still has capacity)
            const dataRes = await request(app).get('/api/data');
            expect(dataRes.status).toBe(200);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // MIDDLEWARE OVERRIDES
    // ═══════════════════════════════════════════════════════════════════════════

    describe('middleware overrides', () => {
        test('per-route overrides via middleware(options)', async () => {
            setMockTime(1000000);
            const limiter = new RateLime({
                algorithm: 'token-bucket',
                limit: 100,
                window: 60000,
            });

            const app = express();
            // This route gets a strict override
            app.post('/login', limiter.middleware({ limit: 2 }), (req, res) => {
                res.json({ ok: true });
            });

            await request(app).post('/login');
            await request(app).post('/login');
            const res = await request(app).post('/login');
            expect(res.status).toBe(429);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CUSTOM DENY HANDLER
    // ═══════════════════════════════════════════════════════════════════════════

    describe('custom onDenied handler', () => {
        test('uses custom deny response', async () => {
            setMockTime(1000000);
            const { app } = createApp({
                algorithm: 'token-bucket',
                limit: 1,
                window: 60000,
                onDenied: (req, res) => {
                    res.status(429).json({
                        custom: true,
                        message: 'Slow down!',
                    });
                },
            });

            await request(app).get('/test');
            const res = await request(app).get('/test');

            expect(res.status).toBe(429);
            expect(res.body.custom).toBe(true);
            expect(res.body.message).toBe('Slow down!');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ERROR HANDLING (fail-open)
    // ═══════════════════════════════════════════════════════════════════════════

    describe('error handling', () => {
        test('fails open when algorithm throws', async () => {
            setMockTime(1000000);
            const limiter = new RateLime({
                algorithm: 'token-bucket',
                limit: 5,
                window: 60000,
            });

            // Sabotage the internal engine to simulate failure
            for (const [, engine] of limiter._engines) {
                engine.isAllowed = () => { throw new Error('boom'); };
            }

            const app = express();
            app.use(limiter.middleware());
            app.get('/test', (req, res) => res.json({ ok: true }));

            // Should fail open — request goes through despite error
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            const res = await request(app).get('/test');
            expect(res.status).toBe(200);
            consoleSpy.mockRestore();
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════

    describe('constructor', () => {
        test('defaults to token-bucket + memory', () => {
            const limiter = new RateLime();
            expect(limiter.algorithm).toBe('token-bucket');
            expect(limiter.storageType).toBe('memory');
        });

        test('throws on unknown algorithm', () => {
            expect(() => new RateLime({ algorithm: 'bogus' })).toThrow();
        });
    });
});
