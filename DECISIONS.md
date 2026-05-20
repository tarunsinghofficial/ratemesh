# Architectural Decisions

Every engineering choice in RateMesh is documented here with the problem, decision, trade-off, and reasoning. This is the document interviewers care about — it shows you think in trade-offs, not just code.

---

## 1. Why Token Bucket Over Fixed Window

**Problem:** Fixed Window Counter has a boundary race condition.

A client can send `limit` requests at the end of window 1, then `limit` more at the start of window 2 — getting 2× the intended rate in a few seconds.

**Demonstration (from our tests):**
```
Limit: 5 requests per 60 seconds

t=0s:   Window 1 starts
t=59s:  Client sends 5 requests → ALL ALLOWED (window 1 has capacity)
t=60s:  Window 2 starts, counter resets to 0
t=60.1s: Client sends 5 more → ALL ALLOWED (new window)

Result: 10 requests in ~1 second with a "5 per 60s" limit.
```

**Decision:** Token Bucket as the default/recommended algorithm.

**Why Token Bucket wins:**
- **O(1) memory per client** — just 2 numbers (tokens + lastRefillTime)
- **No boundary flaw** — tokens refill continuously, not at discrete boundaries
- **Handles bursts naturally** — bucket fills during quiet periods, absorbs spikes
- **Industry standard** — used by Stripe, AWS API Gateway, most production systems

**Trade-off:** Slightly more complex refill calculation than a simple counter. Worth it for correctness.

---

## 2. Why Sliding Window Log Exists (But Isn't Default)

**Problem:** Some systems need exact precision — "did this client exceed N requests in the last M seconds?" answered precisely.

**Decision:** Implement Sliding Window Log as an option, but not the default.

**Why it's not default:**
```
Memory per client = O(number of requests in window)

10,000 requests/window × 8 bytes/timestamp = 80KB per client
100,000 clients × 80KB = 8GB of memory

vs Token Bucket:
100,000 clients × 16 bytes = 1.6MB of memory
```

That's a 5,000× difference.

**When to use it:** Compliance-sensitive rate limiting, audit logging, systems where precision matters more than memory.

---

## 3. Why LRU Eviction for In-Memory Storage

**Problem:** You can't hold every client in memory forever. With millions of unique IPs hitting your API, memory grows unbounded.

**Decision:** LRU (Least Recently Used) cache with configurable capacity.

**Why LRU:**
- Active clients (recent requests) stay in cache → accurate rate limiting
- Idle clients (no recent requests) get evicted → bounded memory
- All operations are O(1) — HashMap for lookup, Doubly Linked List for order tracking

**Implementation:** Hand-built from scratch (no `lru-cache` npm package). HashMap + Doubly Linked List with sentinel nodes.

**Trade-off:** When a client is evicted and comes back, their counter resets. This is acceptable for rate limiting because:
1. If they were idle long enough to be evicted, their window/tokens would have reset anyway
2. The alternative (keeping everyone) means unbounded memory

---

## 4. Why Redis Lua Scripts Over MULTI/EXEC Transactions

**Problem:** When you have multiple Node.js instances, they share rate limit state via Redis. But separate GET + SET commands create a race condition:

```
Server A: GET tokens → 1
Server B: GET tokens → 1      ← reads same stale value!
Server A: SET tokens → 0
Server B: SET tokens → 0      ← both think they used the last token
Result: 2 requests allowed, but only 1 token was available
```

Redis MULTI/EXEC transactions don't help here — they batch commands but don't prevent interleaving reads from other clients.

**Decision:** Lua scripts executed via `EVAL`.

**Why:**
- Redis is single-threaded
- A Lua script runs to completion without interruption
- The entire read-check-write happens atomically
- No other command can see intermediate state

```lua
-- This entire block executes atomically on Redis's thread
local tokens = redis.call('HGET', key, 'tokens')
if tokens >= 1 then
    redis.call('HSET', key, 'tokens', tokens - 1)
    return 1  -- ALLOW
else
    return 0  -- DENY
end
```

**Trade-off:** Lua adds complexity to the codebase. Worth it for distributed correctness — this is the one thing you can't get wrong in a rate limiter.

---

## 5. Why Separate Storage Backends (Pluggable Architecture)

**Problem:** Single-server in-memory LRU doesn't work when you scale to multiple Node.js instances.

**Decision:** Pluggable storage — `memory` for single-server, `redis` for distributed.

```javascript
// Same code, different storage — just change one config field
new RateMesh({ storage: 'memory', ... })  // development, single server
new RateMesh({ storage: 'redis', ... })   // production, multi-server
```

**Why not just use Redis always?**
- Redis adds ~2-5ms latency per request
- Requires running a Redis instance (operational overhead)
- For single-server deployments, in-memory is faster and simpler
- For development/testing, no Docker dependency needed

**Trade-off:** Two code paths to maintain. Mitigated by shared interface and comprehensive tests.

---

## 6. Why Fail-Open on Errors

**Problem:** What happens when Redis goes down? Two options:
1. **Fail open** — allow the request through (rate limiting stops, but API works)
2. **Fail closed** — deny the request (rate limiting is enforced, but API is down)

**Decision:** Fail open.

**Why:**
- Rate limiting is a **protection layer**, not a core business function
- If Redis dies, your API should still serve requests
- A brief window without rate limiting is better than a complete outage
- You can add alerting on the error logs to detect the issue quickly

**Trade-off:** During a Redis outage, clients can exceed their rate limits. For most APIs, this is acceptable. For billing-critical systems, you might want fail-closed — RateMesh logs the error so you can make that decision.

---

## 7. Why Built-In Metrics (No Prometheus/External Dependencies)

**Problem:** Monitoring rate limiter behavior is important, but forcing a specific monitoring stack is not.

**Decision:** Zero-dependency MetricsCollector built into the library.

**What it tracks:**
- Total requests (allowed/denied) per algorithm
- Latency percentiles (p50, p95, p99)
- Top denied clients (abuse detection)
- Requests per second

**Why not Prometheus/AppSignal/Datadog?**
- A library shouldn't dictate your monitoring stack
- Zero config needed — metrics work out of the box
- Consumers can pipe `getMetrics()` output to any APM they already use
- No extra dependency to install, configure, or maintain

**Trade-off:** Less feature-rich than dedicated monitoring. The metrics are in-process (not persisted). Good enough for 99% of use cases.

---

## 8. Why Sorted Sets for Sliding Window on Redis

**Problem:** The in-memory Sliding Window Log uses a JavaScript array of timestamps. On Redis, arrays aren't a native data type.

**Decision:** Redis Sorted Sets (ZSET) for the Redis implementation.

**Why ZSET is perfect for this:**
- `ZADD` to insert timestamps (score = timestamp, O(log n))
- `ZREMRANGEBYSCORE` to prune old timestamps efficiently (O(log n + k))
- `ZCARD` to count remaining entries (O(1))
- All wrapped in a Lua script for atomicity

**Trade-off:** O(log n) insert vs O(1) for the array approach. At the scale where this matters, you'd be using Token Bucket anyway (O(1) everything).
