/**
 * MetricsCollector — Simple, zero-dependency metrics for RateMesh.
 * 
 * No Prometheus, no AppSignal, no external service needed.
 * Just a plain JavaScript class that counts things.
 * 
 * WHY BUILT-IN:
 * A rate limiter library shouldn't force you to install a monitoring stack.
 * This collector tracks the numbers internally. You read them however you want:
 *   - Call getMetrics() and log to console
 *   - Pipe to AppSignal, Datadog, or any APM
 *   - Expose at a /metrics endpoint in your API
 *   - Ignore entirely (zero overhead if you don't read them)
 * 
 * WHAT IT TRACKS:
 *   - Total requests (allowed vs denied) per algorithm
 *   - Latency percentiles (p50, p95, p99)
 *   - Top denied clients (for abuse detection)
 *   - Active client count
 */

class MetricsCollector {
    constructor() {
        // Counters
        this.totalAllowed = 0;
        this.totalDenied = 0;

        // Per-algorithm counters
        this.byAlgorithm = {};

        // Latency tracking (circular buffer for memory efficiency)
        this._latencies = [];
        this._maxLatencySamples = 10000; // keep last 10k samples

        // Top denied clients
        this._deniedByClient = new Map();

        // Timeline — requests per second (last 60 seconds)
        this._timeline = new Array(60).fill(0);
        this._timelineIndex = 0;
        this._lastTimelineSecond = Math.floor(Date.now() / 1000);

        this.startedAt = Date.now();
    }

    /**
     * Record a rate limit check result.
     * Called internally by the RateMesh middleware.
     * 
     * @param {Object} params
     * @param {string} params.algorithm  - 'token-bucket', 'fixed-window', 'sliding-window'
     * @param {string} params.clientId   - The client identifier
     * @param {boolean} params.allowed   - Whether the request was allowed
     * @param {number} params.latencyMs  - How long the check took in milliseconds
     */
    record({ algorithm, clientId, allowed, latencyMs }) {
        // Total counters
        if (allowed) {
            this.totalAllowed++;
        } else {
            this.totalDenied++;
            // Track denied clients
            this._deniedByClient.set(
                clientId,
                (this._deniedByClient.get(clientId) || 0) + 1
            );
        }

        // Per-algorithm counters
        if (!this.byAlgorithm[algorithm]) {
            this.byAlgorithm[algorithm] = { allowed: 0, denied: 0 };
        }
        if (allowed) {
            this.byAlgorithm[algorithm].allowed++;
        } else {
            this.byAlgorithm[algorithm].denied++;
        }

        // Latency sample (circular buffer)
        if (this._latencies.length >= this._maxLatencySamples) {
            this._latencies[this._latencies.length % this._maxLatencySamples] = latencyMs;
        } else {
            this._latencies.push(latencyMs);
        }

        // Timeline — requests per second
        this._updateTimeline();
    }

    /**
     * Update the requests-per-second timeline.
     */
    _updateTimeline() {
        const now = Math.floor(Date.now() / 1000);
        const elapsed = now - this._lastTimelineSecond;

        if (elapsed > 0) {
            // Zero out any seconds we skipped
            for (let i = 0; i < Math.min(elapsed, 60); i++) {
                this._timelineIndex = (this._timelineIndex + 1) % 60;
                this._timeline[this._timelineIndex] = 0;
            }
            this._lastTimelineSecond = now;
        }

        this._timeline[this._timelineIndex]++;
    }

    /**
     * Calculate a percentile from the latency samples.
     */
    _percentile(sorted, p) {
        if (sorted.length === 0) return 0;
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    /**
     * Get all metrics as a plain object.
     * 
     * @returns {Object} Metrics snapshot
     * 
     * Example output:
     * {
     *   uptime: 3600,
     *   requests: { total: 50000, allowed: 48500, denied: 1500, denyRate: '3.00%' },
     *   latency: { p50: 0.2, p95: 1.1, p99: 3.4, max: 12.1 },
     *   byAlgorithm: { 'token-bucket': { allowed: 48500, denied: 1500 } },
     *   topDeniedClients: [ { clientId: '192.168.1.50', denials: 200 }, ... ],
     *   requestsPerSecond: 14,
     * }
     */
    getMetrics() {
        const total = this.totalAllowed + this.totalDenied;
        const sorted = [...this._latencies].sort((a, b) => a - b);

        // Top 10 most denied clients
        const topDenied = [...this._deniedByClient.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([clientId, denials]) => ({ clientId, denials }));

        // Current requests per second (average of last 10 seconds)
        const recentSeconds = this._timeline.slice(
            Math.max(0, this._timelineIndex - 9),
            this._timelineIndex + 1
        );
        const rps = recentSeconds.length > 0
            ? Math.round(recentSeconds.reduce((a, b) => a + b, 0) / recentSeconds.length)
            : 0;

        return {
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            requests: {
                total,
                allowed: this.totalAllowed,
                denied: this.totalDenied,
                denyRate: total > 0 ? ((this.totalDenied / total) * 100).toFixed(2) + '%' : '0.00%',
            },
            latency: {
                p50: this._percentile(sorted, 50),
                p95: this._percentile(sorted, 95),
                p99: this._percentile(sorted, 99),
                max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
            },
            byAlgorithm: { ...this.byAlgorithm },
            topDeniedClients: topDenied,
            requestsPerSecond: rps,
        };
    }

    /**
     * Reset all metrics. Useful for testing or periodic resets.
     */
    reset() {
        this.totalAllowed = 0;
        this.totalDenied = 0;
        this.byAlgorithm = {};
        this._latencies = [];
        this._deniedByClient.clear();
        this._timeline.fill(0);
        this.startedAt = Date.now();
    }
}

module.exports = { MetricsCollector };
