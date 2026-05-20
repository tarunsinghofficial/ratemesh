const { MetricsCollector } = require('../src/metrics/MetricsCollector');
const { RateMesh } = require('../src/middleware/RateMesh');
const express = require('express');
const request = require('supertest');

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COLLECTOR (standalone)
// ═══════════════════════════════════════════════════════════════════════════════

describe('MetricsCollector', () => {
    let metrics;

    beforeEach(() => {
        metrics = new MetricsCollector();
    });

    test('starts with zero counters', () => {
        const m = metrics.getMetrics();
        expect(m.requests.total).toBe(0);
        expect(m.requests.allowed).toBe(0);
        expect(m.requests.denied).toBe(0);
        expect(m.requests.denyRate).toBe('0.00%');
    });

    test('records allowed requests', () => {
        metrics.record({ algorithm: 'token-bucket', clientId: 'c1', allowed: true, latencyMs: 1 });
        metrics.record({ algorithm: 'token-bucket', clientId: 'c2', allowed: true, latencyMs: 2 });

        const m = metrics.getMetrics();
        expect(m.requests.total).toBe(2);
        expect(m.requests.allowed).toBe(2);
        expect(m.requests.denied).toBe(0);
    });

    test('records denied requests', () => {
        metrics.record({ algorithm: 'token-bucket', clientId: 'c1', allowed: false, latencyMs: 1 });

        const m = metrics.getMetrics();
        expect(m.requests.denied).toBe(1);
        expect(m.requests.denyRate).toBe('100.00%');
    });

    test('tracks per-algorithm stats', () => {
        metrics.record({ algorithm: 'token-bucket', clientId: 'c1', allowed: true, latencyMs: 1 });
        metrics.record({ algorithm: 'fixed-window', clientId: 'c1', allowed: false, latencyMs: 1 });

        const m = metrics.getMetrics();
        expect(m.byAlgorithm['token-bucket'].allowed).toBe(1);
        expect(m.byAlgorithm['fixed-window'].denied).toBe(1);
    });

    test('calculates latency percentiles', () => {
        // Record 100 latency samples from 1ms to 100ms
        for (let i = 1; i <= 100; i++) {
            metrics.record({ algorithm: 'tb', clientId: 'c1', allowed: true, latencyMs: i });
        }

        const m = metrics.getMetrics();
        expect(m.latency.p50).toBe(50);
        expect(m.latency.p95).toBe(95);
        expect(m.latency.p99).toBe(99);
        expect(m.latency.max).toBe(100);
    });

    test('tracks top denied clients', () => {
        for (let i = 0; i < 10; i++) {
            metrics.record({ algorithm: 'tb', clientId: 'abuser', allowed: false, latencyMs: 1 });
        }
        for (let i = 0; i < 3; i++) {
            metrics.record({ algorithm: 'tb', clientId: 'mild', allowed: false, latencyMs: 1 });
        }

        const m = metrics.getMetrics();
        expect(m.topDeniedClients[0].clientId).toBe('abuser');
        expect(m.topDeniedClients[0].denials).toBe(10);
        expect(m.topDeniedClients[1].clientId).toBe('mild');
    });

    test('reset clears all metrics', () => {
        metrics.record({ algorithm: 'tb', clientId: 'c1', allowed: true, latencyMs: 1 });
        metrics.reset();

        const m = metrics.getMetrics();
        expect(m.requests.total).toBe(0);
        expect(m.latency.max).toBe(0);
    });

    test('reports uptime', () => {
        const m = metrics.getMetrics();
        expect(m.uptime).toBeGreaterThanOrEqual(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS INTEGRATION WITH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

describe('RateMesh + Metrics Integration', () => {
    let mockNow;

    function setMockTime(ms) {
        mockNow = ms;
        jest.spyOn(Date, 'now').mockReturnValue(ms);
    }

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('middleware records metrics automatically', async () => {
        setMockTime(1000000);
        const limiter = new RateMesh({
            algorithm: 'token-bucket',
            limit: 3,
            window: 60000,
        });

        const app = express();
        app.use(limiter.middleware());
        app.get('/test', (req, res) => res.json({ ok: true }));

        // 3 allowed + 1 denied
        await request(app).get('/test');
        await request(app).get('/test');
        await request(app).get('/test');
        await request(app).get('/test');

        const m = limiter.getMetrics();
        expect(m.requests.allowed).toBe(3);
        expect(m.requests.denied).toBe(1);
        expect(m.byAlgorithm['token-bucket'].allowed).toBe(3);
        expect(m.byAlgorithm['token-bucket'].denied).toBe(1);
    });

    test('resetMetrics clears middleware metrics', async () => {
        setMockTime(1000000);
        const limiter = new RateMesh({ limit: 5, window: 60000 });

        const app = express();
        app.use(limiter.middleware());
        app.get('/test', (req, res) => res.json({ ok: true }));

        await request(app).get('/test');
        expect(limiter.getMetrics().requests.total).toBe(1);

        limiter.resetMetrics();
        expect(limiter.getMetrics().requests.total).toBe(0);
    });
});
