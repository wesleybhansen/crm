import type { RealtorBenchmarkLabel } from './schemas'

/**
 * Populated only by the controlled metered benchmark. Never add invented
 * provider rows here: each committed row must be sanitized, human-labeled,
 * and traceable to the private benchmark evidence packet by destination hash.
 */
export const REALTOR_BENCHMARK_LABELS: RealtorBenchmarkLabel[] = []
