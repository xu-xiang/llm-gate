import { Context } from 'hono';

export interface LLMProvider {
    handleChatCompletion(c: Context): Promise<Response | void>;
    handleWebSearch(c: Context): Promise<Response | void>;
    initialize(): Promise<void>;
}