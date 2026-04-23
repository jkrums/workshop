import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function readSchema(values: { adapterSchemaValues?: Record<string, unknown> }): Record<string, unknown> {
  return values.adapterSchemaValues ?? {};
}

function patchSchema(
  values: { adapterSchemaValues?: Record<string, unknown> },
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(values.adapterSchemaValues ?? {}), ...patch };
}

export function ClaudeRemoteConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const schema = isCreate ? readSchema(values!) : {};
  return (
    <>
      <Field
        label="Worker Fly app"
        hint="Fly app hosting the worker image. Defaults to WORKSHOP_WORKER_APP env on the control plane."
      >
        <DraftInput
          value={
            isCreate
              ? String(schema.workerAppName ?? "")
              : eff("adapterConfig", "workerAppName", String(config.workerAppName ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ adapterSchemaValues: patchSchema(values!, { workerAppName: v || undefined }) })
              : mark("adapterConfig", "workerAppName", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="workshop-jkrums-workers"
        />
      </Field>
      <Field label="Worker region" hint="Fly region for the ephemeral machine. Default: iad.">
        <DraftInput
          value={
            isCreate
              ? String(schema.workerRegion ?? "")
              : eff("adapterConfig", "workerRegion", String(config.workerRegion ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ adapterSchemaValues: patchSchema(values!, { workerRegion: v || undefined }) })
              : mark("adapterConfig", "workerRegion", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="iad"
        />
      </Field>
      <Field
        label="Timeout (seconds)"
        hint="Adapter waits this long for the worker callback before giving up. Default 900 (15 min)."
      >
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={Number(schema.timeoutSec ?? 900)}
            onChange={(e) =>
              set!({
                adapterSchemaValues: patchSchema(values!, { timeoutSec: Number(e.target.value) || 900 }),
              })
            }
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "timeoutSec", Number(config.timeoutSec ?? 900))}
            onCommit={(v) => mark("adapterConfig", "timeoutSec", v || 900)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}
