import { Schema } from "effect";
import {
  ProductDecisionReportSchema,
  TrialManifestSchema,
  TrialRecordSchema,
  decodeUnknownStrict,
  type ProductDecisionReport,
  type TrialManifest,
  type TrialRecord,
} from "../../packages/protocol/src/index.ts";

const TrialMeasuresSchema = Schema.Struct({
  correctnessScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  verificationPassed: Schema.Boolean,
  safetyViolations: Schema.Array(Schema.String),
  recoveryRequired: Schema.Boolean,
  recoverySucceeded: Schema.Boolean,
  operatorInterventions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  isolationViolations: Schema.Array(Schema.String),
  reconstructable: Schema.Boolean,
  profileDigest: Schema.NonEmptyString,
  configurationCopied: Schema.Boolean,
  modelToolConsumption: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  completionLatencyMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  directCostUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  frictionCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type TrialMeasures = typeof TrialMeasuresSchema.Type;

export interface ComparativeTrialInput {
  readonly manifests: ReadonlyArray<unknown>;
  readonly records: ReadonlyArray<unknown>;
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const decodeMeasures = (record: TrialRecord): TrialMeasures =>
  decodeUnknownStrict(TrialMeasuresSchema, record.measures);

const completed = (record: TrialRecord): boolean => record.result._tag === "Completed";

const armRecords = (
  records: ReadonlyArray<TrialRecord>,
  arm: TrialRecord["arm"],
): ReadonlyArray<TrialRecord> => records.filter((record) => record.arm === arm);

const qualifies = (
  records: ReadonlyArray<TrialRecord>,
  requireReusableProfile: boolean,
): boolean => {
  const measures = records.map(decodeMeasures);
  const profileDigests = new Set(measures.map((measure) => measure.profileDigest));
  return (
    records.length > 0 &&
    records.every(completed) &&
    measures.every(
      (measure) =>
        measure.verificationPassed &&
        measure.safetyViolations.length === 0 &&
        measure.isolationViolations.length === 0 &&
        (!measure.recoveryRequired || measure.recoverySucceeded) &&
        measure.reconstructable,
    ) &&
    (!requireReusableProfile ||
      (profileDigests.size === 1 && measures.every((measure) => !measure.configurationCopied)))
  );
};

const aggregate = (records: ReadonlyArray<TrialRecord>) => {
  const measures = records.map(decodeMeasures);
  return {
    correctness: mean(measures.map((measure) => measure.correctnessScore)),
    recoveryInterventions: measures
      .filter((measure) => measure.recoveryRequired)
      .reduce((total, measure) => total + measure.operatorInterventions, 0),
    isolationViolations: measures.reduce(
      (total, measure) => total + measure.isolationViolations.length,
      0,
    ),
    reconstructable: measures.filter((measure) => measure.reconstructable).length,
    friction: measures.reduce((total, measure) => total + measure.frictionCount, 0),
    modelToolConsumption: measures.reduce(
      (total, measure) => total + measure.modelToolConsumption,
      0,
    ),
    medianLatencyMs: median(measures.map((measure) => measure.completionLatencyMs)),
    medianCostUsd: median(measures.map((measure) => measure.directCostUsd)),
  };
};

const materiallyLower = (treatment: number, baseline: number): boolean =>
  baseline === 0 ? false : treatment <= baseline * 0.9;

export const evaluateComparativeTrials = (input: ComparativeTrialInput): ProductDecisionReport => {
  const manifests = input.manifests.map((manifest) =>
    decodeUnknownStrict(TrialManifestSchema, manifest),
  );
  const records = input.records.map((record) => decodeUnknownStrict(TrialRecordSchema, record));
  const manifestById = new Map(manifests.map((manifest) => [manifest.trialId, manifest]));

  if (manifestById.size !== manifests.length)
    throw new Error("trialId must identify exactly one manifest");
  for (const record of records) {
    if (!manifestById.has(record.trialId))
      throw new Error(`record references unknown trial ${record.trialId}`);
  }
  for (const manifest of manifests) {
    const matching = records.filter((record) => record.trialId === manifest.trialId);
    for (const arm of ["baseline", "treatment"] as const) {
      const runs = armRecords(matching, arm);
      if (runs.length < 3)
        throw new Error(`${manifest.trialId}/${arm} requires at least three runs`);
      if (new Set(runs.map((record) => record.sessionId)).size !== runs.length) {
        throw new Error(`${manifest.trialId}/${arm} must use fresh Session identities`);
      }
    }
  }

  const baselineRecords = armRecords(records, "baseline");
  const treatmentRecords = armRecords(records, "treatment");
  const baseline = aggregate(baselineRecords);
  const treatment = aggregate(treatmentRecords);
  const baselineQualifies = qualifies(baselineRecords, false);
  const treatmentQualifies = qualifies(treatmentRecords, true);
  const correctnessImproved = treatment.correctness > baseline.correctness;
  const improvements = {
    recoveryInterventions: treatment.recoveryInterventions < baseline.recoveryInterventions,
    concurrencyIsolation: treatment.isolationViolations < baseline.isolationViolations,
    reconstructability: treatment.reconstructable > baseline.reconstructable,
    coldAgentFriction: treatment.friction < baseline.friction,
    modelToolConsumption: materiallyLower(
      treatment.modelToolConsumption,
      baseline.modelToolConsumption,
    ),
  };
  const improvementCount = Object.values(improvements).filter(Boolean).length;
  const latencyWithinThreshold = treatment.medianLatencyMs <= baseline.medianLatencyMs * 1.2;
  const costWithinThreshold = treatment.medianCostUsd <= baseline.medianCostUsd * 1.2;
  const overheadAccepted = (latencyWithinThreshold && costWithinThreshold) || correctnessImproved;
  const expand =
    treatmentQualifies &&
    treatment.correctness >= baseline.correctness &&
    improvementCount >= 2 &&
    overheadAccepted;
  const decision = expand ? "expand" : baselineQualifies ? "collapse" : "reject";
  const reasons = expand
    ? ["Treatment met every safety/recovery bar and materially improved at least two measures."]
    : baselineQualifies
      ? ["Harness-native baseline met the product bar without enough treatment advantage."]
      : ["Neither the treatment expansion case nor the harness-native collapse case met the bar."];

  return decodeUnknownStrict(ProductDecisionReportSchema, {
    _tag: "ProductDecisionReport",
    decision,
    reasons,
    thresholdResults: {
      baselineQualifies,
      treatmentQualifies,
      correctnessImproved,
      improvementCount,
      improvements,
      latencyWithinThreshold,
      costWithinThreshold,
      overheadAccepted,
      baseline,
      treatment,
    },
    records,
  });
};

export type { TrialManifest, TrialRecord };
