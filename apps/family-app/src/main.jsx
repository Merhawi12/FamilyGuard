import React from 'react';
import ReactDOM from 'react-dom/client';
import { setTokenKey, setLoginPath } from '@parentix/shared';
import App from './App';
import './index.css';

// Historic key — kept so existing parents are not signed out by the rename.
setTokenKey('fg_token');
setLoginPath('/login');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
