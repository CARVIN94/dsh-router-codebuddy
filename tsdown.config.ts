/**
 * tsdown build for dsh-router-codebuddy — HOST half only.
 *
 * Produces `lib/index.js`: the Node host half that registers the codebuddy
 * supplier family (codebuddy + codebuddy-en) into the `router.suppliers`
 * cordis service for dsh-router. cn/en profiles are inlined into the same
 * bundle — one package, one mount row, two suppliers.
 */
import type { UserConfig } from 'tsdown'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: [/^@deepseek-ai\//],
    },
  },
] satisfies UserConfig[]
