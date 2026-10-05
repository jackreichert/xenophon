import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Optional settings, in the same shape the-maestro uses: a fenced `xenophon-config`
 * block of `key: value` lines in a markdown file. Path: $XENOPHON_CONFIG, else
 * <vault>/xenophon-config.md. Environment variables win over the file.
 */
export function readConfig(vault) {
    const path = process.env.XENOPHON_CONFIG || join(vault, 'xenophon-config.md');
    if (!existsSync(path)) return {};
    const block = readFileSync(path, 'utf8').match(/```xenophon-config\n([\s\S]*?)```/);
    const cfg = {};
    for (const line of (block ? block[1] : '').split('\n')) {
        const m = line.replace(/\s+#.*$/, '').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
        if (m) cfg[m[1]] = m[2];
    }
    return cfg;
}
