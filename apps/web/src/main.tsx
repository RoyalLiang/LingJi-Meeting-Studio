import { createRoot } from 'react-dom/client';
import App from './App';
import { isTauri } from '@tauri-apps/api/core';
import { RecordingWidget } from './components/RecordingWidget';
import './styles.css';
const widgetMode=isTauri() && location.hash==='#recording-widget';
document.documentElement.classList.toggle('webview2',isTauri() && /Windows/.test(navigator.userAgent));
document.documentElement.classList.toggle('recording-capsule-mode',widgetMode);
createRoot(document.getElementById('root')!).render(widgetMode ? <RecordingWidget/> : <App/>);
