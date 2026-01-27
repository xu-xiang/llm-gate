import { Request, Response } from 'express';
import { LLMProvider } from '../base';
import { QwenProvider, ProviderStatus } from './provider';
import { logger } from '../../core/logger';

export class MultiQwenProvider implements LLMProvider {
    private providers: QwenProvider[] = [];
    private currentIndex = 0;

    constructor(authFiles: string[]) {
        this.providers = authFiles.map(file => new QwenProvider(file));
    }

    async initialize() {
        // Start all initializations in parallel without blocking the main thread
        this.providers.forEach(provider => {
            provider.initialize().catch(err => {
                logger.error(`Background initialization failed for provider ${provider.getStatus().id}`, err);
            });
        });
        
        // Start background recovery loop (every 5 minutes)
        setInterval(() => {
            this.recoverErrorProviders();
        }, 5 * 60 * 1000);

        // Return immediately to allow the server to start
        return Promise.resolve();
    }

    private async recoverErrorProviders() {
        const errorProviders = this.providers.filter(p => p.getStatus().status === 'error');
        if (errorProviders.length > 0) {
            logger.info(`🔄 Attempting auto-recovery for ${errorProviders.length} error providers...`);
            for (const provider of errorProviders) {
                provider.initialize().catch(() => {}); // Attempt re-init
            }
        }
    }

    public getAllProviderStatus(): ProviderStatus[] {
        return this.providers.map(p => p.getStatus());
    }

    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    async handleChatCompletion(req: Request, res: Response): Promise<void> {
        const availableProviders = this.providers.length;
        if (availableProviders === 0) {
            res.status(500).json({ error: 'No Qwen providers configured' });
            return;
        }

        // 尝试所有可能的 Provider，直到成功或全部失败
        let lastError: any = null;
        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (this.currentIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getStatus();

            // 如果该 Provider 还没准备好（初始化中或已报错）且不是最后一次尝试，跳过它
            if ((status.status === 'error' || status.status === 'initializing') && attempt < availableProviders - 1) {
                continue;
            }

            try {
                // 更新下一次轮询的起始位置
                if (attempt === 0) {
                    this.currentIndex = (this.currentIndex + 1) % availableProviders;
                }

                logger.debug(`Attempting request with provider: ${status.id} (Attempt ${attempt + 1})`);
                
                // 注意：如果 provider 内部处理了 res 响应，我们需要捕获是否真的“成功”
                // 为了支持重试，我们需要稍微重构 handleChatCompletion 或者让它抛出可重试的错误
                // 这里我们暂且假设如果进入了 catch 块或者返回了特定错误，则进行重试
                return await provider.handleChatCompletion(req, res);
            } catch (err: any) {
                lastError = err;
                logger.warn(`Provider ${status.id} failed, trying next... Error: ${err.message}`);
                // 继续循环，尝试下一个
            }
        }

        // 如果走到这里，说明全部失败
        res.status(500).json({ 
            error: 'All providers failed', 
            details: lastError?.message 
        });
    }

    async handleWebSearch(req: Request, res: Response): Promise<void> {
        const availableProviders = this.providers.length;
        if (availableProviders === 0) {
            res.status(500).json({ error: 'No Qwen providers configured' });
            return;
        }

        let lastError: any = null;
        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (this.currentIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getStatus();

            if ((status.status === 'error' || status.status === 'initializing') && attempt < availableProviders - 1) {
                continue;
            }

            try {
                if (attempt === 0) {
                    this.currentIndex = (this.currentIndex + 1) % availableProviders;
                }
                return await provider.handleWebSearch(req, res);
            } catch (err: any) {
                lastError = err;
                logger.warn(`Search failed with provider ${status.id}, trying next...`);
            }
        }

        res.status(500).json({ error: 'All search providers failed', details: lastError?.message });
    }
}


