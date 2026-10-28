import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { installTouchActive } from './motion.ts';
import { AppProvider } from './state.tsx';
import { applyRememberedWorkspace } from './workspace.ts';
import './theme.css';
// after theme.css: the Glass layer overrides it (docs/glass.md)
import './glass.css';

installTouchActive();
// before the router reads the URL: a bare launch opens in this device's workspace
applyRememberedWorkspace();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
