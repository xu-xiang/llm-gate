import fs from 'fs-extra';
import path from 'path';

type UsageByType = { chat: number; search: number };

export interface DailyUsage {
    [date: string]: {
        [providerId: string]: UsageByType | number;
    };
}

class QuotaManager {
    private storagePath = path.resolve(process.cwd(), 'usage_stats.json');
    private usageData: DailyUsage = {};
    private chatDailyLimit = 2000;
    private chatRpmLimit = 60;
    private searchDailyLimit = 0;
    private searchRpmLimit = 0;
    private rpmData: {
        [providerId: string]: {
            chat?: { count: number; minute: number };
            search?: { count: number; minute: number };
        };
    } = {};
    
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
    
        public setLimits(limits: {
            chat?: { daily?: number; rpm?: number };
            search?: { daily?: number; rpm?: number };
        }) {
            if (typeof limits.chat?.daily === 'number') this.chatDailyLimit = limits.chat.daily;
            if (typeof limits.chat?.rpm === 'number') this.chatRpmLimit = limits.chat.rpm;
            if (typeof limits.search?.daily === 'number') this.searchDailyLimit = limits.search.daily;
            if (typeof limits.search?.rpm === 'number') this.searchRpmLimit = limits.search.rpm;
        }

        private ensureUsageEntry(date: string, providerId: string): UsageByType {
            if (!this.usageData[date]) {
                this.usageData[date] = {};
            }
            const existing = this.usageData[date][providerId];
            if (typeof existing === 'number') {
                const converted = { chat: existing, search: 0 };
                this.usageData[date][providerId] = converted;
                return converted;
            }
            if (!existing) {
                const created = { chat: 0, search: 0 };
                this.usageData[date][providerId] = created;
                return created;
            }
            return existing as UsageByType;
        }

        public async incrementUsage(providerId: string, kind: 'chat' | 'search' = 'chat') {
            const date = this.getBeijingDate();
            const now = new Date();
            const currentMinute = Math.floor(now.getTime() / 60000);
    
            // Daily Usage
            const usage = this.ensureUsageEntry(date, providerId);
            usage[kind]++;
    
            // RPM Usage (In-memory)
            if (!this.rpmData[providerId]) {
                this.rpmData[providerId] = {};
            }
            const bucket = this.rpmData[providerId][kind];
            if (!bucket || bucket.minute !== currentMinute) {
                this.rpmData[providerId][kind] = { count: 0, minute: currentMinute };
            }
            this.rpmData[providerId][kind]!.count++;
    
            await this.save();
        }
    
        public getUsage(providerId: string) {
            const date = this.getBeijingDate();
            const now = new Date();
            const currentMinute = Math.floor(now.getTime() / 60000);
    
            const usage = this.ensureUsageEntry(date, providerId);
            
            const rpmEntry = this.rpmData[providerId];
            const chatRpmCount =
                rpmEntry?.chat && rpmEntry.chat.minute === currentMinute ? rpmEntry.chat.count : 0;
            const searchRpmCount =
                rpmEntry?.search && rpmEntry.search.minute === currentMinute ? rpmEntry.search.count : 0;

            const chatDailyPercent =
                this.chatDailyLimit > 0 ? Math.min(100, (usage.chat / this.chatDailyLimit) * 100) : 0;
            const chatRpmPercent =
                this.chatRpmLimit > 0 ? Math.min(100, (chatRpmCount / this.chatRpmLimit) * 100) : 0;
            const searchDailyPercent =
                this.searchDailyLimit > 0 ? Math.min(100, (usage.search / this.searchDailyLimit) * 100) : 0;
            const searchRpmPercent =
                this.searchRpmLimit > 0 ? Math.min(100, (searchRpmCount / this.searchRpmLimit) * 100) : 0;
    
            return {
                chat: {
                    daily: {
                        used: usage.chat,
                        limit: this.chatDailyLimit,
                        percent: chatDailyPercent
                    },
                    rpm: {
                        used: chatRpmCount,
                        limit: this.chatRpmLimit,
                        percent: chatRpmPercent
                    }
                },
                search: {
                    daily: {
                        used: usage.search,
                        limit: this.searchDailyLimit,
                        percent: searchDailyPercent
                    },
                    rpm: {
                        used: searchRpmCount,
                        limit: this.searchRpmLimit,
                        percent: searchRpmPercent
                    }
                }
            };
        }
    }

export const quotaManager = new QuotaManager();
