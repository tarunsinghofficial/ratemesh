const { LRUCache } = require('../src/cache/LRUCache');

describe('LRUCache', () => {

    describe('basic operations', () => {
        test('get on empty cache returns null', () => {
            const cache = new LRUCache(3);
            expect(cache.get('a')).toBeNull();
        });

        test('put and get single item', () => {
            const cache = new LRUCache(3);
            cache.put('ip_1', { tokens: 10 });
            expect(cache.get('ip_1')).toEqual({ tokens: 10 });
        });

        test('put updates existing key value', () => {
            const cache = new LRUCache(3);
            cache.put('ip_1', { tokens: 10 });
            cache.put('ip_1', { tokens: 7 });
            expect(cache.get('ip_1')).toEqual({ tokens: 7 });
        });

        test('size reflects actual count', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            cache.put('b', 2);
            expect(cache.size()).toBe(2);
        });
    });

    describe('eviction', () => {
        test('evicts LRU item when at capacity', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            cache.put('b', 2);
            cache.put('c', 3);
            cache.put('d', 4); // should evict 'a'
            
            expect(cache.get('a')).toBeNull(); // evicted
            expect(cache.get('b')).toBe(2);
            expect(cache.get('c')).toBe(3);
            expect(cache.get('d')).toBe(4);
        });

        test('put returns evicted key', () => {
            const cache = new LRUCache(2);
            cache.put('a', 1);
            cache.put('b', 2);
            const evicted = cache.put('c', 3);
            expect(evicted).toBe('a');
        });

        test('put returns null when no eviction', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            const evicted = cache.put('b', 2);
            expect(evicted).toBeNull();
        });

        test('accessing item prevents its eviction', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            cache.put('b', 2);
            cache.put('c', 3);
            
            cache.get('a'); // 'a' is now most recent, 'b' is LRU
            cache.put('d', 4); // should evict 'b', not 'a'
            
            expect(cache.get('a')).toBe(1); // still here
            expect(cache.get('b')).toBeNull(); // evicted
        });

        test('capacity of 1 works correctly', () => {
            const cache = new LRUCache(1);
            cache.put('a', 1);
            cache.put('b', 2);
            expect(cache.get('a')).toBeNull();
            expect(cache.get('b')).toBe(2);
        });
    });

    describe('order tracking', () => {
        test('keys() returns most-recent to least-recent', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            cache.put('b', 2);
            cache.put('c', 3);
            expect(cache.keys()).toEqual(['c', 'b', 'a']);
        });

        test('get moves key to most recent', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            cache.put('b', 2);
            cache.put('c', 3);
            cache.get('a'); // 'a' becomes most recent
            expect(cache.keys()).toEqual(['a', 'c', 'b']);
        });
    });

    describe('delete and clear', () => {
        test('delete removes existing key', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            expect(cache.delete('a')).toBe(true);
            expect(cache.get('a')).toBeNull();
        });

        test('delete returns false for missing key', () => {
            const cache = new LRUCache(3);
            expect(cache.delete('nonexistent')).toBe(false);
        });

        test('clear empties the cache', () => {
            const cache = new LRUCache(3);
            cache.put('a', 1);
            cache.put('b', 2);
            cache.clear();
            expect(cache.size()).toBe(0);
            expect(cache.get('a')).toBeNull();
        });
    });

    describe('peek', () => {
        test('peek returns value without updating recency', () => {
            const cache = new LRUCache(2);
            cache.put('a', 1);
            cache.put('b', 2);
            cache.peek('a'); // should NOT make 'a' most recent
            cache.put('c', 3); // should evict 'a' (still LRU)
            expect(cache.get('a')).toBeNull(); // evicted correctly
        });
    });

    describe('edge cases', () => {
        test('throws on invalid capacity', () => {
            expect(() => new LRUCache(0)).toThrow();
            expect(() => new LRUCache(-1)).toThrow();
        });

        test('handles 10,000 items correctly', () => {
            const cache = new LRUCache(10000);
            for (let i = 0; i < 10000; i++) {
                cache.put(`client_${i}`, { tokens: 100 });
            }
            expect(cache.size()).toBe(10000);
            expect(cache.get('client_0')).toEqual({ tokens: 100 });
        });
    });
});