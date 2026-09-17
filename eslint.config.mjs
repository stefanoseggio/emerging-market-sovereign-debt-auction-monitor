import prettierConfig from 'eslint-config-prettier';

import apifyConfig from '@apify/eslint-config/ts.js';

export default [
    { ignores: ['dist', 'node_modules', 'storage'] },
    ...apifyConfig,
    prettierConfig,
    {
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            'no-console': 'error',
            // `xlsx` (SheetJS) publishes real subpath-free package exports with no `.js` suffix -
            // confirmed in its own package.json - so the base config's blanket extension
            // requirement is incorrect for bare package specifiers, the same real finding already
            // made for `csv-parse/sync` in Actor #2.
            'import-x/extensions': ['error', 'ignorePackages'],
        },
    },
    {
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        files: ['eslint.config.mjs'],
        rules: {
            'import-x/no-default-export': 'off',
        },
    },
];
