import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { SiteConfigProvider } from './siteconfig.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <SiteConfigProvider>
        <App />
      </SiteConfigProvider>
    </BrowserRouter>
  </React.StrictMode>
);
