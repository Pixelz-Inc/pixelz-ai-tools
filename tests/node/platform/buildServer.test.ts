import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Constructs each MCP server the way serveStdio does.
 *
 * Every other test calls callTool() directly, and all of them set NODE_ENV=test — which is
 * the exact guard that skips serveStdio(buildServer). So registerTool()/fromJsonSchema()
 * ran nowhere in the suite: a JSON Schema keyword the SDK rejects at runtime would fail to
 * start the server while the whole suite stayed green. This closes that hole.
 */
describe('MCP servers — buildServer registers every tool', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.resetModules();
    });

    it('platform server constructs with all 14 tools', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.buildServer()).not.toThrow();
        expect(mod.TOOLS).toHaveLength(14);
    });

    it('automation server constructs with all 7 tools', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        expect(() => mod.buildServer()).not.toThrow();
        expect(mod.TOOLS).toHaveLength(7);
    });

    it('platform tool schemas survive fromJsonSchema, including the constrained fields', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        // These three carry pattern / maximum / minItems — keywords the SDK validates at
        // registration time, not compile time.
        const upload: any = mod.TOOLS.find((t: any) => t.name === 'upload_image');
        expect(upload.inputSchema.properties.swatchColorCode.pattern).toBe('^#[0-9A-Fa-f]{6}$');
        const list: any = mod.TOOLS.find((t: any) => t.name === 'list_images');
        expect(list.inputSchema.properties.imagesPerPage.maximum).toBe(100);
        const color: any = mod.TOOLS.find((t: any) => t.name === 'add_color_library');
        expect(color.inputSchema.properties.imagesPath.minItems).toBe(1);
        expect(() => mod.buildServer()).not.toThrow();
    });
});
