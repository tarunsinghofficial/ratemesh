# RateLime

**Distributed API Rate Limiting Engine for Node.js**

A production-grade rate limiter that any Node.js API can use as drop-in middleware. Implements three algorithms (Fixed Window, Sliding Window Log, Token Bucket), supports in-memory and Redis-backed distributed storage, and includes built-in metrics — all with zero external monitoring dependencies.

## Quick Start

### Install

```bash
npm install ratelime
```

### Basic Usage (3 lines)

```javascript
const express = require("express");
const { RateLime } = require("ratelime");

const app = express();
const limiter = new RateLime({ limit: 100, window: 60000 }); // 100 req/min

app.use(limiter.middleware());

app.get("/api/data", (req, res) => res.json({ hello: "world" }));

app.listen(3000);
```

### With Redis (distributed)

```javascript
const limiter = new RateLime({
  algorithm: "token-bucket",
  storage: "redis",
  redis: { host: "localhost", port: 6379 },
  limit: 1000,
  window: 60000,
});

await limiter.connect();
app.use(limiter.middleware());
```

### Route-Specific Rules

```javascript
const limiter = new RateLime({
  algorithm: "token-bucket",
  rules: [
    { limit: 1000, window: 60000 }, // global: 1000/min
    { match: "/api/auth/*", limit: 10, window: 60000 }, // auth: 10/min
  ],
});

app.use(limiter.middleware());

// Or override per-route:
app.post("/api/auth/login", limiter.middleware({ limit: 5 }), loginHandler);
```

### Custom Client Identification

```javascript
const limiter = new RateLime({
  limit: 5000,
  window: 60000,
  keyGenerator: (req) => req.headers["x-api-key"] || req.ip,
});
```

## API Reference

### `new RateLime(options)`

| Option         | Type     | Default           | Description                                               |
| -------------- | -------- | ----------------- | --------------------------------------------------------- |
| `algorithm`    | string   | `'token-bucket'`  | `'token-bucket'`, `'fixed-window'`, or `'sliding-window'` |
| `storage`      | string   | `'memory'`        | `'memory'` or `'redis'`                                   |
| `limit`        | number   | `100`             | Max requests per window                                   |
| `window`       | number   | `60000`           | Window size in milliseconds                               |
| `keyGenerator` | function | `(req) => req.ip` | Extracts client identifier from request                   |
| `redis`        | object   | `{}`              | ioredis connection options (host, port, password)         |
| `rules`        | array    | `[]`              | Route-specific rules (see below)                          |
| `onDenied`     | function | `null`            | Custom 429 response handler `(req, res)`                  |
| `maxClients`   | number   | `10000`           | Max clients in LRU cache (memory mode)                    |

### Rules

```javascript
{
  match: '/api/auth/*',           // glob pattern (null = all routes)
  identifier: (req) => req.ip,    // optional per-rule key extractor
  limit: 10,                      // max requests
  window: 60000,                  // window in ms
}
```

### `limiter.middleware(overrides?)`

Returns Express middleware. Optional `overrides` object with `limit` and `window`.

### `limiter.getMetrics()`

Returns a metrics snapshot:

```javascript
{
  uptime: 3600,
  requests: { total: 50000, allowed: 48500, denied: 1500, denyRate: '3.00%' },
  latency: { p50: 0.2, p95: 1.1, p99: 3.4, max: 12.1 },
  byAlgorithm: { 'token-bucket': { allowed: 48500, denied: 1500 } },
  topDeniedClients: [{ clientId: '192.168.1.50', denials: 200 }],
  requestsPerSecond: 14,
}
```

### Response Headers

Every response includes standard rate limiting headers:

| Header                  | Description                       | When        |
| ----------------------- | --------------------------------- | ----------- |
| `X-RateLimit-Limit`     | Max requests allowed              | Always      |
| `X-RateLimit-Remaining` | Requests left in window           | Always      |
| `X-RateLimit-Reset`     | Unix timestamp when window resets | Always      |
| `Retry-After`           | Seconds until client can retry    | Only on 429 |

## Algorithms

| Algorithm              | Memory/Client       | Boundary-Safe | Best For                          |
| ---------------------- | ------------------- | ------------- | --------------------------------- |
| **Fixed Window**       | O(1) — 2 numbers    | ❌ No         | Simple internal tools             |
| **Sliding Window Log** | O(n) — n timestamps | ✅ Yes        | Audit-critical systems            |
| **Token Bucket**       | O(1) — 2 numbers    | ✅ Yes        | **Production APIs** (recommended) |

See [DECISIONS.md](DECISIONS.md) for detailed trade-off analysis.

## Running with Docker

```bash
# Start Redis
docker compose up -d

# Run all tests (including Redis tests)
npm test

# Try the demo
npm run demo
```

## Project Structure

```
RateLime/
├── src/
│   ├── cache/
│   │   └── LRUCache.js            ← Hand-built HashMap + Doubly Linked List
│   ├── algorithms/
│   │   ├── BaseRateLimiter.js      ← Shared interface
│   │   ├── FixedWindow.js          ← Simplest, has boundary flaw
│   │   ├── SlidingWindowLog.js     ← Most accurate, O(n) memory
│   │   └── TokenBucket.js          ← Production winner
│   ├── storage/
│   │   ├── MemoryStorage.js        ← LRU-backed, single server
│   │   └── RedisStorage.js         ← Lua scripts, distributed
│   ├── middleware/
│   │   └── RateLime.js             ← Express middleware
│   ├── metrics/
│   │   └── MetricsCollector.js     ← Built-in, zero-dependency metrics
│   └── index.js                    ← Main entry point
├── tests/                          ← 106 tests across 5 suites
├── examples/
│   └── demo-server.js              ← Quick demo server
├── docker-compose.yml              ← Redis
├── DECISIONS.md                    ← Architectural decisions
├── BENCHMARKS.md                   ← Algorithm comparison
└── README.md                       ← This file
```

## Documentation

- **[DECISIONS.md](DECISIONS.md)** — Every architectural choice explained with trade-offs
- **[BENCHMARKS.md](BENCHMARKS.md)** — Algorithm comparison with numbers

## License

ISC
