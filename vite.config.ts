import { defineConfig } from 'vite-plus';

export default defineConfig({
  // Credentials are read by Node at runtime, never loaded into the build.
  envDir: false,
  publicDir: false,
  ssr: {
    target: 'node',
    external: ['discord.js', 'zod'],
  },
  build: {
    ssr: 'src/main.ts',
    target: 'node22',
    outDir: 'dist',
    rolldownOptions: {
      output: {
        format: 'es',
        entryFileNames: 'main.js',
      },
    },
  },
});
