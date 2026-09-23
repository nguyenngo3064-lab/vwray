import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * Flat ESLint configuration (ESLint 9).
 *
 * `eslint-config-next/core-web-vitals` ships a flat-config array in v16, so it is
 * spread directly rather than via `extends`.
 */
export default [
  ...nextCoreWebVitals,
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      // The vendored UI skill pack is third-party material, not project source.
      ".agents/**",
      "agent/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Server modules are the only place secrets live; unused vars are usually a
      // sign of an unfinished branch here, so keep it strict but allow `_` prefixes.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["scripts/**/*.ts", "prisma/**/*.ts", "tests/**/*.ts"],
    rules: {
      // Operational scripts legitimately print to stdout.
      "no-console": "off",
    },
  },
];
