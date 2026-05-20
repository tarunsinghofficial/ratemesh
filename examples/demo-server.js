/**
 * RateMesh Demo Server
 * 
 * A quick demo showing RateMesh in action.
 * Run: node examples/demo-server.js
 * Test: curl -i http://localhost:3000/api/data (hit it rapidly to see 429s)
 */

const express = require('express');
const { RateMesh } = require('../src/index');

const app = express();
const PORT = 3000;

// ─── Create the rate limiter ─────────────────────────────────────────────────
const limiter = new RateMesh({
    algorithm: 'token-bucket',
    storage: 'memory',
    limit: 10,           // 10 requests per minute
    window: 60 * 1000,   // 1 minute
});

// ─── Apply globally ──────────────────────────────────────────────────────────
app.use(limiter.middleware());

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        name: 'RateMesh Demo',
        routes: {
            'GET /api/data': 'Rate limited (10 req/min)',
            'POST /api/auth/login': 'Strictly rate limited (3 req/min)',
            'GET /metrics': 'View rate limiter metrics',
        },
    });
});

app.get('/api/data', (req, res) => {
    res.json({ data: 'Hello from RateMesh!', timestamp: new Date().toISOString() });
});

// Stricter limit for auth endpoints
app.post('/api/auth/login', limiter.middleware({ limit: 3 }), (req, res) => {
    res.json({ token: 'demo-jwt-token' });
});

// Metrics endpoint — see how the rate limiter is doing
app.get('/metrics', (req, res) => {
    res.json(limiter.getMetrics());
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 RateMesh Demo running on http://localhost:${PORT}`);
    console.log(`\nTry these:`);
    console.log(`  curl -i http://localhost:${PORT}/api/data      # hit rapidly to see 429`);
    console.log(`  curl -X POST http://localhost:${PORT}/api/auth/login  # only 3/min`);
    console.log(`  curl http://localhost:${PORT}/metrics           # view metrics\n`);
});
