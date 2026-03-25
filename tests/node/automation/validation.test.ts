import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Re-define Automation schemas to test in isolation

const CROP_LOCATIONS = ["eye_higher", "below_eye", "btw_eye_and_nose", "below_nose",
    "between_nose_and_mouth", "below_mouth", "below_chin", "chest",
    "at_elbow_higher", "at_elbow_lower", "waist", "below_buttock",
    "main_body_axis", "mid_thigh", "above_knee", "at_knee", "below_knee"] as const;

const RemoveBgSchema = z.object({
    imagePath: z.string().min(1),
    backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #FFFFFF').optional(),
    transparentBackground: z.boolean().optional(),
    featherWidth: z.number().min(0).optional(),
    trimapUrl: z.string().optional(),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const ModelCropSchema = z.object({
    imagePath: z.string().min(1),
    topCropLocation: z.enum(CROP_LOCATIONS).optional(),
    bottomCropLocation: z.enum(CROP_LOCATIONS).optional(),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const ColorMatchingSchema = z.object({
    imagePath: z.string().min(1),
    colorMarkers: z.array(z.object({}).passthrough()).min(1),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const JobIdSchema = z.object({ jobId: z.string().min(1) });

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
