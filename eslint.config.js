const js = require('@eslint/js');
const globals = require('globals');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

// ESLint 9 uses flat config by default. This mirrors the previous `.eslintrc.js`
// setup: `eslint:recommended` + `@typescript-eslint/recommended` for the TS sources.
module.exports = [
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'tests/data/**'],
    },

    js.configs.recommended,

    ...tsPlugin.configs['flat/recommended'],

    {
        files: ['src/ts/**/*.ts', 'tests/**/*.ts'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.es2021,
            },
        },
    },

    {
        files: ['tests/**/*.ts'],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
        rules: {
            // Tests intentionally reach into private detector/player internals and build fake fibers.
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },

    {
        files: [
            'eslint.config.js',
            '.eslintrc.js',
            'jest.config.js',
            'webpack.config.js',
            'pack.js',
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // These are CommonJS Node scripts where require() is expected.
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
];
