import { describe, it, expect, vi } from 'vitest';

// The servers' own schemas, not copies: a copy cannot fail when the server's schema drifts.
// Imported dynamically, after PIXELZ_DOTENV_PATH is redirected, so the repo's real .env is never loaded.
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
const { CROP_LOCATIONS, RemoveBgSchema, ModelCropSchema, ColorMatchingSchema, JobIdSchema } = await import('../../../mcp-servers/automation/node/src/index.ts');

describe('Automation Zod Schemas', () => {
    describe('RemoveBgSchema', () => {
        it('accepts valid minimal input', () => {
            const result = RemoveBgSchema.parse({ imagePath: '/img.jpg' });
            expect(result.imagePath).toBe('/img.jpg');
        });

        it('accepts valid hex background color', () => {
            const result = RemoveBgSchema.parse({
                imagePath: '/img.jpg',
                backgroundColor: '#FF00AA',
                transparentBackground: false,
            });
            expect(result.backgroundColor).toBe('#FF00AA');
        });

        it('rejects invalid hex color', () => {
            expect(() => RemoveBgSchema.parse({
                imagePath: '/img.jpg', backgroundColor: 'white'
            })).toThrow();
        });

        it('rejects negative featherWidth', () => {
            expect(() => RemoveBgSchema.parse({
                imagePath: '/img.jpg', featherWidth: -1
            })).toThrow();
        });

        it('rejects missing imagePath', () => {
            expect(() => RemoveBgSchema.parse({})).toThrow();
        });

        it('rejects empty imagePath', () => {
            expect(() => RemoveBgSchema.parse({ imagePath: '' })).toThrow();
        });

        it('accepts sync as boolean', () => {
            const result = RemoveBgSchema.parse({ imagePath: '/img.jpg', sync: true });
            expect(result.sync).toBe(true);
        });

        it('rejects sync as string', () => {
            expect(() => RemoveBgSchema.parse({ imagePath: '/img.jpg', sync: 'true' })).toThrow();
        });
    });

    describe('ModelCropSchema', () => {
        it('accepts valid crop locations', () => {
            const result = ModelCropSchema.parse({
                imagePath: '/img.jpg',
                topCropLocation: 'eye_higher',
                bottomCropLocation: 'waist',
            });
            expect(result.topCropLocation).toBe('eye_higher');
        });

        it('rejects invalid crop location', () => {
            expect(() => ModelCropSchema.parse({
                imagePath: '/img.jpg', topCropLocation: 'head'
            })).toThrow();
        });

        it('accepts without crop locations (both optional)', () => {
            const result = ModelCropSchema.parse({ imagePath: '/img.jpg' });
            expect(result.topCropLocation).toBeUndefined();
        });
    });

    describe('ColorMatchingSchema', () => {
        it('accepts valid color markers', () => {
            const result = ColorMatchingSchema.parse({
                imagePath: '/img.jpg',
                colorMarkers: [{ x_coordinate: 100, y_coordinate: 200, swatch_color_code: '#FF0000' }],
            });
            expect(result.colorMarkers).toHaveLength(1);
        });

        it('rejects empty color markers array', () => {
            expect(() => ColorMatchingSchema.parse({
                imagePath: '/img.jpg', colorMarkers: []
            })).toThrow();
        });

        it('rejects missing colorMarkers', () => {
            expect(() => ColorMatchingSchema.parse({ imagePath: '/img.jpg' })).toThrow();
        });
    });

    describe('JobIdSchema', () => {
        it('accepts valid job ID', () => {
            const result = JobIdSchema.parse({ jobId: 'abc-123' });
            expect(result.jobId).toBe('abc-123');
        });

        it('rejects empty job ID', () => {
            expect(() => JobIdSchema.parse({ jobId: '' })).toThrow();
        });

        it('rejects missing job ID', () => {
            expect(() => JobIdSchema.parse({})).toThrow();
        });
    });
});
