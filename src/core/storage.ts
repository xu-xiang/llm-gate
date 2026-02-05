import { KVNamespace } from '@cloudflare/workers-types';

export interface IStorage {
    get(key: string): Promise<any | null>;
    set(key: string, value: any, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    
    // Distributed Lock
    // Returns lock token if acquired, null otherwise
    acquireLock(key: string, ttlSeconds: number): Promise<string | null>;
    releaseLock(key: string, token: string): Promise<void>;

    // List keys (for dynamic discovery)
    list(prefix?: string): Promise<string[]>;
}

export class KVStorage implements IStorage {
    private kv: KVNamespace;

    constructor(kv: KVNamespace) {
        this.kv = kv;
    }

    async get(key: string): Promise<any | null> {
        return await this.kv.get(key, 'json');
    }

    async set(key: string, value: any, options?: { expirationTtl?: number }): Promise<void> {
        await this.kv.put(key, JSON.stringify(value), options);
    }

    async delete(key: string): Promise<void> {
        await this.kv.delete(key);
    }

    async list(prefix?: string): Promise<string[]> {
        const list = await this.kv.list({ prefix });
        return list.keys.map(k => k.name);
    }

    async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
        const lockToken = crypto.randomUUID();
        const lockKey = `lock:${key}`;
        
        // Check if lock exists
        const existing = await this.kv.get(lockKey);
        if (existing) {
            return null;
        }

        // Attempt to set lock
        await this.kv.put(lockKey, lockToken, { expirationTtl: ttlSeconds });

        // Verify we won the race
        const verify = await this.kv.get(lockKey);
        if (verify === lockToken) {
            return lockToken;
        }
        
        return null;
    }

    async releaseLock(key: string, token: string): Promise<void> {
        const lockKey = `lock:${key}`;
        const current = await this.kv.get(lockKey);
        if (current === token) {
            await this.kv.delete(lockKey);
        }
    }
}

// 简单的内存存储，用于兜底或测试
export class MemoryStorage implements IStorage {
    private store: Map<string, any> = new Map();
    private locks: Map<string, string> = new Map();

    async get(key: string): Promise<any | null> {
        return this.store.get(key) || null;
    }

    async set(key: string, value: any, options?: { expirationTtl?: number }): Promise<void> {
        this.store.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.store.delete(key);
    }

    async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
        const lockKey = `lock:${key}`;
        if (this.locks.has(lockKey)) return null;
        
        const token = crypto.randomUUID();
        this.locks.set(lockKey, token);
        
        // Mock TTL
        setTimeout(() => {
            if (this.locks.get(lockKey) === token) {
                this.locks.delete(lockKey);
            }
        }, ttlSeconds * 1000);

        return token;
    }

    async releaseLock(key: string, token: string): Promise<void> {
        const lockKey = `lock:${key}`;
        if (this.locks.get(lockKey) === token) {
            this.locks.delete(lockKey);
        }
    }

    async list(prefix?: string): Promise<string[]> {
        return Array.from(this.store.keys()).filter(k => !prefix || k.startsWith(prefix));
    }
}
