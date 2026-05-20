class Node {
    constructor(key, value) {
        this.key = key;
        this.value = value;
        this.prev = null;
        this.next = null;
    }
}

class LRUCache {
    constructor(capacity) {
        if (!capacity || capacity < 1) {
            throw new Error('Capacity must be a positive integer');
        }

        this.capacity = capacity;
        this.map = new Map();

        this.head = new Node(null, null); // dummy head (most recent side)
        this.tail = new Node(null, null); // dummy tail (eviction side)

        this.head.next = this.tail;
        this.tail.prev = this.head;
    }

    get(key) {
        if (!this.map.has(key)) return null;

        const node = this.map.get(key);
        this._removeNode(node);
        this._addAfterHead(node);
        return node.value;
    }

    put(key, value) {
        if (this.map.has(key)) {
            const node = this.map.get(key);
            node.value = value;
            this._removeNode(node);
            this._addAfterHead(node);
            return null;
        }

        let evictedKey = null;

        if (this.map.size === this.capacity) {
            const lruNode = this.tail.prev;
            this._removeNode(lruNode);
            this.map.delete(lruNode.key);
            evictedKey = lruNode.key;
        }

        const newNode = new Node(key, value);
        this._addAfterHead(newNode);
        this.map.set(key, newNode);

        return evictedKey;
    }

    // Check without updating recency — for metrics/inspection
    peek(key) {
        if (!this.map.has(key)) return null;
        return this.map.get(key).value;
    }

    delete(key) {
        if (!this.map.has(key)) return false;
        const node = this.map.get(key);
        this._removeNode(node);
        this.map.delete(key);
        return true;
    }

    clear() {
        this.map.clear();
        this.head.next = this.tail;
        this.tail.prev = this.head;
    }

    size() {
        return this.map.size;
    }

    // Returns keys from most-recent to least-recent (useful for debugging)
    keys() {
        const result = [];
        let current = this.head.next;
        while (current !== this.tail) {
            result.push(current.key);
            current = current.next;
        }
        return result;
    }

    // Private helpers — underscore convention = internal only
    _removeNode(node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    _addAfterHead(node) {
        node.next = this.head.next;
        node.prev = this.head;
        this.head.next.prev = node;
        this.head.next = node;
    }
}

module.exports = { LRUCache };