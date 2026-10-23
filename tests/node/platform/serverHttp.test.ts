import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Node MCP servers' own fetch helper and redaction. Each server carries its own copy of
 * request() (local installs copy every package alone), and until now only the CLIs' copies had
 * edge-case tests; the servers' redaction was only ever tested with plain values, never the
 * percent-encoded forms that actually leaked. fetch is stubbed; nothing leaves the process.
 */
// Literal paths: Vite only resolves a dynamic import() whose specifier is a string literal.
const loadPlatform = () => import('../../../mcp-servers/platform/node/src/index.ts');
const loadAutomation = () => import('../../../mcp-servers/automation/node/src/index.ts');
// Awkward on purpose: + / = are percent-encoded inside a URL, which defeated literal matching.
const KEY = 'ab+cd/ef=gh';
const EMAIL = 'leaky@example.com';
const SECRET = 'sec+ret/val=ue';

type Reply = Response | Error | (() => Response | Error);
let fetchMock: ReturnType<typeof vi.fn>;

/** Stub fetch with a queue of replies (the last one repeats); an Error makes fetch reject. */
function stubFetch(...replies: Reply[]) {
    let i = 0;
    fetchMock = vi.fn(() => {
        const r = replies[Math.min(i++, replies.length - 1)];
        const v = typeof r === 'function' ? r() : r;
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v.clone());
    });
    vi.stubGlobal('fetch', fetchMock);
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const socketClosed = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });

beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
    vi.stubEnv('PIXELZ_PLATFORM_EMAIL', EMAIL);
    vi.stubEnv('PIXELZ_PLATFORM_API_KEY', KEY);
    vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'client-id-123');
    vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', SECRET);
});

describe('Node MCP servers — credential redaction', () => {
    it('platform: a server echoing the credentials, raw or URL-encoded, never reaches the agent', async () => {
        const echo = `contactEmail=${encodeURIComponent(EMAIL)}&contactAPIkey=${encodeURIComponent(KEY)} raw ${KEY} ${EMAIL} ` +
            `qs ${new URLSearchParams({ k: KEY }).toString()}`;
        stubFetch(json(400, { message: echo }));
        const mod = await loadPlatform();
        const res: any = await mod.callTool('get_contact', {});
        const text = res.content[0].text;
        expect(res.isError).toBe(true);
        expect(text).toContain('[HTTP_400]');
        for (const leak of [KEY, EMAIL, encodeURIComponent(KEY), encodeURIComponent(EMAIL)]) expect(text).not.toContain(leak);
    });

    it('automation: the client secret and the bearer token never reach the agent', async () => {
        const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';
        stubFetch(
            json(200, { access_token: jwt, expires_in: 3600 }),
            json(401, { error: `client_secret=${encodeURIComponent(SECRET)} raw ${SECRET} token ${jwt}` }),
        );
        const mod = await loadAutomation();
        const res: any = await mod.callTool('get_job_status', { jobId: 'job-1' });
        const text = res.content[0].text;
        expect(text).toContain('[HTTP_401]');
        for (const leak of [SECRET, encodeURIComponent(SECRET), jwt]) expect(text).not.toContain(leak);
    });
});

describe('Node MCP servers — HTTP edge cases', () => {
    it('a non-JSON 2xx (proxy or login page) is an error, not a result', async () => {
        stubFetch(new Response('<html>please log in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
        const mod = await loadPlatform();
        const res: any = await mod.callTool('get_contact', {});
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/^Error: \[API_ERROR\] Expected a JSON response/);
    });

    it('never retries the job-creating POST', async () => {
        stubFetch(json(503, { message: 'busy' }, { 'Retry-After': '0' }));
        const mod = await loadPlatform();
        const res: any = await mod.callTool('upload_image', { imagePath: 'https://example.com/a.jpg', templateId: '1' });
        expect(res.content[0].text).toMatch(/^Error: \[HTTP_503\]/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a GET after 503, honouring Retry-After', async () => {
        stubFetch(json(503, {}, { 'Retry-After': '0' }), json(200, { ErrorCode: 'NoError', ok: true }));
        const mod = await loadPlatform();
        const res: any = await mod.callTool('get_contact', {});
        expect(res.isError).toBeFalsy();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a GET whose connection the server closed (UND_ERR_SOCKET)', async () => {
        stubFetch(socketClosed(), json(200, { ErrorCode: 'NoError', ok: true }));
        const mod = await loadPlatform();
        const res: any = await mod.callTool('get_contact', {});
        expect(res.isError).toBeFalsy();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 15_000);

    it('a stall while reading the body is [TIMEOUT]', async () => {
        const stalled = () => {
            const r = new Response('{}', { status: 200 });
            Object.defineProperty(r, 'text', { value: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })) });
            Object.defineProperty(r, 'clone', { value: () => r });
            return r;
        };
        stubFetch(stalled);
        const mod = await loadPlatform();
        const res: any = await mod.callTool('get_contact', {});
        expect(res.content[0].text).toMatch(/^Error: \[TIMEOUT\]/);
    });
});

describe('Node platform MCP server — local file upload', () => {
    const local = () => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-srv-')), 'shirt.jpg');
        fs.writeFileSync(f, Buffer.alloc(1024, 7));
        return f;
    };
    const envelope = json(200, { ErrorCode: 'NoError', Message: '', PostingUrls: [{ UploadUrl: 'https://s3.test/put', DownloadUrl: 'https://s3.test/get' }] });

    it('accepts the documented presign envelope and returns the DownloadUrl', async () => {
        stubFetch(envelope, new Response('', { status: 200 }));
        const mod = await loadPlatform();
        expect(await mod.ensureUrl(local())).toBe('https://s3.test/get');
        const [putUrl, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(putUrl).toBe('https://s3.test/put');
        expect(init.method).toBe('PUT');
    });

    it('a failed S3 upload is an error, not a DownloadUrl for a file that was never stored', async () => {
        stubFetch(envelope, new Response('<Error>AccessDenied</Error>', { status: 403 }));
        const mod = await loadPlatform();
        await expect(mod.ensureUrl(local())).rejects.toMatchObject({ response: { status: 403 } });
    });
});
