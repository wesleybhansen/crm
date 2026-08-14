export function filterEntityIdsByModules(
  entityIds: string[],
  moduleIds?: string[],
): string[] {
  if (!moduleIds) return entityIds
  const enabledModules = new Set(moduleIds.map((moduleId) => moduleId.trim()).filter(Boolean))
  return entityIds.filter((entityId) => enabledModules.has(entityId.split(':', 1)[0] ?? ''))
}
