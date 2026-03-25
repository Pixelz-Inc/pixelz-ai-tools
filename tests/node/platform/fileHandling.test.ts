import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'test@example.com');
vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'key123');

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

describe('Platform — ensureUrl()', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('passes HTTP URLs through unchanged', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        const result = await mod.ensureUrl('https://example.com/image.jpg');
        expect(result).toBe('https://example.com/image.jpg');
    });

    it('passes HTTPS URLs through unchanged', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        const result = await mod.ensureUrl('http://example.com/image.jpg');
        expect(result).toBe('http://example.com/image.jpg');
    });

    it('returns null for empty input', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        const result = await mod.ensureUrl('');
        expect(result).toBeNull();
    });

    it('throws for non-existent local file', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        await expect(mod.ensureUrl('/nonexistent/file.jpg')).rejects.toThrow('Local file not found');
    });
});

describe('Platform — validateId()', () => {
    it('accepts valid alphanumeric IDs', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.validateId('abc-123_DEF', 'test')).not.toThrow();
    });

    it('rejects IDs with special characters', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.validateId('abc/../etc', 'test')).toThrow('Invalid test');
    });

    it('rejects IDs with spaces', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.validateId('abc def', 'test')).toThrow('Invalid test');
    });
});

describe('Platform — checkApiError()', () => {
    it('does not throw for successful responses', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.checkApiError({ ErrorCode: 'NoError' })).not.toThrow();
        expect(() => mod.checkApiError({ ErrorCode: 0 })).not.toThrow();
    });

    it('throws API_ERROR for error responses', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.checkApiError({ ErrorCode: 'InvalidTemplate', Message: 'Not found' }))
            .toThrow('[API_ERROR] InvalidTemplate: Not found');
    });

    it('does not throw for array responses', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.checkApiError([{ id: 1 }])).not.toThrow();
    });
});
