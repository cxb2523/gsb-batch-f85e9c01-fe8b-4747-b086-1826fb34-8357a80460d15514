/* tslint:disable */
/* eslint-disable */
export class MoogModule {
  private constructor();
  free(): void;
  get_cutoff(): number;
  /**
   * Update the cutoff frequency (normalized).
   * Takes effect on the next `process`/`process_vec` call
   * since the filter coefficients are derived from `cutoff` per block.
   */
  set_cutoff(cutoff: number): void;
  process_vec(samples: Float32Array): Float32Array;
  get_resonance(): number;
  /**
   * Update the resonance.
   * Takes effect on the next `process`/`process_vec` call
   * since the feedback amount is derived from `resonance` per block.
   */
  set_resonance(resonance: number): void;
  static new(cutoff: number, resonance: number): MoogModule;
  process(samples: Float32Array): Float32Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_moogmodule_free: (a: number, b: number) => void;
  readonly moogmodule_get_cutoff: (a: number) => number;
  readonly moogmodule_get_resonance: (a: number) => number;
  readonly moogmodule_new: (a: number, b: number) => number;
  readonly moogmodule_process: (a: number, b: any) => any;
  readonly moogmodule_process_vec: (a: number, b: number, c: number) => [number, number];
  readonly moogmodule_set_cutoff: (a: number, b: number) => void;
  readonly moogmodule_set_resonance: (a: number, b: number) => void;
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
