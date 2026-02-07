import { Context } from 'hono';
import { ChatProvider, SearchProvider } from './types';

export class ProviderRouter {
    private chatProviders: ChatProvider[] = [];
    private searchProviders: SearchProvider[] = [];

    public registerChatProvider(provider: ChatProvider) {
        this.chatProviders.push(provider);
    }

    public registerSearchProvider(provider: SearchProvider) {
        this.searchProviders.push(provider);
    }

    public routeChat(model: string): ChatProvider | undefined {
        return this.chatProviders.find((p) => p.matchesModel(model));
    }

    public getDefaultSearchProvider(): SearchProvider | undefined {
        return this.searchProviders[0];
    }

    public async handleChat(c: Context, payload: any): Promise<Response | void> {
        const model = String(payload?.model || '');
        const provider = this.routeChat(model);
        if (!provider) {
            return c.json(
                {
                    error: {
                        message: `No provider available for model: ${model}`,
                        type: 'invalid_request_error'
                    }
                },
                404
            );
        }
        return provider.handleChatCompletion(c, payload);
    }

    public async handleSearch(c: Context, payload: any): Promise<Response | void> {
        const provider = this.getDefaultSearchProvider();
        if (!provider) {
            return c.json(
                {
                    error: {
                        message: 'Web search tool not available',
                        type: 'invalid_request_error'
                    }
                },
                404
            );
        }
        return provider.handleWebSearch(c, payload);
    }
}

