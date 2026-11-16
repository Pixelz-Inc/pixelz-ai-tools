import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Node twins of tests/python/test_server_behaviour.py: the shared module plus both MCP servers.
 * fetch is stubbed; nothing leaves the process.
 */
// Literal paths: Vite only resolves a dynamic import() whose specifier is a string literal.
const loadPlatform = () => import('../../../mcp-servers/platform/node/src/index.ts');
const loadAutomation = () => import('../../../mcp-servers/automation/node/src/index.ts');
const common = createRequire(import.meta.url)('../../../shared/node/pixelz-common.js');
const rootVersion = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')).version;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-behaviour-'));
const file = (name: string, content = 'x') => { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; };

const IMG = 'https://example.com/shirt.jpg';
let fetchMock: ReturnType<typeof vi.fn>;
type Reply = Response | Error;

/** Stub fetch with a queue of replies (the last one repeats); an Error makes fetch reject. */
function stubFetch(...replies: Reply[]) {
    let i = 0;
    fetchMock = vi.fn(() => {
        const r = replies[Math.min(i++, replies.length - 1)];
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r.clone());
    });
    vi.stubGlobal('fetch', fetchMock);
}
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const text = (res: any): string => res.content[0].text;

beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
    vi.stubEnv('PIXELZ_PLATFORM_EMAIL', 'test@example.com');
    vi.stubEnv('PIXELZ_PLATFORM_API_KEY', 'key123');
    vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'client123');
    vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'secret456');
    vi.stubEnv('PIXELZ_UPLOAD_ANY_FILE_TYPE', '');
    vi.stubEnv('PIXELZ_LOG_FILE', '');
});

describe('shared module', () => {
    it('exports the upload allowlists', () => {
        expect(common.AUTOMATION_MIME_TYPES).toEqual({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' });
        expect(common.AUTOMATION_UPLOAD_EXTENSIONS).toEqual(['.jpg', '.jpeg', '.png', '.webp']);
        expect(common.PLATFORM_UPLOAD_EXTENSIONS).toContain('.psd');
        expect(common.PLATFORM_UPLOAD_EXTENSIONS).toContain('.rw2');
    });

    it.each([undefined, null, '', 123, ['a']])('validateId(%j) is "required"', value => {
        expect(() => common.validateId(value, 'jobId')).toThrow(/^\[VALIDATION_ERROR\] jobId is required$/);
    });

    it('validateId message is categorized', () => {
        expect(() => common.validateId('a/b', 'jobId')).toThrow('[VALIDATION_ERROR] Invalid jobId: contains unexpected characters');
    });

    it('resolveLocalFile rejects other file types, case-insensitively, with the exact message', () => {
        expect(() => common.resolveLocalFile(file('.env'), common.AUTOMATION_UPLOAD_EXTENSIONS))
            .toThrow('[VALIDATION_ERROR] Unsupported file type "" for upload. Allowed: .jpg, .jpeg, .png, .webp.');
        expect(() => common.resolveLocalFile(file('id_rsa.PEM'), common.PLATFORM_UPLOAD_EXTENSIONS)).toThrow('Unsupported file type ".pem"');
        expect(common.resolveLocalFile(file('SHIRT.JPG'), common.AUTOMATION_UPLOAD_EXTENSIONS).fileSize).toBe(1);
    });

    it('PIXELZ_UPLOAD_ANY_FILE_TYPE=true is the escape hatch, and only exactly "true"', () => {
        const odd = file('scan.xyz');
        vi.stubEnv('PIXELZ_UPLOAD_ANY_FILE_TYPE', 'true');
        expect(common.resolveLocalFile(odd, common.PLATFORM_UPLOAD_EXTENSIONS).fileSize).toBe(1);
        vi.stubEnv('PIXELZ_UPLOAD_ANY_FILE_TYPE', '1');
        expect(() => common.resolveLocalFile(odd, common.PLATFORM_UPLOAD_EXTENSIONS)).toThrow('Unsupported file type');
    });

    it('file errors are categorized', () => {
        const exts = common.PLATFORM_UPLOAD_EXTENSIONS;
        expect(() => common.resolveLocalFile(path.join(tmp, 'missing.jpg'), exts)).toThrow('[VALIDATION_ERROR] Local file not found: ');
        expect(() => common.resolveLocalFile(tmp, exts)).toThrow('[VALIDATION_ERROR] Not a regular file: ');
    });

    it('a timeout error carries the timeout in force, not the default', async () => {
        stubFetch(timeoutError());
        const { request } = common.createHttp({ timeout: 90_000, redactSecrets: (s: any) => String(s) });
        await expect(request('GET', 'https://x.test/a')).rejects.toMatchObject({ code: 'ECONNABORTED', timeoutMs: 90_000 });
        await expect(request('GET', 'https://x.test/a', { timeout: 123_000 })).rejects.toMatchObject({ code: 'ECONNABORTED', timeoutMs: 123_000 });
    });
});

describe('platform server', () => {
    it('rejects a non-image local file before any request', async () => {
        stubFetch(json(200, {}));
        const mod = await loadPlatform();
        const res: any = await mod.callTool('upload_image', { imagePath: file('id_rsa'), templateId: '1' });
        expect(res.isError).toBe(true);
        expect(text(res)).toContain('Unsupported file type ""');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reject_image sends the documented body, including imageTicket', async () => {
        stubFetch(json(200, { ErrorCode: 'NoError' }));
        const mod = await loadPlatform();
        await mod.callTool('reject_image', { imageTicket: 'T-1', comment: 'fix it', markupImageUrl: 'https://e.com/m.png', customerImageId: 'c1' });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/Image/Reject/T-1');
        expect(JSON.parse(init.body as string)).toEqual({
            contactEmail: 'test@example.com', contactAPIkey: 'key123', imageTicket: 'T-1',
            comment: 'fix it', markupImageUrl: 'https://e.com/m.png', customerImageId: 'c1',
        });
    });

    it('missing identifiers are [VALIDATION_ERROR] "is required"', async () => {
        stubFetch(json(200, {}));
        const mod = await loadPlatform();
        expect(text(await mod.callTool('get_image_status', {}))).toContain('[VALIDATION_ERROR]');
        expect(() => mod.validateId(undefined as any, 'imageTicket')).toThrow('[VALIDATION_ERROR] imageTicket is required');
    });

    it('a timeout reports the figure in force: uploads use the longer, size-based limit', async () => {
        stubFetch(json(200, { ErrorCode: 'NoError', PostingUrls: [{ UploadUrl: 'https://s3.test/put', DownloadUrl: 'https://s3.test/get' }] }), timeoutError());
        const mod = await loadPlatform();
        const upload = text(await mod.callTool('upload_image', { imagePath: file('slow.jpg'), templateId: '1' }));
        // 90 s base + 1 s for a 1-byte file at 32 KB/s
        expect(upload).toBe('Error: [TIMEOUT] Request timed out after 91 seconds');
        stubFetch(timeoutError());
        expect(text(await mod.callTool('get_contact', {}))).toBe('Error: [TIMEOUT] Request timed out after 90 seconds');
    });

    it('logs identifiers only, never comments, URLs or local paths', async () => {
        const logFile = path.join(tmp, 'platform.log');
        vi.stubEnv('PIXELZ_LOG_FILE', logFile);
        stubFetch(json(200, { ErrorCode: 'NoError' }));
        const mod = await loadPlatform();
        await mod.callTool('reject_image', { imageTicket: 'T-LOG', comment: 'SECRET-COMMENT', markupImageUrl: 'https://private.example/m.png' });
        await mod.callTool('add_color_library', { imagesPath: ['https://a.example/1.jpg', 'https://a.example/2.jpg'] });
        await mod.callTool('upload_image', { imagePath: 'https://private.example/p.jpg', templateId: 'TPL-9', imageCallbackURL: 'https://hooks.example/cb' });
        const log = fs.readFileSync(logFile, 'utf8');
        expect(log).toContain('"imageTicket":"T-LOG"');
        expect(log).toContain('"count":2');
        expect(log).toContain('"templateId":"TPL-9"');
        for (const leak of ['SECRET-COMMENT', 'private.example', 'hooks.example', 'a.example']) expect(log).not.toContain(leak);
    });

    it('reports the version of the repo-root package.json and registers annotations', async () => {
        const mod = await loadPlatform();
        expect(mod.readRepoVersion()).toBe(rootVersion);
        for (const t of mod.TOOLS as readonly any[]) expect(t.annotations.openWorldHint).toBe(true);
        const byName = Object.fromEntries((mod.TOOLS as readonly any[]).map(t => [t.name, t]));
        expect(byName.delete_image.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(byName.list_images.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
        expect(byName.upload_image.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
        expect(() => mod.buildServer()).not.toThrow();
    });

    it('descriptions carry the status table and the billing warning', async () => {
        const mod = await loadPlatform();
        const desc = Object.fromEntries((mod.TOOLS as readonly any[]).map(t => [t.name, t.description as string]));
        for (const fragment of ['12 download failed', '90 rejected by Pixelz', '95 awaiting your reply', 'FinalImagesURL']) expect(desc.get_image_status).toContain(fragment);
        expect(desc.list_images).toContain('any numeric code');
        expect(desc.count_images).toContain('any numeric code');
        for (const name of ['upload_image', 'white_glove_service', 'stack_image']) expect(desc[name], name).toContain('billable');
    });
});

describe('automation server', () => {
    it('validates arguments before fetching a token', async () => {
        stubFetch(json(200, { access_token: 't', expires_in: 3600 }));
        const mod = await loadAutomation();
        for (const [tool, args] of [
            ['remove_background', {}],
            ['create_mask', { imagePath: IMG, featherWidth: -1 }],
            ['model_crop', { imagePath: IMG }],
            ['color_matching', { imagePath: IMG, colorMarkers: [{ x_coordinate: 1, y_coordinate: 2 }] }],
            ['get_job_status', { jobId: 'a/b' }],
        ] as const) {
            const res: any = await mod.callTool(tool, args);
            expect(res.isError, tool).toBe(true);
            expect(text(res), tool).toContain('[VALIDATION_ERROR]');
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('missing credentials still come back as [AUTH_ERROR] for a valid call', async () => {
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', '');
        const mod = await loadAutomation();
        expect(text(await mod.callTool('get_webhook_public_key', {}))).toContain('[AUTH_ERROR]');
    });

    it('model_crop needs at least one crop location', async () => {
        stubFetch(json(200, { access_token: 't', expires_in: 3600 }), json(201, { job_id: 'j' }));
        const mod = await loadAutomation();
        expect(text(await mod.callTool('model_crop', { imagePath: IMG }))).toBe('Error: [VALIDATION_ERROR] at least one of topCropLocation or bottomCropLocation is required');
        const ok: any = await mod.callTool('model_crop', { imagePath: IMG, topCropLocation: 'below_eye' });
        expect(ok.isError).toBeUndefined();
        expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({ image_url: IMG, top_crop_location: 'below_eye' });
    });

    const goodColor = { x_coordinate: 1, y_coordinate: 2, swatch_color_code: '#FF00AA' };
    const goodSwatch = { x_coordinate: 1, y_coordinate: 2, swatch_image: { swatch_image_url: 'https://e.com/s.jpg', x_coordinate: 3, y_coordinate: 4 } };

    it.each([
        ['neither swatch', [{ x_coordinate: 1, y_coordinate: 2 }]],
        ['both swatches', [{ ...goodColor, swatch_image: goodSwatch.swatch_image }]],
        ['non-hex colour', [{ ...goodColor, swatch_color_code: 'red' }]],
        ['fractional x', [{ ...goodColor, x_coordinate: 1.5 }]],
        ['missing y', [{ x_coordinate: 1, swatch_color_code: '#FF00AA' }]],
        ['unknown key', [{ ...goodColor, extra: 1 }]],
        ['incomplete swatch image', [{ ...goodSwatch, swatch_image: { swatch_image_url: 'u', x_coordinate: 3 } }]],
        ['not an object', ['x']],
        ['empty array', []],
    ])('color_matching rejects %s', async (_label, colorMarkers) => {
        const mod = await loadAutomation();
        expect(() => mod.ColorMatchingSchema.parse({ imagePath: IMG, colorMarkers })).toThrow();
    });

    it('color_matching accepts both marker forms, sends them unchanged and advertises their shape', async () => {
        const markers = [goodColor, goodSwatch, { ...goodSwatch, swatch_color_code: null }];
        stubFetch(json(200, { access_token: 't', expires_in: 3600 }), json(201, { job_id: 'j' }));
        const mod = await loadAutomation();
        await mod.callTool('color_matching', { imagePath: IMG, colorMarkers: markers });
        expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string).color_markers).toEqual(markers);
        const tool: any = (mod.TOOLS as readonly any[]).find(t => t.name === 'color_matching');
        const items = tool.inputSchema.properties.colorMarkers.items;
        expect(Object.keys(items.properties).sort()).toEqual(['swatch_color_code', 'swatch_image', 'x_coordinate', 'y_coordinate']);
        expect(items.required).toEqual(['x_coordinate', 'y_coordinate']);
        expect(items.properties.x_coordinate.type).toBe('integer');
        expect(tool.inputSchema.properties.colorMarkers.minItems).toBe(1);
    });

    it('rejects a non-image local file before any request', async () => {
        stubFetch(json(200, {}));
        const mod = await loadAutomation();
        await expect(mod.ensureUrlOrId(file('credentials.txt'), 'tok')).rejects.toThrow('Unsupported file type ".txt"');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('HTTP 403 from request-upload-url means direct uploads are not enabled', async () => {
        stubFetch(json(403, { message: 'Forbidden' }));
        const mod = await loadAutomation();
        const expected = '[UPLOAD_UNAVAILABLE] HTTP 403: the account may not be enabled for direct file uploads ' +
            '(off by default on the Automation API). Provide a publicly accessible image URL instead of a local file path.';
        await expect(mod.ensureUrlOrId(file('a.png'), 'tok')).rejects.toThrow(expected);
        stubFetch(json(200, { access_token: 't', expires_in: 3600 }), json(403, {}));
        expect(text(await mod.callTool('create_trimap', { imagePath: file('b.png') }))).toBe(`Error: ${expected}`);
    });

    it.each([['a.PNG', 'image/png'], ['b.jpg', 'image/jpeg'], ['c.jpeg', 'image/jpeg'], ['d.webp', 'image/webp']])(
        'uploads %s with Content-Type %s', async (name, contentType) => {
            stubFetch(json(200, { url: 'https://s3.test/put' }), json(200, {}));
            const mod = await loadAutomation();
            expect(await mod.ensureUrlOrId(file(name), 'tok')).toBe('https://s3.test/put');
            expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].headers).toEqual({ 'Content-Type': contentType });
        });

    it('the timeout message reports the real figure', async () => {
        stubFetch(json(200, { access_token: 't', expires_in: 3600 }), json(200, { url: 'https://s3.test/put' }), timeoutError());
        const mod = await loadAutomation();
        expect(text(await mod.callTool('create_trimap', { imagePath: file('slow.png') }))).toBe('Error: [TIMEOUT] Request timed out after 91 seconds');
    });

    it('logs only the job id, and reports the repo-root version', async () => {
        const logFile = path.join(tmp, 'automation.log');
        vi.stubEnv('PIXELZ_LOG_FILE', logFile);
        stubFetch(json(200, { access_token: 't', expires_in: 3600 }), json(200, { status: {} }));
        const mod = await loadAutomation();
        await mod.callTool('get_job_status', { jobId: 'JOB-7' });
        await mod.callTool('create_mask', { imagePath: 'https://private.example/p.jpg', callbackUrl: 'https://hooks.example/cb' });
        const log = fs.readFileSync(logFile, 'utf8');
        expect(log).toContain('"jobId":"JOB-7"');
        expect(log).not.toContain('private.example');
        expect(log).not.toContain('hooks.example');
        expect(mod.readRepoVersion()).toBe(rootVersion);
    });

    it('annotations and costs are advertised', async () => {
        const mod = await loadAutomation();
        const byName = Object.fromEntries((mod.TOOLS as readonly any[]).map(t => [t.name, t]));
        for (const name of ['remove_background', 'color_matching', 'create_mask', 'create_trimap', 'model_crop']) {
            expect(byName[name].annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
        }
        for (const name of ['get_job_status', 'get_webhook_public_key']) expect(byName[name].annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
        for (const [name, cost] of [['remove_background', '100'], ['color_matching', '100'], ['create_mask', '100'], ['create_trimap', '50'], ['model_crop', '10']]) {
            expect(byName[name].description, name).toContain(`Billed: ${cost} tokens`);
        }
        expect(byName.model_crop.description).toContain('At least one of topCropLocation');
    });
});
