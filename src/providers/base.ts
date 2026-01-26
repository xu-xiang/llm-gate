import { Request, Response } from 'express';

export interface LLMProvider {
    handleChatCompletion(req: Request, res: Response): Promise<void>;
    initialize(): Promise<void>;
}
