type VendorStage = {
  id?: unknown;
  label?: unknown;
  displayOrder?: unknown;
  metadata?: {
    probability?: unknown;
    isClosed?: unknown;
  } | null;
};

type VendorPipeline = {
  id?: unknown;
  label?: unknown;
  displayOrder?: unknown;
  stages?: VendorStage[];
};

type PipelinesResponse = {
  results?: VendorPipeline[];
};

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function displayOrder(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async (input: Input, ctx: Context) => {
  const objectType = input.objectType ?? "deals";
  const res = await ctx.fetch(`/crm/v3/pipelines/${objectType}`);
  if (!res.ok) {
    throw new Error(`GET /crm/v3/pipelines/${objectType} ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as PipelinesResponse;
  const pipelines = (Array.isArray(body.results) ? body.results : [])
    .map((pipeline) => ({
      id: String(pipeline.id ?? ""),
      label: String(pipeline.label ?? ""),
      displayOrder: displayOrder(pipeline.displayOrder),
      stages: (Array.isArray(pipeline.stages) ? pipeline.stages : [])
        .map((stage) => ({
          id: String(stage.id ?? ""),
          label: String(stage.label ?? ""),
          displayOrder: displayOrder(stage.displayOrder),
          probability: nullableNumber(stage.metadata?.probability),
          isClosed: nullableBoolean(stage.metadata?.isClosed),
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder),
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return { pipelines };
};
