import './style.css';
import { audio } from './core/audio';
import { Game } from './game/game';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #game canvas');
}

const game = new Game(canvas);
game.start();

// Handy while tuning the animation: inspect live state from the dev console.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.pwnage = game;
  // Handy for metering the band while tuning the mix.
  w.pwnageAudio = audio;
}

// Vite hot reload would otherwise stack a second game loop on every save.
if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
