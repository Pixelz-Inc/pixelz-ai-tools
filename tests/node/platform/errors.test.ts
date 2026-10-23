import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');



describe('Platform — redactSecrets', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'secret@example.com');
        vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'my_api_key_123');
        vi.resetModules();
    });

    it('redacts email and API key from error messages', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        const result = mod.redactSecrets('Auth failed for secret@example.com with key my_api_key_123');
        expect(result).not.toContain('secret@example.com');
        expect(result).not.toContain('my_api_key_123');
        expect(result).toContain('<REDACTED>');
    });
});

describe('Platform — ensureUrl validation', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'test@example.com');
        vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'key123');
        vi.resetModules();
    });

    it('rejects non-regular files (e.g. directories)', async () => {
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        await expect(mod.ensureUrl('.')).rejects.toThrow('Not a regular file');
    });
});
