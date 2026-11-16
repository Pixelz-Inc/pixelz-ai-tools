import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        env: { NODE_ENV: 'test' },
        // Tests that spawn Python CLIs (or pay first-import cost under load) exceed vitest's 5 s default on Windows.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
