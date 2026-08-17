/**
 * Compiler settings required by generated runtime tool modules.
 *
 * A Next.js standalone bundle contains the app tsconfig but not the root
 * tsconfig it extends. Passing these settings directly keeps esbuild from
 * silently switching TypeScript decorators to the standard proposal at
 * runtime; Mercato entities still use the legacy decorator contract.
 */
export const RUNTIME_TOOL_TSCONFIG = {
  compilerOptions: {
    experimentalDecorators: true,
    useDefineForClassFields: false,
  },
} as const
