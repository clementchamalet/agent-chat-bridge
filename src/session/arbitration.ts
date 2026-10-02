import type { Engine } from "../types.js";

export interface ArbitrationTarget {
  engine: Engine;
  resumeId: string;
  directory: string;
  tmuxSession: string;
  title: string;
  /** Whether the bridge already has this conversation attached. */
  live: boolean;
}
