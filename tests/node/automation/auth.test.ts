import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');


/** Stub the global fetch the servers now use; each call gets a fresh Response (bodies are single-use). */
function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('Automation Auth — getAccessToken()', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.resetModules();
        vi.unstubAllGlobals();
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

        const fetchMock = stubFetch({ access_token: 'token_abc', expires_in: 3600 });

        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const token = await mod.getAccessToken();
        expect(token).toBe('token_abc');
        // The OAuth client-credentials exchange, form-encoded as Keycloak requires.
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('/protocol/openid-connect/token');
        expect(String(init.body)).toContain('grant_type=client_credentials');
    });
});
