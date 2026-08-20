import './style.css';
import { Game } from './game/game';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #game canvas');
}

const game = new Game(canvas);
game.start();

// Handy while tuning the animation: inspect live state from the dev console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).pwnage = game;
}

// Vite hot reload would otherwise stack a second game loop on every save.
if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
