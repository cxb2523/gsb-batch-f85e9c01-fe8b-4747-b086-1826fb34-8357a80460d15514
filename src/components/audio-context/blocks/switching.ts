import { Routing, TPair } from "./routing";

// Состояние блока: звучат внутренние ноды (мосты) или скомпилированный процессор
export type TSwitchState = 'off' | 'building' | 'compiled' | 'failed';

// Программа, которую можно поставить на место мостов. `stop` обязан снять все соединения
// своего AudioWorkletNode и освободить параметры.
export type TSwitchedProgram<N> = {
  key: string;
  signals: unknown[];
  passthrough: TPair<N>[];
  stop(): void;
  // Процессор уже сообщил об ошибке (например, сразу после сборки). Установка такой
  // программы бессмысленна: ProgramSwitch сразу вернётся к мостам.
  failed?(): boolean;
};

// Запрос на сборку: ключ графа, живые параметры и фабрика. AbortSignal позволяет бросить
// работу, если пользователь успел переключить состояние или удалить блок. `isCurrent`
// отвечает, всё ещё звучит ли собранная этим запросом программа (для поздних ошибок).
export type TSwitchRequest<N> = {
  key: string;
  signals: unknown[];
  build(signal: AbortSignal, isCurrent: () => boolean): Promise<TSwitchedProgram<N>>;
};

export type TProgramSwitchOptions<N> = {
  // Соединения, которые ведёт блок: мосты слотов либо прямые «вход → выход»
  routing: Routing<N>;
  // Мосты по текущим слотам; вызывается в момент восстановления
  bridges(): TPair<N>[];
  onProgram?(program: TSwitchedProgram<N> | null): void;
  onError?(reason: string): void;
};

export const BUILD_ERROR = 'Cannot load the compiled block';
export const RUNTIME_ERROR = 'Compiled block stopped with an error';

const sameSignals = (a: readonly unknown[], b: readonly unknown[]) => (
  a.length === b.length && a.every((value, i) => value === b[i])
);

const release = <N,>(program: TSwitchedProgram<N>) => {
  try {
    program.stop();
  } catch (error) {
    console.error(error);
  }
};

// Единственная точка переключения «мосты ↔ процессор». Все переходы проходят здесь:
//   - при включении сначала снимаются мосты, затем собирается ровно одна программа;
//   - при выключении/ошибке сначала останавливается и освобождается программа, затем
//     восстанавливаются мосты по текущим слотам;
//   - поздний результат устаревшей сборки освобождается и не трогает состояние.
export class ProgramSwitch<N> {
  #routing: Routing<N>;
  #bridges: () => TPair<N>[];
  #onProgram?: (program: TSwitchedProgram<N> | null) => void;
  #onError?: (reason: string) => void;

  #wanted = false;
  #state: TSwitchState = 'off';
  #program: TSwitchedProgram<N> | null = null;
  #pending: TSwitchRequest<N> | null = null;
  #abort: AbortController | null = null;
  #generation = 0;
  #disposed = false;

  constructor({ routing, bridges, onProgram, onError }: TProgramSwitchOptions<N>) {
    this.#routing = routing;
    this.#bridges = bridges;
    this.#onProgram = onProgram;
    this.#onError = onError;
  }

  get state(): TSwitchState {
    return this.#state;
  }

  get program(): TSwitchedProgram<N> | null {
    return this.#program;
  }

  // Пользователь хочет скомпилированный блок (переключатель включён)
  get enabled(): boolean {
    return this.#wanted;
  }

  // Сборка ещё не завершилась
  get building(): boolean {
    return this.#state === 'building';
  }

  // Включить намерение без запуска сборки: нужно, чтобы ошибки валидации графа
  // тоже вернули блок к мостам, а не оставили его в неопределённом состоянии.
  want() {
    if (this.#disposed)
      return;

    this.#wanted = true;
  }

  // Привести программу к запросу. Если уже звучит (или собирается) ровно она — ничего не делаем.
  request(request: TSwitchRequest<N>) {
    if (this.#disposed)
      return;

    this.#wanted = true;

    if (this.#state === 'compiled' && this.#program && this.#matches(request, this.#program))
      return;

    if (this.#state === 'building' && this.#pending && this.#matches(request, this.#pending))
      return;

    this.#start(request);
  }

  // Выключить компиляцию: снять программу, затем вернуть мосты
  disable() {
    if (this.#disposed)
      return;

    this.#wanted = false;
    this.#invalidate();
    this.#stopProgram();
    this.#state = 'off';
    this.#restoreBridges();
  }

  // Программа сломалась (ошибка процессора) или граф не компилируется: звучим мостами
  fail(reason = RUNTIME_ERROR) {
    if (this.#disposed || !this.#wanted)
      return;

    this.#invalidate();
    this.#stopProgram();
    this.#state = 'failed';
    this.#restoreBridges();
    this.#onError?.(reason);
  }

  // Слоты изменились, пока блок не компилируется — мосты должны совпасть с ними
  syncBridges() {
    if (this.#disposed)
      return;

    if (this.#state === 'off' || this.#state === 'failed')
      this.#restoreBridges();
  }

  dispose() {
    if (this.#disposed)
      return;

    this.#disposed = true;
    this.#wanted = false;
    this.#invalidate();
    this.#stopProgram();
    this.#state = 'off';
    // Соединения снимает владелец блока: блок уже разрушается
  }

  #matches(request: TSwitchRequest<N>, current: Pick<TSwitchedProgram<N>, 'key' | 'signals'>) {
    return request.key === current.key && sameSignals(request.signals, current.signals);
  }

  #invalidate() {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#pending = null;
  }

  #restoreBridges() {
    this.#routing.set(this.#bridges());
  }

  #stopProgram() {
    const program = this.#program;

    if (!program)
      return;

    this.#program = null;
    release(program);
    this.#onProgram?.(null);
  }

  #start(request: TSwitchRequest<N>) {
    // Всё, что было запрошено раньше, уже не актуально
    this.#invalidate();

    const generation = this.#generation;
    const abort = new AbortController();
    var built: TSwitchedProgram<N> | null = null;
    const isCurrent = () => (
      !this.#disposed &&
      this.#state === 'compiled' &&
      this.#program !== null &&
      this.#program === built
    );

    this.#abort = abort;
    this.#pending = request;

    // Пересборка уже звучащей программы: прямые «вход → выход» можно оставить —
    // Routing снимет только лишние пары, не трогая сохранившиеся. В остальных случаях
    // сначала снимаются мосты: между слотами встанет процессор.
    const rebuilding = this.#state === 'compiled';

    this.#stopProgram();

    if (!rebuilding)
      this.#routing.set([]);

    this.#state = 'building';

    let pending: Promise<TSwitchedProgram<N>>;

    try {
      pending = Promise.resolve(request.build(abort.signal, isCurrent));
    } catch (error) {
      this.#failBuild(error);
      return;
    }

    pending.then(program => {
      // Пока грузился модуль, пользователь мог переключить состояние, изменить граф
      // или удалить блок. Такой результат обязан быть освобождён и забыт.
      if (
        this.#disposed ||
        generation !== this.#generation ||
        this.#pending !== request
      ) {
        release(program);
        return;
      }

      built = program;
      this.#pending = null;
      this.#abort = null;
      this.#program = program;
      this.#state = 'compiled';

      try {
        this.#routing.set(program.passthrough);
      } catch (error) {
        this.#failBuild(error, program);
        return;
      }

      this.#onProgram?.(program);

      // Ошибка могла прийти, пока шла установка: такой процессор не должен звучать
      if (program.failed?.())
        this.fail();
    }, error => {
      if (
        this.#disposed ||
        generation !== this.#generation ||
        this.#pending !== request
      )
        return;

      this.#failBuild(error);
    });
  }

  #failBuild(error: unknown, program?: TSwitchedProgram<N>) {
    console.error(error);
    this.#invalidate();

    // Программа, которую не успели (или не смогли) принять, всё равно должна быть освобождена
    if (program && this.#program !== program)
      release(program);

    this.#stopProgram();
    this.#state = 'failed';
    this.#restoreBridges();
    this.#onError?.(BUILD_ERROR);
  }
}
