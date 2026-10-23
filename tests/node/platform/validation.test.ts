import { describe, it, expect, vi } from 'vitest';

// The servers' own schemas, not copies: a copy cannot fail when the server's schema drifts.
// Imported dynamically, after PIXELZ_DOTENV_PATH is redirected, so the repo's real .env is never loaded.
vi.stubEnv('PIXELZ_DOTENV_PATH', '/dev/null');
const { UploadImageSchema, RejectImageSchema, AddColorLibrarySchema, ListImagesSchema } = await import('../../../mcp-servers/platform/node/src/index.ts');

describe('Platform Zod Schemas', () => {
    describe('UploadImageSchema', () => {
        it('accepts valid input with required fields', () => {
            const result = UploadImageSchema.parse({
                imagePath: '/path/to/image.jpg',
                templateId: '123',
            });
            expect(result.imagePath).toBe('/path/to/image.jpg');
            expect(result.templateId).toBe('123');
        });

        it('accepts valid input with optional fields', () => {
            const result = UploadImageSchema.parse({
                imagePath: 'https://example.com/img.jpg',
                templateId: '456',
                comment: 'Please crop tightly',
                swatchColorCode: '#FF00AA',
                markerX: 100,
            });
            expect(result.comment).toBe('Please crop tightly');
            expect(result.swatchColorCode).toBe('#FF00AA');
        });

        it('rejects missing imagePath', () => {
            expect(() => UploadImageSchema.parse({ templateId: '123' })).toThrow();
        });

        it('rejects missing templateId', () => {
            expect(() => UploadImageSchema.parse({ imagePath: '/img.jpg' })).toThrow();
        });

        it('rejects empty imagePath', () => {
            expect(() => UploadImageSchema.parse({ imagePath: '', templateId: '123' })).toThrow();
        });

        it('rejects invalid hex color code', () => {
            expect(() => UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123', swatchColorCode: 'red'
            })).toThrow();
        });

        it('rejects non-6-digit hex color', () => {
            expect(() => UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123', swatchColorCode: '#FFF'
            })).toThrow();
        });

        it('rejects a fractional marker: the API takes integer pixel coordinates', () => {
            expect(() => UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123', markerX: 100.5
            })).toThrow();
        });

        it('rejects string where number expected', () => {
            expect(() => UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123', markerX: 'abc'
            })).toThrow();
        });

        it('accepts valid colorwayIds array', () => {
            const result = UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123', colorwayIds: [1, 2, 3]
            });
            expect(result.colorwayIds).toEqual([1, 2, 3]);
        });

        it('accepts upload without colorwayIds', () => {
            const result = UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123'
            });
            expect(result.colorwayIds).toBeUndefined();
        });

        it('rejects non-number values in colorwayIds', () => {
            expect(() => UploadImageSchema.parse({
                imagePath: '/img.jpg', templateId: '123', colorwayIds: ['abc']
            })).toThrow();
        });
    });

    describe('RejectImageSchema', () => {
        it('accepts valid input', () => {
            const result = RejectImageSchema.parse({
                imageTicket: 'abc-123',
                comment: 'Wrong crop',
            });
            expect(result.imageTicket).toBe('abc-123');
        });

        it('rejects empty comment', () => {
            expect(() => RejectImageSchema.parse({
                imageTicket: 'abc-123', comment: ''
            })).toThrow();
        });

        it('rejects missing imageTicket', () => {
            expect(() => RejectImageSchema.parse({ comment: 'fix it' })).toThrow();
        });
    });

    describe('AddColorLibrarySchema', () => {
        it('accepts valid input with array of URL strings', () => {
            const result = AddColorLibrarySchema.parse({
                imagesPath: ['https://example.com/swatch1.jpg', 'https://example.com/swatch2.jpg']
            });
            expect(result.imagesPath).toHaveLength(2);
        });

        it('rejects empty array', () => {
            expect(() => AddColorLibrarySchema.parse({ imagesPath: [] })).toThrow();
        });

        it('rejects missing imagesPath', () => {
            expect(() => AddColorLibrarySchema.parse({})).toThrow();
        });

        it('rejects empty string in array', () => {
            expect(() => AddColorLibrarySchema.parse({ imagesPath: [''] })).toThrow();
        });
    });

    describe('ListImagesSchema', () => {
        it('accepts empty object (all optional)', () => {
            const result = ListImagesSchema.parse({});
            expect(result).toEqual({});
        });

        it('accepts valid filters', () => {
            const result = ListImagesSchema.parse({
                imageStatus: '80',
                fromDate: '2025-01-01',
                page: 2,
                imagesPerPage: 50,
                sortBy: 'date',
                isDescending: 'true',
            });
            expect(result.sortBy).toBe('date');
        });

        it('rejects imagesPerPage over 100', () => {
            expect(() => ListImagesSchema.parse({ imagesPerPage: 200 })).toThrow();
        });

        it('rejects invalid sortBy value', () => {
            expect(() => ListImagesSchema.parse({ sortBy: 'name' })).toThrow();
        });
    });
});
