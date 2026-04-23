// Minimal Fly Machines API client used by the claude_remote adapter.
//
// Docs: https://docs.machines.dev/#tag/Machines
// The API lives at https://api.machines.dev and accepts a personal/org FLY_API_TOKEN.

const FLY_MACHINES_API = "https://api.machines.dev/v1";

export interface FlyMachineSpec {
  image: string;
  env?: Record<string, string>;
  auto_destroy?: boolean;
  restart?: { policy: "no" | "on-failure" | "always" };
  guest?: {
    cpu_kind?: "shared" | "performance";
    cpus?: number;
    memory_mb?: number;
  };
  // We do NOT expose services — workers are outbound-only (they POST back to
  // the control plane via PAPERCLIP_CALLBACK_URL). No open ports.
}

export interface CreateMachineInput {
  app: string;
  name?: string;
  region?: string;
  config: FlyMachineSpec;
  token: string;
}

export interface CreatedMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id: string;
}

export async function createMachine(input: CreateMachineInput): Promise<CreatedMachine> {
  const res = await fetch(`${FLY_MACHINES_API}/apps/${encodeURIComponent(input.app)}/machines`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...(input.name ? { name: input.name } : {}),
      ...(input.region ? { region: input.region } : {}),
      config: input.config,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`fly: createMachine failed ${res.status} ${res.statusText}: ${bodyText.slice(0, 512)}`);
  }
  return (await res.json()) as CreatedMachine;
}

export interface MachineStatus {
  id: string;
  state: string; // "created" | "starting" | "started" | "stopping" | "stopped" | "destroyed" | ...
  instance_id: string;
  events?: Array<{ type: string; status: string; timestamp: number }>;
}

export async function getMachine(app: string, machineId: string, token: string): Promise<MachineStatus> {
  const res = await fetch(
    `${FLY_MACHINES_API}/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`fly: getMachine failed ${res.status}: ${bodyText.slice(0, 256)}`);
  }
  return (await res.json()) as MachineStatus;
}

// Force-destroy a machine. Safe to call after auto_destroy has fired (returns
// 404, which we swallow).
export async function destroyMachine(app: string, machineId: string, token: string): Promise<void> {
  const res = await fetch(
    `${FLY_MACHINES_API}/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}?force=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok && res.status !== 404) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`fly: destroyMachine failed ${res.status}: ${bodyText.slice(0, 256)}`);
  }
}
