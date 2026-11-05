// 网页工作台入口
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/interact.css';
import './styles/app.css';
import { App } from './App';
import { applyThemeNow } from './state/prefs';
import { installFolderPicker } from './components/FolderPicker';

applyThemeNow();
installFolderPicker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
