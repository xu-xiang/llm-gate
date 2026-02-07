export function isQwenModel(model: string): boolean {
    return (
        model === 'coder-model' ||
        model === 'vision-model' ||
        model.startsWith('qwen') ||
        model.startsWith('qwen3')
    );
}

