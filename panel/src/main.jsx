import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'vazirmatn/Vazirmatn-Variable-font-face.css';
import './styles.css';
import { AppProvider } from './state.jsx';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><AppProvider><App /></AppProvider></BrowserRouter></React.StrictMode>,
);
