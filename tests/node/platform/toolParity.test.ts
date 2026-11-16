import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Node and Python MCP servers must advertise the same tools. Descriptions are not compared
 * (the wording legitimately differs), but names, property names, required lists, enums and
 * annotations are: this fails on any drift between the two tracks.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMP_TOOLS = path.resolve(__dirname, '../../python/dump_tools.py');

vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
const platform = await import('../../../mcp-servers/platform/node/src/index.ts');
const automation = await import('../../../mcp-servers/automation/node/src/index.ts');

type Summary = { name: string; properties: string[]; required: string[]; enums: Record<string, string[]>; annotations: Record<string, boolean> };

function summarizeNode(tools: readonly any[]): Summary[] {
    return tools.map(t => {
        const props: Record<string, any> = t.inputSchema.properties ?? {};
        return {
            name: t.name,
            properties: Object.keys(props).sort(),
            required: [...(t.inputSchema.required ?? [])].sort(),
            enums: Object.fromEntries(Object.entries(props).filter(([, v]) => v.enum).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v.enum]])),
            annotations: { ...t.annotations },
        };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

let python: { platform: Summary[]; automation: Summary[] };

beforeAll(async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile('python', [DUMP_TOOLS], { timeout: 90_000 }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(out)));
    });
    python = JSON.parse(stdout);
}, 120_000);

describe('Node and Python MCP servers advertise the same tools', () => {
    it('platform: names, properties, required, enums and annotations match', () => {
        expect(python.platform).toEqual(summarizeNode(platform.TOOLS));
    }, 60_000);

    it('automation: names, properties, required, enums and annotations match', () => {
        expect(python.automation).toEqual(summarizeNode(automation.TOOLS));
    }, 60_000);

    it('every tool carries openWorldHint, and only the read-only ones say readOnlyHint', () => {
        for (const t of [...platform.TOOLS, ...automation.TOOLS] as any[]) {
            expect(t.annotations.openWorldHint, t.name).toBe(true);
            expect(typeof t.annotations.readOnlyHint, t.name).toBe('boolean');
        }
        const destructive = (platform.TOOLS as readonly any[]).filter(t => t.annotations.destructiveHint).map(t => t.name);
        expect(destructive).toEqual(['delete_image']);
    });
});
