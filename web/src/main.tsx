import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { installTouchActive } from './motion.ts';
import { AppProvider } from './state.tsx';
import './theme.css';
// after theme.css: the Glass layer overrides it (docs/glass.md)
import './glass.css';

installTouchActive();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
