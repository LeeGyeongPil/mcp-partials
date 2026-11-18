// 작은 조각 묶기: coalesceMs 시간 창 안에 들어온 조각들을 한 번의 진행 알림으로 보낸다.
// 스펙은 진행 알림에 속도 제한을 두라고(SHOULD) 권한다 — 한 글자씩 yield 하는 도구도 알림 폭주가 없게.
import { mergeContent } from './final.js';
import type { ContentBlock } from './types.js';

export class Coalescer {
  private buffer: ContentBlock[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param windowMs 0 means "send every chunk right away".
   * @param emit called with the merged content of one batch.
   */
  constructor(
    private readonly windowMs: number,
    private readonly emit: (content: ContentBlock[]) => void,
  ) {}

  add(content: ContentBlock[]): void {
    if (this.windowMs <= 0) {
      this.emit(content);
      return;
    }
    this.buffer.push(...content);
    // 창의 첫 조각에서만 타이머를 건다 — 창이 끝나면 그동안 모인 것을 한 번에 보낸다.
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
    }
  }

  /** Send whatever is buffered now (called before the final result). */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;
    const batch = mergeContent(this.buffer);
    this.buffer = [];
    this.emit(batch);
  }

  /** Drop the buffer and the timer without sending (cancellation path). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer = [];
  }
}
