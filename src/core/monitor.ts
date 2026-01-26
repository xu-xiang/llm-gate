export interface RequestStats {
    total: number;
    success: number;
    error: number;
    rateLimited: number;
    lastRequestTime?: Date;
}

class Monitor {
    private stats: RequestStats = {
        total: 0,
        success: 0,
        error: 0,
        rateLimited: 0
    };

    private startTime: Date = new Date();

    recordRequest(status: 'success' | 'error' | 'ratelimit') {
        this.stats.total++;
        this.stats.lastRequestTime = new Date();
        if (status === 'success') this.stats.success++;
        else if (status === 'error') this.stats.error++;
        else if (status === 'ratelimit') this.stats.rateLimited++;
    }

    getStats() {
        return {
            ...this.stats,
            uptime: Math.floor((new Date().getTime() - this.startTime.getTime()) / 1000)
        };
    }
}

export const monitor = new Monitor();
