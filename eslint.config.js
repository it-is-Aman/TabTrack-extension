import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['dist/', 'coverage/', 'node_modules/'] },
    js.configs.recommended,
    {
        files: ['src/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.webextensions },
        },
    },
    {
        files: ['tests/**/*.js', 'scripts/**/*.js', '*.config.js'],
        languageOptions: {
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'prefer-const': 'error',
        },
    },
];
