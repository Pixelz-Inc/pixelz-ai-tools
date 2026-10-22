import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');



/** Stub the global fetch the servers now use; each call gets a fresh Response (bodies are single-use). */
function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('Automation — redactSecrets', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'my_client_id');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'my_secret_value');
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('redacts client ID and secret from error messages', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const result = mod.redactSecrets('Error: my_client_id failed with my_secret_value');
        expect(result).not.toContain('my_client_id');
        expect(result).not.toContain('my_secret_value');
        expect(result).toContain('<REDACTED>');
    });

    it('redacts JWT tokens', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_here';
        const result = mod.redactSecrets(`Bearer ${jwt}`);
        expect(result).not.toContain('eyJ');
        expect(result).toContain('<REDACTED>');
    });
});

describe('Automation — token caching', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'client123');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'secret456');
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('caches token and reuses on second call', async () => {
        const mockPost = stubFetch({ access_token: 'cached_token', expires_in: 3600 });
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const token1 = await mod.getAccessToken();
        const token2 = await mod.getAccessToken();
        expect(token1).toBe('cached_token');
        expect(token2).toBe('cached_token');
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('concurrent calls share a single token request', async () => {
        const mockPost = stubFetch({ access_token: 'shared_token', expires_in: 3600 });
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        const [t1, t2, t3] = await Promise.all([
            mod.getAccessToken(),
            mod.getAccessToken(),
            mod.getAccessToken(),
        ]);
        expect(t1).toBe('shared_token');
        expect(t2).toBe('shared_token');
        expect(t3).toBe('shared_token');
        expect(mockPost).toHaveBeenCalledTimes(1);
    });
});

describe('Automation — ensureUrlOrId validation', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'client123');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'secret456');
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('rejects non-regular files (e.g. directories)', async () => {
        const mod = await import('../../../mcp-servers/automation/node/src/index.ts');
        // __dirname exists and is a directory, not a file
        await expect(mod.ensureUrlOrId('.', 'token')).rejects.toThrow('Not a regular file');
    });
});
