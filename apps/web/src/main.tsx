// 网页工作台入口
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/interact.css';
import './styles/app.css';
import './styles/board.css';
import './styles/lan-access.css';
import { App } from './App';
import { applyThemeNow } from './state/prefs';
import { installFolderPicker } from './components/FolderPicker';
import { installBrowserNotices } from './platform/browser';
import { toast } from './state/ui';

applyThemeNow();
installFolderPicker();
installBrowserNotices(({ title, body }) => toast(`${title} · ${body}`, 'attn'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
