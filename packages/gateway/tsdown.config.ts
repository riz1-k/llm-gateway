import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts', 'mock-provider': 'src/mock-provider.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  tsconfig: 'tsconfig.build.json',
  dts: { tsc: { eager: true } },
  sourcemap: false,
  clean: true,
  fixedExtension: false,
  // The private workspace package is bundled into the published artifact.
  deps: { alwaysBundle: ['@switchyard/mock-provider'] },
});
