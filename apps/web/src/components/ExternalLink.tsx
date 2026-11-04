import {FeedbackNotice} from './FeedbackNotice';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { useState, type ReactNode } from 'react';
import { messageOf } from '../api';

export function ExternalLink({href,children}:{href:string;children:ReactNode}) {
  const [error,setError]=useState('');
  return <><a href={href} target="_blank" rel="noopener noreferrer" onClick={event=>{
    if(!isTauri())return;
    event.preventDefault();setError('');void invoke('integration_open',{url:href}).catch(failure=>setError(typeof failure==='string'?failure:messageOf(failure)));
  }}>{children}</a>{error&&<FeedbackNotice key={error} message={error} error persistent={false}/>}</>;
}
