import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        restoreMocks: true,
        coverage: {
            include: ['src/lib/**/*.js'],
            reporter: ['text', 'html'],
        },
    },
});
