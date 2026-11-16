// Hand-written types for pixelz-common.js (CommonJS), for the TypeScript MCP servers.
// Keep in step with the module's exports.

export type RequestOptions = {
    params?: Record<string, any>;
    body?: any;
    headers?: Record<string, string>;
    /** Milliseconds; defaults to the timeout the client was created with. */
    timeout?: number;
};

export type HttpResponse = { status: number; data: any };

export type Redactor = (text: any) => string;

export type Logger = (level: string, message: string, data?: any) => void;

export type HttpClient = {
    request: (method: string, url: string, opts?: RequestOptions) => Promise<HttpResponse>;
    http: {
        get: (url: string, opts?: RequestOptions) => Promise<HttpResponse>;
        post: (url: string, body: any, opts?: RequestOptions) => Promise<HttpResponse>;
        put: (url: string, body: any, opts?: RequestOptions) => Promise<HttpResponse>;
        delete: (url: string, opts?: RequestOptions) => Promise<HttpResponse>;
    };
    /** Request timeout in ms plus the time a transfer of `size` bytes needs at 32 KB/s. */
    uploadTimeout: (size: number) => number;
};

export const MAX_FILE_SIZE: number;

export class UploadFile {
    constructor(filePath: string);
    path: string;
}

export function networkCode(err: any): string | undefined;
export function backoff(attempt: number, retryAfter: string | null): Promise<void>;
export function filterNull(obj: Record<string, any>): Record<string, any>;
export function validateId(value: unknown, name: string): void;
export function loadEnv(defaultEnvFile: string): void;
export function createRedactor(cfg: { envKeys: string[]; paramNames: string[] }): Redactor;
export function createLogger(redactSecrets: Redactor): Logger;
export function createHttp(cfg: { timeout: number; redactSecrets: Redactor }): HttpClient;
export function resolveLocalFile(input: string, allowedExtensions: readonly string[]): { resolved: string; fileSize: number };
export function isUrl(input: string): boolean;
export function resolveStatus(value: any): any;
export function checkApiError(data: any): void;
export function parsePlatformPresign(presignData: any): { UploadUrl: string; DownloadUrl: string };
export function readPackageVersion(packageJsonPath: string): string;
export const HEX_COLOR: RegExp;
// A literal tuple so z.enum() accepts it.
export const CROP_LOCATIONS: readonly ['eye_higher', 'below_eye', 'btw_eye_and_nose', 'below_nose',
    'between_nose_and_mouth', 'below_mouth', 'below_chin', 'chest',
    'at_elbow_higher', 'at_elbow_lower', 'waist', 'below_buttock',
    'main_body_axis', 'mid_thigh', 'above_knee', 'at_knee', 'below_knee'];
export const UPLOAD_UNAVAILABLE: string;
export const STATUS_ALIASES: Record<string, string>;
export const AUTOMATION_MIME_TYPES: Record<string, string>;
export const AUTOMATION_UPLOAD_EXTENSIONS: string[];
export const PLATFORM_UPLOAD_EXTENSIONS: string[];
