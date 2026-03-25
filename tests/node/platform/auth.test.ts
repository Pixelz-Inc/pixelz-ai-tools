import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock environment before importing the module
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');

// Mock dotenv to prevent file loading
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

describe('Platform Auth — getAuthParams()', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
    });

    it('returns correct auth object when env vars are set', async () => {
        vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'test@example.com');
        vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'key123');

        // Re-import to pick up env vars
        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        const auth = mod.getAuthParams();

        expect(auth).toEqual({
            contactEmail: 'test@example.com',
            contactAPIkey: 'key123',
        });
    });

    it('does NOT include developerAPIkey in auth object', async () => {
        vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'test@example.com');
        vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'key123');
        vi.stubEnv('PIXELZ_PLATFORM_DEVELOPER_KEY', 'devkey456');

        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        const auth = mod.getAuthParams();

        expect(auth).not.toHaveProperty('developerAPIkey');
    });

    it('throws AUTH_ERROR when email is missing', async () => {
        vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'key123');
        delete process.env.PIXELZ_PLATFORM_EMAIL;

        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.getAuthParams()).toThrow('[AUTH_ERROR]');
    });

    it('throws AUTH_ERROR when API key is missing', async () => {
        vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'test@example.com');
        delete process.env.PIXELZ_PLATFORM_API_KEY;

        const mod = await import('../../../mcp-servers/platform/node/src/index.ts');
        expect(() => mod.getAuthParams()).toThrow('[AUTH_ERROR]');
    });
});
