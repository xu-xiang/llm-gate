import os from 'os';
import path from 'path';

export function resolvePath(p: string): string {
    if (p.startsWith('~')) {
        return path.join(os.homedir(), p.slice(1));
    }
    return path.resolve(p);
}
