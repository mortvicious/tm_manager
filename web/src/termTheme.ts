/**
 * The xterm.js theme for the device's design (docs/magma.md § 9). xterm takes
 * concrete colours, not CSS variables, so these are the terminal tokens of
 * docs/tm-design-tokens.html written out. Classic and Glass keep the original
 * object exactly (xterm's default ANSI palette included); Magma brings its own
 * ANSI set, because the default blue fails on its warm black.
 */
import { useEffect, type RefObject } from 'react';
import type { ITheme, Terminal } from '@xterm/xterm';
import { currentLook, useLook, type Design } from './appearance.ts';

const ORIGINAL: ITheme = { background: '#0a0c0e', foreground: '#d2f5ec', cursor: '#2dd4bf' };

const MAGMA: ITheme = {
  background: '#0a0605',
  foreground: '#f3e6dc',
  cursor: '#ffc93d',
  cursorAccent: '#0a0605',
  selectionBackground: 'rgba(255, 122, 46, 0.32)',
  black: '#2a1c17',
  brightBlack: '#8a6c5e',
  red: '#ff4fa3',
  brightRed: '#ff85c0',
  green: '#6fe39a',
  brightGreen: '#9af0b6',
  yellow: '#ffc93d',
  brightYellow: '#ffe08a',
  blue: '#7ab8ff',
  brightBlue: '#a8d0ff',
  magenta: '#ff6fa8',
  brightMagenta: '#ff9cc4',
  cyan: '#5fd8e0',
  brightCyan: '#8ce8ee',
  white: '#e8d8cc',
  brightWhite: '#fff7f0',
};

/** A fresh object each call: xterm keeps what it is given. */
export function terminalTheme(design: Design = currentLook().design): ITheme {
  return { ...(design === 'magma' ? MAGMA : ORIGINAL) };
}

/** Re-themes a live terminal when the device's design changes. */
export function useTerminalTheme(termRef: RefObject<Terminal | null>) {
  const { design } = useLook();
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(design);
  }, [design, termRef]);
}
