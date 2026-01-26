import fs from 'fs-extra';
import path from 'path';

export interface DailyUsage {
    [date: string]: {
        [providerId: string]: number;
    };
}

class QuotaManager {
    private storagePath = path.resolve(process.cwd(), 'usage_stats.json');
    private usageData: DailyUsage = {};
        private dailyLimit = 2000;
        private rpmLimit = 60;
        private rpmData: { [providerId: string]: { count: number, minute: number } } = {};
    
        constructor() {
            this.load();
        }
    
        private getBeijingDate(): string {
            // 获取北京时间 (UTC+8) 的日期字符串 YYYY-MM-DD
            const now = new Date();
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const beijingTime = new Date(utc + (3600000 * 8));
            return beijingTime.toISOString().split('T')[0];
        }
    
        private async load() {
            try {
                if (fs.existsSync(this.storagePath)) {
                    this.usageData = await fs.readJson(this.storagePath);
                }
            } catch (e) {
                console.error('Failed to load usage stats', e);
            }
        }
    
        private async save() {
            try {
                await fs.writeJson(this.storagePath, this.usageData, { spaces: 2 });
            }
            catch (e) {
                console.error('Failed to save usage stats', e);
            }
        }
    
        public async incrementUsage(providerId: string) {
            const date = this.getBeijingDate();
            const now = new Date();
            const currentMinute = Math.floor(now.getTime() / 60000);
    
            // Daily Usage
            if (!this.usageData[date]) {
                this.usageData[date] = {};
            }
            if (!this.usageData[date][providerId]) {
                this.usageData[date][providerId] = 0;
            }
            this.usageData[date][providerId]++;
    
            // RPM Usage (In-memory)
            if (!this.rpmData[providerId] || this.rpmData[providerId].minute !== currentMinute) {
                this.rpmData[providerId] = { count: 0, minute: currentMinute };
            }
            this.rpmData[providerId].count++;
    
            await this.save();
        }
    
        public getUsage(providerId: string) {
            const date = this.getBeijingDate();
            const now = new Date();
            const currentMinute = Math.floor(now.getTime() / 60000);
    
            const dailyCount = (this.usageData[date] && this.usageData[date][providerId]) || 0;
            
            const rpmEntry = this.rpmData[providerId];
            const rpmCount = (rpmEntry && rpmEntry.minute === currentMinute) ? rpmEntry.count : 0;
    
            return {
                daily: {
                    used: dailyCount,
                    limit: this.dailyLimit,
                    percent: Math.min(100, (dailyCount / this.dailyLimit) * 100)
                },
                rpm: {
                    used: rpmCount,
                    limit: this.rpmLimit,
                    percent: Math.min(100, (rpmCount / this.rpmLimit) * 100)
                }
            };
        }
    }

export const quotaManager = new QuotaManager();
