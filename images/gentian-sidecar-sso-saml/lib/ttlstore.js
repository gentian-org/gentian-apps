'use strict';

// A small table of things that expire, kept in this process.
//
// Sign-in requests waiting for their answer and assertions already used are
// both held here. Nothing is written anywhere else, so a restart forgets
// them: a sign-in under way then fails closed and the person starts again.
// That is also why the sidecar runs as one replica.

class TtlStore {
    constructor({ maxEntries, now }) {
        this.maxEntries = maxEntries;
        this.now = now || (() => Date.now());
        this.entries = new Map();
    }

    sweep() {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key);
        }
    }

    // False when the table is full of entries that have not run out yet. The
    // caller refuses rather than forgetting something it must remember.
    set(key, value, expiresAt) {
        if (this.entries.size >= this.maxEntries) this.sweep();
        if (this.entries.size >= this.maxEntries && !this.entries.has(key)) return false;
        this.entries.set(key, { value, expiresAt });
        return true;
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    take(key) {
        const value = this.get(key);
        this.entries.delete(key);
        return value;
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    delete(key) {
        this.entries.delete(key);
    }

    get size() {
        return this.entries.size;
    }
}

module.exports = { TtlStore };
