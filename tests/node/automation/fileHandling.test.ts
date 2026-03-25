import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'client123');
vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'secret456');

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

describe('Automation — ensureUrlOrId()', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('passes HTTPS URLs through unchanged', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const result = await mod.ensureUrlOrId('https://example.com/img.jpg', 'token');
        expect(result).toBe('https://example.com/img.jpg');
    });

    it('returns null for empty input', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const result = await mod.ensureUrlOrId('', 'token');
        expect(result).toBeNull();
    });

    it('throws for non-existent local file', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        await expect(mod.ensureUrlOrId('/nonexistent/file.jpg', 'token')).rejects.toThrow('Local file not found');
    });
});

describe('Automation — validateId()', () => {
    it('accepts valid IDs', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        expect(() => mod.validateId('job-abc_123', 'jobId')).not.toThrow();
    });

    it('rejects path traversal attempts', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        expect(() => mod.validateId('../../../etc/passwd', 'jobId')).toThrow('Invalid jobId');
    });
});
