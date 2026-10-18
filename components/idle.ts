'use client';

// Time since the last pointer, key, touch or scroll input in this tab (shared by the background refreshers).
let lastInput = Date.now();
let listening = false;

export function idleFor(): number {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    const mark = () => { lastInput = Date.now(); };
    for (const e of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll']) window.addEventListener(e, mark, { passive: true, capture: true });
  }
  return Date.now() - lastInput;
}
