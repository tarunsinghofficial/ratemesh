const { FixedWindow } = require('../src/algorithms/FixedWindow');
const { SlidingWindowLog } = require('../src/algorithms/SlidingWindowLog');
const { TokenBucket } = require('../src/algorithms/TokenBucket');
const { BaseRateLimiter } = require('../src/algorithms/BaseRateLimiter');

// ─── Helper: fake time control ───────────────────────────────────────────────
// We need to control Date.now() to test window boundaries and token refills
// without waiting real seconds. Jest's fake timers handle setTimeout/setInterval,
// but we need to manually mock Date.now() for our "lazy" calculations.

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

// ═══════════════════════════════════════════════════════════════════════════════
// BASE RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════════════

describe('BaseRateLimiter', () => {
    test('throws if isAllowed() is not implemented', () => {
        const base = new BaseRateLimiter({ limit: 10, windowMs: 60000 });
        expect(() => base.isAllowed('client1')).toThrow('Subclass must implement');
    });

    test('throws if reset() is not implemented', () => {
        const base = new BaseRateLimiter({ limit: 10, windowMs: 60000 });
        expect(() => base.reset('client1')).toThrow('Subclass must implement');
    });

    test('throws on invalid limit', () => {
        expect(() => new BaseRateLimiter({ limit: 0, windowMs: 60000 })).toThrow();
        expect(() => new BaseRateLimiter({ limit: -1, windowMs: 60000 })).toThrow();
    });

    test('throws on invalid windowMs', () => {
        expect(() => new BaseRateLimiter({ limit: 10, windowMs: 0 })).toThrow();
        expect(() => new BaseRateLimiter({ limit: 10, windowMs: -1 })).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIXED WINDOW COUNTER
// ═══════════════════════════════════════════════════════════════════════════════

describe('FixedWindow', () => {
    let limiter;

    beforeEach(() => {
        setMockTime(1000000); // start at a known time
        limiter = new FixedWindow({ limit: 5, windowMs: 60000 });
    });

    describe('basic behavior', () => {
        test('allows requests under the limit', () => {
            for (let i = 0; i < 5; i++) {
                const result = limiter.isAllowed('client1');
                expect(result.allowed).toBe(true);
            }
        });

        test('denies requests over the limit', () => {
            // Use up all 5 tokens
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            // 6th should be denied
            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });

        test('remaining decreases correctly', () => {
            expect(limiter.isAllowed('client1').remaining).toBe(4); // 5 - 1 = 4
            expect(limiter.isAllowed('client1').remaining).toBe(3);
            expect(limiter.isAllowed('client1').remaining).toBe(2);
            expect(limiter.isAllowed('client1').remaining).toBe(1);
            expect(limiter.isAllowed('client1').remaining).toBe(0);
        });

        test('returns correct resetAt timestamp', () => {
            const result = limiter.isAllowed('client1');
            expect(result.resetAt).toBe(1000000 + 60000); // windowStart + windowMs
        });
    });

    describe('window reset', () => {
        test('resets counter after window expires', () => {
            // Use up all tokens
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            // Advance past the window
            advanceTime(60001);

            // Should be allowed again — fresh window
            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(4); // 5 - 1
        });
    });

    describe('multi-client isolation', () => {
        test('tracks clients independently', () => {
            // Exhaust client1
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            // client2 should be unaffected
            expect(limiter.isAllowed('client2').allowed).toBe(true);
        });
    });

    describe('reset method', () => {
        test('reset clears a client state', () => {
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            limiter.reset('client1');
            expect(limiter.isAllowed('client1').allowed).toBe(true);
        });
    });

    // ┌─────────────────────────────────────────────────────────────────────────┐
    // │  THE BOUNDARY FLAW — This is the key test.                             │
    // │  This demonstrates WHY Fixed Window is unsuitable for production.      │
    // │  Put this in your DECISIONS.md and explain it in interviews.           │
    // └─────────────────────────────────────────────────────────────────────────┘
    describe('⚠️  BOUNDARY FLAW (the reason we move to better algorithms)', () => {
        test('allows 2x the limit across a window boundary', () => {
            const fw = new FixedWindow({ limit: 5, windowMs: 60000 });

            // First, start a window at t=0 by making one request
            setMockTime(0);
            fw.isAllowed('attacker'); // starts window at t=0

            // Send 4 more at the END of window 1 (t = 59s), total = 5 in window 1
            setMockTime(59000);
            for (let i = 0; i < 4; i++) {
                expect(fw.isAllowed('attacker').allowed).toBe(true);
            }
            // Window 1 is now full (5 requests)
            expect(fw.isAllowed('attacker').allowed).toBe(false);

            // Send 5 requests at the START of window 2 (t = 60001)
            // Only ~1 second has passed since the burst, but the counter resets!
            setMockTime(60001);
            for (let i = 0; i < 5; i++) {
                expect(fw.isAllowed('attacker').allowed).toBe(true);
            }

            // RESULT: 10 requests in ~1 second with a "5 per 60s" limit!
            // This is the fundamental flaw of fixed windows.
            // An attacker who knows your window boundaries can double their throughput.
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDING WINDOW LOG
// ═══════════════════════════════════════════════════════════════════════════════

describe('SlidingWindowLog', () => {
    let limiter;

    beforeEach(() => {
        setMockTime(1000000);
        limiter = new SlidingWindowLog({ limit: 5, windowMs: 60000 });
    });

    describe('basic behavior', () => {
        test('allows requests under the limit', () => {
            for (let i = 0; i < 5; i++) {
                expect(limiter.isAllowed('client1').allowed).toBe(true);
            }
        });

        test('denies requests over the limit', () => {
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });

        test('remaining decreases correctly', () => {
            expect(limiter.isAllowed('client1').remaining).toBe(4);
            expect(limiter.isAllowed('client1').remaining).toBe(3);
            expect(limiter.isAllowed('client1').remaining).toBe(2);
            expect(limiter.isAllowed('client1').remaining).toBe(1);
            expect(limiter.isAllowed('client1').remaining).toBe(0);
        });
    });

    describe('sliding behavior (no boundary flaw!)', () => {
        test('does NOT allow 2x the limit at window boundary', () => {
            const sw = new SlidingWindowLog({ limit: 5, windowMs: 60000 });

            // Send 5 requests at t=59s
            setMockTime(59000);
            for (let i = 0; i < 5; i++) {
                sw.isAllowed('attacker');
            }

            // Try 5 more at t=61s — only 2s later!
            // Sliding window looks back 60s from NOW (t=61s → window covers t=1s to t=61s)
            // The 5 timestamps from t=59s are STILL in the window.
            setMockTime(61000);
            for (let i = 0; i < 5; i++) {
                expect(sw.isAllowed('attacker').allowed).toBe(false);
            }
            // FIXED! Sliding window correctly blocks the attacker.
        });

        test('allows requests once old timestamps expire', () => {
            // Fill up
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            // Advance past the window — old timestamps get pruned
            advanceTime(60001);
            expect(limiter.isAllowed('client1').allowed).toBe(true);
        });

        test('gradual expiry — timestamps expire one by one', () => {
            // Send 5 requests, 10s apart
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
                if (i < 4) advanceTime(10000); // 10s between each
            }
            // Now at t = 1040000 (base + 40s)
            // Timestamps: [1000000, 1010000, 1020000, 1030000, 1040000]

            expect(limiter.isAllowed('client1').allowed).toBe(false); // all 5 in window

            // Advance 21s → t=1061000. Window covers [1001000, 1061000].
            // Timestamp at 1000000 has expired! Only 4 in window now.
            advanceTime(21000);
            expect(limiter.isAllowed('client1').allowed).toBe(true);
        });
    });

    describe('multi-client isolation', () => {
        test('tracks clients independently', () => {
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);
            expect(limiter.isAllowed('client2').allowed).toBe(true);
        });
    });

    describe('reset method', () => {
        test('reset clears a client state', () => {
            for (let i = 0; i < 5; i++) {
                limiter.isAllowed('client1');
            }
            limiter.reset('client1');
            expect(limiter.isAllowed('client1').allowed).toBe(true);
        });
    });

    // ┌─────────────────────────────────────────────────────────────────────────┐
    // │  THE MEMORY PROBLEM — This is the key trade-off.                       │
    // │  Sliding Window Log stores EVERY timestamp. Memory grows O(requests).  │
    // │  Put this number in your BENCHMARKS.md.                                │
    // └─────────────────────────────────────────────────────────────────────────┘
    describe('⚠️  MEMORY GROWTH (the reason we prefer Token Bucket)', () => {
        test('memory grows with request count', () => {
            const sw = new SlidingWindowLog({ limit: 10000, windowMs: 60000 });

            setMockTime(1000000);

            // Send 1000 requests from the same client
            for (let i = 0; i < 1000; i++) {
                sw.isAllowed('heavy-client');
            }

            // The log stores ALL 1000 timestamps
            expect(sw.getLogSize('heavy-client')).toBe(1000);

            // Compare: Fixed Window would store just 1 number (count = 1000)
            // Compare: Token Bucket would store just 2 numbers (tokens, lastRefillTime)
            // This is O(n) memory per client — unacceptable at scale.
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN BUCKET
// ═══════════════════════════════════════════════════════════════════════════════

describe('TokenBucket', () => {
    let limiter;

    beforeEach(() => {
        setMockTime(1000000);
        limiter = new TokenBucket({ limit: 10, windowMs: 60000 });
        // capacity = 10, refillRate = 10/60000 ≈ 0.000167 tokens/ms
    });

    describe('basic behavior', () => {
        test('allows requests under the limit', () => {
            for (let i = 0; i < 10; i++) {
                expect(limiter.isAllowed('client1').allowed).toBe(true);
            }
        });

        test('denies requests when bucket is empty', () => {
            // Drain the bucket
            for (let i = 0; i < 10; i++) {
                limiter.isAllowed('client1');
            }
            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });

        test('remaining decreases correctly', () => {
            expect(limiter.isAllowed('client1').remaining).toBe(9); // 10 - 1
            expect(limiter.isAllowed('client1').remaining).toBe(8);
            expect(limiter.isAllowed('client1').remaining).toBe(7);
        });

        test('new clients start with a full bucket', () => {
            const result = limiter.isAllowed('brand-new-client');
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(9); // started with 10, used 1
        });
    });

    describe('token refill (the key mechanism)', () => {
        test('tokens refill over time', () => {
            // Drain the bucket completely
            for (let i = 0; i < 10; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            // Wait for enough time to refill 1 token
            // refillRate = 10/60000 tokens/ms
            // Time for 1 token = 1 / refillRate = 6000ms
            advanceTime(6000);

            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(true);
        });

        test('tokens do not exceed capacity', () => {
            // Wait a very long time — bucket should cap at capacity
            advanceTime(120000); // 2 full windows

            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(9); // capped at 10, used 1 = 9
        });

        test('partial refill — fractional tokens accumulate', () => {
            // Drain the bucket
            for (let i = 0; i < 10; i++) {
                limiter.isAllowed('client1');
            }

            // Wait for half-token worth of time (3000ms = 0.5 tokens)
            advanceTime(3000);
            expect(limiter.isAllowed('client1').allowed).toBe(false); // 0.5 < 1

            // Wait another 3500ms (total 6500ms = 1.08 tokens)
            advanceTime(3500);
            expect(limiter.isAllowed('client1').allowed).toBe(true); // 1.08 >= 1
        });
    });

    describe('burst handling (why Token Bucket is great)', () => {
        test('allows bursts up to capacity after quiet period', () => {
            // Client is quiet for a while — bucket fills up
            // (already full since it's a new client)

            // Now they burst: send 10 requests rapidly
            let allowedCount = 0;
            for (let i = 0; i < 10; i++) {
                if (limiter.isAllowed('bursty-client').allowed) {
                    allowedCount++;
                }
            }

            // All 10 should be allowed (burst absorbed by full bucket)
            expect(allowedCount).toBe(10);

            // But the 11th should be denied (bucket drained)
            expect(limiter.isAllowed('bursty-client').allowed).toBe(false);
        });
    });

    describe('no boundary flaw', () => {
        test('does NOT allow 2x the limit at any boundary', () => {
            const tb = new TokenBucket({ limit: 5, windowMs: 60000 });

            setMockTime(59000);
            for (let i = 0; i < 5; i++) {
                tb.isAllowed('attacker');
            }

            // 2 seconds later — bucket has refilled only ~0.17 tokens
            // 2000ms * (5/60000) = 0.167 tokens
            setMockTime(61000);
            expect(tb.isAllowed('attacker').allowed).toBe(false);

            // Token Bucket doesn't have window boundaries.
            // It would take 12 seconds to refill 1 token (1 / (5/60000) = 12000ms).
        });
    });

    describe('multi-client isolation', () => {
        test('tracks clients independently', () => {
            // Drain client1
            for (let i = 0; i < 10; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            // client2 is unaffected — their own full bucket
            const result = limiter.isAllowed('client2');
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(9); // 10 - 1 = 9
        });
    });

    describe('reset method', () => {
        test('reset gives client a fresh full bucket', () => {
            for (let i = 0; i < 10; i++) {
                limiter.isAllowed('client1');
            }
            expect(limiter.isAllowed('client1').allowed).toBe(false);

            limiter.reset('client1');

            const result = limiter.isAllowed('client1');
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(9); // fresh bucket: 10 - 1
        });
    });

    describe('O(1) memory per client', () => {
        test('state size is constant regardless of request count', () => {
            // Send 1000 requests from same client
            const tb = new TokenBucket({ limit: 10000, windowMs: 60000 });
            for (let i = 0; i < 1000; i++) {
                tb.isAllowed('heavy-client');
            }

            // Peek at the state — it's always just 2 numbers
            const state = tb.cache.peek('heavy-client');
            expect(Object.keys(state)).toEqual(['tokens', 'lastRefillTime']);
            // Compare: SlidingWindowLog would store 1000 timestamps here
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALGORITHM COMPARISON (cross-cutting tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Algorithm Comparison', () => {
    const algorithms = [
        { name: 'FixedWindow', create: (opts) => new FixedWindow(opts) },
        { name: 'SlidingWindowLog', create: (opts) => new SlidingWindowLog(opts) },
        { name: 'TokenBucket', create: (opts) => new TokenBucket(opts) },
    ];

    describe.each(algorithms)('$name', ({ create }) => {
        test('respects the limit for a single client', () => {
            setMockTime(1000000);
            const limiter = create({ limit: 3, windowMs: 60000 });

            expect(limiter.isAllowed('c1').allowed).toBe(true);
            expect(limiter.isAllowed('c1').allowed).toBe(true);
            expect(limiter.isAllowed('c1').allowed).toBe(true);
            expect(limiter.isAllowed('c1').allowed).toBe(false);
        });

        test('returns consistent response shape', () => {
            setMockTime(1000000);
            const limiter = create({ limit: 5, windowMs: 60000 });
            const result = limiter.isAllowed('c1');

            expect(result).toHaveProperty('allowed');
            expect(result).toHaveProperty('remaining');
            expect(result).toHaveProperty('resetAt');
            expect(typeof result.allowed).toBe('boolean');
            expect(typeof result.remaining).toBe('number');
            expect(typeof result.resetAt).toBe('number');
        });
    });

    test('performance — 100k isAllowed calls under 500ms each', () => {
        setMockTime(1000000);

        for (const { name, create } of algorithms) {
            const limiter = create({ limit: 100000, windowMs: 60000 });
            const start = performance.now();

            for (let i = 0; i < 100000; i++) {
                limiter.isAllowed(`client_${i % 1000}`);
            }

            const elapsed = performance.now() - start;
            // All three should handle 100k ops well under 500ms
            expect(elapsed).toBeLessThan(500);
        }
    });
});
