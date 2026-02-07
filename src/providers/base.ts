import { Context } from 'hono';

export interface LLMProvider {
    handleChatCompletion(c: Context, payload?: any): Promise<Response | void>;
    handleWebSearch(c: Context, payload?: any): Promise<Response | void>;
    initialize(): Promise<void>;
}
