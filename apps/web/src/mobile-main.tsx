import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp';
import { initializeTheme } from './native-theme';
import { registerMobileOffline } from './mobile-offline';

initializeTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
createRoot(document.getElementById('root')!).render(<MobileApp/>);
registerMobileOffline();
