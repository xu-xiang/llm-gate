export interface RequestStats {
    total: number;
    success: number;
    error: number;
    rateLimited: number;
    lastRequestTime?: Date;
}

export interface MonitorStats {
    chat: RequestStats;
    search: RequestStats;
}

class Monitor {
    private stats: MonitorStats = {
        chat: {
            total: 0,
            success: 0,
            error: 0,
            rateLimited: 0
        },
        search: {
            total: 0,
            success: 0,
            error: 0,
            rateLimited: 0
        }
    };

    private startTime: Date = new Date();

    recordRequest(status: 'success' | 'error' | 'ratelimit', kind: 'chat' | 'search' = 'chat') {
        const target = this.stats[kind];
        target.total++;
        target.lastRequestTime = new Date();
        if (status === 'success') target.success++;
        else if (status === 'error') target.error++;
        else if (status === 'ratelimit') target.rateLimited++;
    }

    getStats() {
        return {
            ...this.stats,
            uptime: Math.floor((new Date().getTime() - this.startTime.getTime()) / 1000)
        };
    }
}

export const monitor = new Monitor();
