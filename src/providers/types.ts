import { Context } from 'hono';

export interface ChatProvider {
    name: string;
    matchesModel(model: string): boolean;
    handleChatCompletion(c: Context, payload?: any): Promise<Response | void>;
}

export interface SearchProvider {
    name: string;
    handleWebSearch(c: Context, payload?: any): Promise<Response | void>;
}

