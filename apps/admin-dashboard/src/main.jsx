import React from 'react';
import ReactDOM from 'react-dom/client';
import { setTokenKey, setLoginPath } from '@parentix/shared';
import App from './App.jsx';
import './index.css';

// Keep the staff session in its own storage slot so it can never be confused
// with a parent session when both apps are served from localhost in development.
setTokenKey('px_admin_token');
setLoginPath('/login');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
