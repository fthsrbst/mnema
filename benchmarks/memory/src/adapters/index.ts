import type { MemoryBenchAdapter } from "../types.js";
import { LettaAdapter } from "./letta.js";
import { LiteralAdapter } from "./literal.js";
import { Mem0Adapter } from "./mem0.js";
import { MnemaAdapter } from "./mnema.js";
import { ZepAdapter } from "./zep.js";

export const adapterNames = ["literal", "mnema", "mem0", "letta", "zep"] as const;
export type AdapterName = (typeof adapterNames)[number];

export function createAdapter(name: string): MemoryBenchAdapter {
  if (name === "literal") return new LiteralAdapter();
  if (name === "mnema") return new MnemaAdapter();
  if (name === "mem0") return new Mem0Adapter();
  if (name === "letta") return new LettaAdapter();
  if (name === "zep") return new ZepAdapter();
  throw new Error(`unknown adapter '${name}'; expected one of: ${adapterNames.join(", ")}`);
}
