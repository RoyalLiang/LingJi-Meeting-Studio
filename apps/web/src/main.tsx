import { createRoot } from 'react-dom/client';
import App from './App';
import { isTauri } from '@tauri-apps/api/core';
import { RecordingWidget } from './components/RecordingWidget';
import './styles.css';
createRoot(document.getElementById('root')!).render(isTauri() && location.hash==='#recording-widget' ? <RecordingWidget/> : <App/>);
