import { TCompiled, blockProcessorSource, paramName } from "$library/blockCompiler";

import { STOP_MESSAGE } from "$library/expression";
import { SignalNode } from "../lib/signalNode";
import type { TPair } from "./routing";
import type { TSwitchedProgram } from "./switching";
import { ctx } from "../ctx";
import { defineRuntimeWorklet } from "../lib/runtimeWorklet";
import { pipe } from "../lib/pipe";

// Скомпилированный блок, который сейчас звучит
export type TProgram = TSwitchedProgram<AudioNode>;

export type TBuildOptions = {
  key: string;
  result: TCompiled;
  signals: unknown[];
  defaults: number[];
  outer(id: string): AudioNode;
  onError(): void;
  signal?: AbortSignal;
};

// Сборка отменена: результат никому не нужен и не должен создавать узлы
export class BuildAbortError extends Error {
  name = 'AbortError';
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new BuildAbortError('Compiled block build was cancelled');
};

// Один AudioWorkletNode на весь блок: вход процессора на каждый входной слот, выход — на выходной.
// Каждый вход и выход — один канал: внутри блока всё моно, как и у параметров нод.
export async function buildProgram({ key, result, signals, defaults, outer, onError, signal }: TBuildOptions): Promise<TProgram> {
  const passthrough = result.passthrough.map(([a, b]): TPair<AudioNode> => [outer(a), outer(b)]);

  throwIfAborted(signal);

  if (!result.outputs.length)
    return { key, signals, passthrough, stop() { } };

  const processor = await defineRuntimeWorklet(`block:${result.source}`, name => blockProcessorSource(name, result));

  // Модуль грузился асинхронно: если блок успели выключить или удалить, узел не создаём вовсе
  throwIfAborted(signal);

  const node = new AudioWorkletNode(ctx, processor, {
    numberOfInputs: result.inputs.length,
    numberOfOutputs: result.outputs.length,
    outputChannelCount: result.outputs.map(() => 1),
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });

  var stopped = false;
  var errored = false;
  const unwire: (() => void)[] = [];

  // Снимает все соединения узла: и с целями блока, и с параметрами. Повторный вызов безопасен.
  const stop = () => {
    if (stopped)
      return;

    stopped = true;
    node.onprocessorerror = null;

    for (const disconnect of unwire.splice(0))
      try {
        disconnect();
      } catch (error) {
        console.error(error);
      }

    // Последняя страховка: что бы ни осталось подключённым, звук из узла дальше не идёт
    try {
      node.disconnect();
    } catch (error) {
      console.error(error);
    }

    try {
      node.port.postMessage(STOP_MESSAGE);
    } catch (error) {
      console.error(error);
    }
  };

  try {
    for (const [id, k] of result.inputs.map((id, k) => [id, k] as const)) {
      const gain = outer(id);
      gain.connect(node, 0, k);
      unwire.push(() => gain.disconnect(node, 0, k));
    }

    for (const [id, k] of result.outputs.map((id, k) => [id, k] as const)) {
      const gain = outer(id);
      node.connect(gain, k, 0);
      unwire.push(() => node.disconnect(gain, k, 0));
    }

    for (let k = 0; k < result.params.length; k++) {
      const param = node.parameters.get(paramName(k))!;
      const value = signals[k];

      // Значение без провода идёт из ConstantSourceNode самой ноды: ручки работают без перекомпиляции
      if (value instanceof SignalNode) {
        param.value = 0;
        unwire.push(pipe(value.node, param));
      } else
        param.value = defaults[k] ?? 0;
    }
  } catch (error) {
    // Полусобранная программа не должна оставить висящих соединений
    stop();
    throw error;
  }

  node.onprocessorerror = () => {
    if (stopped)
      return;

    errored = true;
    onError();
  };

  return { key, signals, passthrough, stop, failed: () => errored };
}
