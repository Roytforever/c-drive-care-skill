import { useCallback, useEffect, useRef, useState } from 'react';

const initial = {version:'1.0',drives:[],caches:[],history:[],operations:[],scan:{status:'idle',directories:[],largeFiles:[],filesCount:0,dirsCount:0,totalBytes:0,errors:0,skipped:0}};

export function useLocalService() {
  const [state,setState] = useState(initial);
  const [connected,setConnected] = useState(false);
  const [error,setError] = useState('');
  const [lastSeen,setLastSeen] = useState(null);
  const token = useRef('');
  const mounted = useRef(false);
  const refresh = useCallback(async()=>{
    const response=await fetch('/api/state',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error(`本地服务响应异常（${response.status}），请确认已通过启动脚本运行。`);
    const next=await response.json();
    if(!next.csrfToken || !Array.isArray(next.drives)) throw new Error('本地服务返回了无法识别的数据。');
    token.current=next.csrfToken;
    if(mounted.current){setState({...initial,...next,scan:{...initial.scan,...next.scan}});setConnected(true);setError('');setLastSeen(new Date());}
    return next;
  },[]);
  useEffect(()=>{
    mounted.current=true; let stopped=false,timer;
    async function poll(){
      let delay=10000;
      try {const next=await refresh();if(next.scan?.status==='running'||next.operations?.some(item=>item.status==='running'))delay=1000;}
      catch(err){if(!stopped){setConnected(false);setError(err.message||'连接本地服务失败。');}}
      if(!stopped)timer=setTimeout(poll,delay);
    }
    poll();
    return()=>{stopped=true;mounted.current=false;clearTimeout(timer);};
  },[refresh]);
  const post=useCallback(async(path,body={})=>{
    if(!token.current) throw new Error('本地服务尚未连接，请稍后重试。');
    const response=await fetch(`/api/${path}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Liubai-Token':token.current},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({error:`服务响应异常（${response.status}）`}));
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message||result.message||`请求失败（${response.status}）`);
    return result;
  },[]);
  return {state,connected,error,lastSeen,refresh,post};
}
