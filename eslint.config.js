import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'load-tests/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Several query-building spots intentionally use `any` for
      // drizzle's dynamically-shaped query builder chains -- flag them,
      // don't fail the build over them.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  }
);
