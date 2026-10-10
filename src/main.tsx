import React from 'react';
import ReactDOM from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';
import './styles.css';
Object.assign(window, { EXCALIDRAW_ASSET_PATH: new URL(`${import.meta.env.BASE_URL}excalidraw/`, location.href).href });
// Load App after setting the self-hosted font path.
void import('./App').then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});
