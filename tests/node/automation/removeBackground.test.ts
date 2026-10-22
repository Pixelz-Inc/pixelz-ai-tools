import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

/**
 * The API spec for remove-background: "choose only one ... Do not set both, and do not leave
 * both unset." The MCP tool defaulted transparent_background to true, so a colour request
 * sent both. Mirrors tests/python/automation_api/test_remove_background.py.
 */
let post: ReturnType<typeof vi.fn>;

async function loadServer() {
    post = vi.fn().mockImplementation((url: string) => Promise.resolve(
        url.includes('token') ? { data: { access_token: 'tok', expires_in: 3600 } } : { data: { job_id: 'job-1' } }
    ));
    const instance = { post, get: vi.fn(), put: vi.fn(), delete: vi.fn(), interceptors: { response: { use: vi.fn() } } };
    vi.doMock('axios', () => ({ default: { ...instance, create: vi.fn().mockReturnValue(instance) } }));
    return import('../../../mcp-servers/automation/node/src/index.ts');
}

const jobPosts = () => post.mock.calls.filter(([url]) => String(url).includes('/images/remove-background'));
const IMG = 'https://example.com/shirt.jpg';

describe('Automation MCP — remove_background background choice', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_ID', 'id');
        vi.stubEnv('PIXELZ_AUTOMATION_CLIENT_SECRET', 'secret');
        vi.resetModules();
    });

    it('a background colour alone disables transparency', async () => {
        const mod = await loadServer();
        await mod.callTool('remove_background', { imagePath: IMG, backgroundColor: '#FFFFFF' });
        const body = jobPosts()[0][1];
        expect(body.background_color).toBe('#FFFFFF');
        expect(body.transparent_background).toBe(false);
    });

    it('defaults to transparent without a colour', async () => {
        const mod = await loadServer();
        await mod.callTool('remove_background', { imagePath: IMG });
        const body = jobPosts()[0][1];
        expect(body.transparent_background).toBe(true);
        expect(body).not.toHaveProperty('background_color');
    });

    it.each([
        [{ backgroundColor: '#FFFFFF', transparentBackground: true }],
        [{ transparentBackground: false }],
    ])('rejects %o before sending anything', async (extra) => {
        const mod = await loadServer();
        const result: any = await mod.callTool('remove_background', { imagePath: IMG, ...extra });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('[VALIDATION_ERROR]');
        expect(jobPosts()).toHaveLength(0);
    });
});
