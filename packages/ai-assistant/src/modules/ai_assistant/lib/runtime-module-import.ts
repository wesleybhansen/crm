/**
 * Import a module whose URL is only known at runtime.
 *
 * Next.js bundles the AI assistant routes for its standalone server. A direct
 * `import(specifier)` is rewritten into a webpack context in that build, which
 * cannot resolve generated files created after the bundle was emitted. Keeping
 * the native import expression inside `Function` leaves resolution to Node.js
 * in both bundled and unbundled processes.
 */
export async function importRuntimeModule<T>(specifier: string): Promise<T> {
  const nativeImport = new Function('specifier', 'return import(specifier)') as (
    runtimeSpecifier: string,
  ) => Promise<T>

  return nativeImport(specifier)
}
