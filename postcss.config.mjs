/**
 * Tailwind CSS v4 PostCSS pipeline.
 *
 * Tailwind v4 must be wired through `@tailwindcss/postcss`. Using the legacy
 * `tailwindcss` plugin here silently emits no utility classes.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
