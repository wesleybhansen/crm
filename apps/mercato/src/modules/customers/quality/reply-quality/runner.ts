import baselineDocument from "./baselines/v1.json";
import { evaluateReplyQualityFixtureV1 } from "./evaluator";
import { REPLY_QUALITY_FIXTURE_SET_V1 } from "./fixtures/v1/fixtures";
import { REPLY_QUALITY_RUBRIC } from "./rubric";
import {
  DryRunResultSchema,
  REPLY_RESULT_SCHEMA_VERSION,
  ReplyQualityBaselineV1Schema,
  type DryRunResult,
  type ReplyQualityBaselineV1,
  type ReplyQualityFixtureSetV1,
} from "./schemas";

type RunDryQualityOptions = {
  fixtureSet?: ReplyQualityFixtureSetV1;
  baseline?: ReplyQualityBaselineV1;
  now?: Date;
};

function rate(passed: number, failed: number): number | null {
  const evaluated = passed + failed;
  return evaluated === 0 ? null : passed / evaluated;
}

export const REPLY_QUALITY_BASELINE_V1 =
  ReplyQualityBaselineV1Schema.parse(baselineDocument);

export function runDryReplyQuality(
  options: RunDryQualityOptions = {},
): DryRunResult {
  const fixtureSet = options.fixtureSet ?? REPLY_QUALITY_FIXTURE_SET_V1;
  const baseline = options.baseline ?? REPLY_QUALITY_BASELINE_V1;
  const fixtures = fixtureSet.fixtures.map(evaluateReplyQualityFixtureV1);
  const passedFixtures = fixtures.filter((fixture) => fixture.passed).length;
  const failedFixtures = fixtures.length - passedFixtures;
  const overallPassRate =
    fixtures.length === 0 ? 0 : passedFixtures / fixtures.length;
  const failures: string[] = [];

  if (fixtures.length !== baseline.fixtureCount) {
    failures.push(
      `Fixture count ${fixtures.length} does not match baseline count ${baseline.fixtureCount}.`,
    );
  }
  if (overallPassRate < baseline.minimumOverallPassRate) {
    failures.push(
      `Overall pass rate ${overallPassRate.toFixed(4)} is below minimum ${baseline.minimumOverallPassRate.toFixed(4)}.`,
    );
  }

  const criteria = REPLY_QUALITY_RUBRIC.map((definition) => {
    const criterionResults = fixtures.flatMap((fixture) =>
      fixture.criteria.filter(
        (criterion) => criterion.criterionId === definition.id,
      ),
    );
    const passed = criterionResults.filter(
      (criterion) => criterion.status === "passed",
    ).length;
    const failed = criterionResults.filter(
      (criterion) => criterion.status === "failed",
    ).length;
    const skipped = criterionResults.filter(
      (criterion) => criterion.status === "skipped",
    ).length;
    const passRate = rate(passed, failed);
    const baselinePassRate =
      baseline.referenceCriterionPassRates[definition.id] ?? null;
    const minimumPassRate =
      baseline.criterionMinimumPassRates[definition.id] ?? null;
    const delta =
      passRate === null || baselinePassRate === null
        ? null
        : passRate - baselinePassRate;

    if (
      minimumPassRate !== null &&
      passRate !== null &&
      passRate < minimumPassRate
    ) {
      failures.push(
        `Criterion ${definition.id} pass rate ${passRate.toFixed(4)} is below minimum ${minimumPassRate.toFixed(4)}.`,
      );
    }
    if (
      baseline.hardCriteriaMustPass &&
      definition.kind === "hard" &&
      failed > 0
    ) {
      failures.push(
        `Hard criterion ${definition.id} has ${failed} failure(s).`,
      );
    }

    return {
      criterionId: definition.id,
      kind: definition.kind,
      passed,
      failed,
      skipped,
      passRate,
      baselinePassRate,
      delta,
      minimumPassRate,
    };
  });

  for (const fixture of fixtures) {
    for (const result of fixture.criteria) {
      if (result.status === "failed") {
        failures.push(
          `${fixture.fixtureId}/${result.criterionId}: ${result.reason}`,
        );
      }
    }
  }

  return DryRunResultSchema.parse({
    schemaVersion: REPLY_RESULT_SCHEMA_VERSION,
    mode: "dry-run",
    status: failures.length === 0 ? "passed" : "failed",
    fixtureSetVersion: fixtureSet.fixtureSetVersion,
    generatedAt: (options.now ?? new Date()).toISOString(),
    summary: {
      fixtureCount: fixtures.length,
      passedFixtures,
      failedFixtures,
      overallPassRate,
      baselineDelta: overallPassRate - baseline.referenceOverallPassRate,
    },
    criteria,
    fixtures,
    failures,
  });
}
