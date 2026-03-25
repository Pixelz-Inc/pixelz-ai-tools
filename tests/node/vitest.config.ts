import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        environment: 'node',
        env: { NODE_ENV: 'test' },
    },
    resolve: {
        alias: {
            // Force all axios imports to resolve to a single copy so mocks work
            'axios': path.resolve(__dirname, 'node_modules/axios'),
        },
    },
});
