export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'run'
  | 'interact' | 'flashlight' | 'eyes' | 'inventory' | 'pause'
  | 'confirm' | 'cancel' | 'up' | 'down';

const BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE', 'Enter', 'NumpadEnter'],
  flashlight: ['KeyF'],
  eyes: ['Space'],
  inventory: ['Tab', 'KeyI'],
  pause: ['Escape', 'KeyP'],
  confirm: ['KeyE', 'Enter', 'NumpadEnter', 'Space'],
  cancel: ['Escape', 'Backspace', 'KeyQ', 'Tab'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
};

const PREVENT = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Keyboard + mouse state with per-frame edge detection and pointer lock. */
export class Input {
  private down = new Set<string>();
  private pressedCodes = new Set<string>();
  private consumed = new Set<string>();
  private buttons = new Set<number>();
  private buttonsPressed = new Set<number>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** last key code pressed this frame (for number shortcuts) */
  lastKey: string | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
      if (!e.repeat) {
        this.pressedCodes.add(e.code);
        this.lastKey = e.code;
      }
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.buttons.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Some browsers emit occasional huge spikes right after locking.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      this.buttons.add(e.button);
      this.buttonsPressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      this.mouseDX = this.mouseDY = 0;
      this.onLockChange?.(this.locked);
    });
  }

  isDown(a: Action): boolean {
    return BINDINGS[a].some((c) => this.down.has(c));
  }

  /** True on the frame the action was pressed (left click counts as interact/confirm while locked). */
  pressed(a: Action): boolean {
    const key = BINDINGS[a].some((c) => this.pressedCodes.has(c) && !this.consumed.has(c));
    if (key) return true;
    if ((a === 'interact' || a === 'confirm') && this.locked && this.buttonsPressed.has(0) && !this.consumed.has('mouse0')) return true;
    return false;
  }

  /** Mark an action as handled so nothing else reacts to it this frame. */
  consume(a: Action): void {
    for (const c of BINDINGS[a]) if (this.pressedCodes.has(c)) this.consumed.add(c);
    if (a === 'interact' || a === 'confirm') this.consumed.add('mouse0');
  }

  keyPressed(code: string): boolean {
    return this.pressedCodes.has(code) && !this.consumed.has(code);
  }

  mouseHeld(button: number): boolean {
    return this.buttons.has(button);
  }

  requestLock(): void {
    if (this.locked) return;
    try {
      const r = this.target.requestPointerLock?.() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined);
    } catch {
      /* the browser may refuse (e.g. cooldown after Esc); the next click retries */
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  endFrame(): void {
    this.pressedCodes.clear();
    this.consumed.clear();
    this.buttonsPressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.lastKey = null;
  }
}
