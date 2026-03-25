import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

describe('Automation Auth — getAccessToken()', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.resetModules();
    });

    it('throws AUTH_ERROR when credentials are missing', async () => {
        delete process.env.PIXELZ_AUTOMATION_CLIENT_ID;
        delete process.env.PIXELZ_AUTOMATION_CLIENT_SECRET;

        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        await expect(mod.getAccessToken()).rejects.toThrow('[AUTH_ERROR]');
    });

    it('requests a new token via OAuth and returns it', async () => {
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'client123');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'secret456');

        // Mock axios before importing the module so the module gets the mock
        vi.doMock('axios', () => ({
            default: {
                post: vi.fn().mockResolvedValue({
                    data: { access_token: 'token_abc', expires_in: 3600 },
                }),
                get: vi.fn(),
                put: vi.fn(),
                delete: vi.fn(),
            },
        }));

        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const token = await mod.getAccessToken();
        expect(token).toBe('token_abc');
    });
});
