/* tslint:disable */
/* eslint-disable */
export class BitcrusherModule {
  private constructor();
  free(): void;
  process_vec(samples: Float32Array, normfreq: number): Float32Array;
  static new(bits: number): BitcrusherModule;
  process(samples: Float32Array, normfreq: number): Float32Array;
  get_bits(): number;
  /**
   * Update the bit depth used for quantization.
   * Takes effect on the next `process`/`process_vec` call
   * since the quantization step is derived from `bits` per block.
   */
  set_bits(bits: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_bitcrushermodule_free: (a: number, b: number) => void;
  readonly bitcrushermodule_get_bits: (a: number) => number;
  readonly bitcrushermodule_new: (a: number) => number;
  readonly bitcrushermodule_process: (a: number, b: any, c: number) => any;
  readonly bitcrushermodule_process_vec: (a: number, b: number, c: number, d: number) => [number, number];
  readonly bitcrushermodule_set_bits: (a: number, b: number) => void;
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
