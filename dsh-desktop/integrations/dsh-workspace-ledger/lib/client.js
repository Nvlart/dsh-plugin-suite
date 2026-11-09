window.__ModuleLoader__.load({id:'@local/dsh-workspace-ledger',factory:(require)=>{
 const React=require('react'),h=React.createElement,createPortal=require('react-dom').createPortal;
 const statusNames={todo:'待办',doing:'进行中',blocked:'受阻',paused:'已暂停',review:'待核验',done:'已结束（记录）'};
 const fileNames={unchanged:'内容哈希未变',changed:'内容已变化，需核实',missing:'文件缺失',unavailable:'证据不可读取，需核实路径或权限', 'metadata-unchanged':'元数据未变，未比对内容'};
 let csrf='';
 async function api(method,args={}){
  const response=await fetch('/workspace-ledger/api/'+method,{method:'POST',headers:{'content-type':'application/json','x-workspace-ledger-token':csrf},body:JSON.stringify(args)});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'请求失败');if(result.csrf)csrf=result.csrf;return result.value;
 }
 const css=`
 .wl-button{font:inherit;border:1px solid var(--dsw-alias-border-l1,#7775);border-radius:7px;padding:7px 12px;background:var(--dsw-alias-bg-layer-1,#222);color:inherit;cursor:pointer}.wl-button:disabled{opacity:.45;cursor:default}.wl-open{font-size:12px;padding:5px 10px}.wl-overlay{position:fixed;inset:18px;z-index:10000;background:var(--dsw-alias-bg-layer-1,#202124);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#7775);border-radius:14px;box-shadow:0 12px 80px #0008;display:flex;flex-direction:column;text-align:left;font-size:13px;line-height:1.6}.wl-header{padding:14px 18px;border-bottom:1px solid #8884;display:flex;align-items:center;justify-content:space-between;gap:12px}.wl-header h2{font-size:18px;margin:0}.wl-layout{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr) minmax(300px,1.7fr);flex:1;min-height:0}.wl-column{overflow:auto;padding:14px;border-right:1px solid #8883}.wl-row{display:block;width:100%;text-align:left;border:1px solid #8884;border-radius:9px;background:transparent;color:inherit;padding:10px;margin-bottom:9px;cursor:pointer}.wl-row[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#759cff);background:#759cff12}.wl-muted{opacity:.65;font-size:12px}.wl-detail h3{font-size:16px;margin:0 0 10px}.wl-detail h4{margin:16px 0 5px}.wl-detail p{white-space:pre-wrap;overflow-wrap:anywhere}.wl-detail ul{padding-left:20px;margin:4px 0}.wl-note{padding:8px 12px;border-radius:7px;background:#8882;margin-bottom:12px;white-space:pre-wrap;overflow-wrap:anywhere}.wl-error{color:#ff9999;background:#ff444415}.wl-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.wl-path{font-family:monospace;font-size:12px;overflow-wrap:anywhere}.wl-select{max-width:55vw;padding:5px;border:1px solid #8885;background:var(--dsw-alias-bg-layer-1,#222);color:inherit;border-radius:5px}@media(max-width:950px){.wl-overlay{inset:6px}.wl-layout{grid-template-columns:190px 1fr}.wl-detail{grid-column:1/-1;max-height:48vh;border-top:1px solid #8884}.wl-header{flex-wrap:wrap}}`;
 function SettingsPanel({onSaved}){
  const [draft,setDraft]=React.useState(null);
  const [models,setModels]=React.useState(null);
  const [loadError,setLoadError]=React.useState('');
  const [modelError,setModelError]=React.useState('');
  const [saving,setSaving]=React.useState(false);
  const [saveStatus,setSaveStatus]=React.useState(null);
  React.useEffect(()=>{
   let closed=false;
   api('settings.get').then(result=>{if(!closed)setDraft(result);}).catch(error=>{if(!closed)setLoadError(error.message);});
   return()=>{closed=true;};
  },[]);
  const provider=draft?.provider;
  React.useEffect(()=>{
   if(!provider||!draft.providers.some(item=>item.id===provider))return;
   let closed=false;
   api('settings.models',{provider}).then(result=>{if(!closed)setModels(result);}).catch(error=>{if(!closed)setModelError(error.message);});
   return()=>{closed=true;};
  },[provider]);

  const change=(field,next)=>{setDraft(current=>({...current,[field]:next}));setSaveStatus(null);};
  const option=({id,name})=>h('option',{key:id,value:id},name===id?id:`${name} (${id})`);
  const maxTokens=Number(draft?.maxTokens);
  const validTokens=Number.isInteger(maxTokens)&&maxTokens>=512&&maxTokens<=8192;
  const canSave=validTokens&&models?.some(item=>item.id===draft.model);
  const save=async event=>{
   event.preventDefault();
   if(saving||!canSave)return;
   setSaving(true);
   setSaveStatus(null);
   try{
    const result=await api('settings.save',{provider,model:draft.model,maxTokens,revision:draft.revision});
    setDraft(current=>({...current,...result}));
    onSaved(result);
    setSaveStatus({message:'已保存，下次整理调用时生效。'});
   }catch(error){setSaveStatus({error:true,message:error.message});}
   finally{setSaving(false);}
  };
  const alert=message=>h('div',{className:'wl-note wl-error',role:'alert'},message);
  return h('div',{className:'wl-column'},h('h3',null,'账本模型设置'),
   h('p',{className:'wl-muted'},'用于历史整理、模型验收和经验草稿。支持关闭思考的模型会关闭思考，其余使用提供商默认设置。'),
   loadError?alert(loadError):!draft?h('p',null,'正在读取设置…'):h('form',{className:'wl-settings',onSubmit:save},
    h('label',null,'提供商',h('select',{className:'wl-select',value:provider,disabled:saving,onChange:event=>{
     setModels(null);setModelError('');setSaveStatus(null);
     const next=event.target.value;
     setDraft(current=>({...current,provider:next,model:''}));
    }},!draft.providers.some(item=>item.id===provider)&&h('option',{value:provider},provider+'（当前不可用）'),...draft.providers.map(option))),
    h('label',null,'模型',h('select',{className:'wl-select',value:draft.model,disabled:saving||!models?.length,onChange:event=>change('model',event.target.value)},
     !models?.some(item=>item.id===draft.model)&&h('option',{value:draft.model},draft.model||'选择模型'),...(models??[]).map(option))),
    modelError?alert(modelError):!draft.providers.some(item=>item.id===provider)?h('p',{className:'wl-muted'},'请选择 DSH 中已配置的提供商。'):
     models===null?h('p',{className:'wl-muted'},'正在读取模型目录…'):!models.length?h('p',{className:'wl-muted'},'该提供商没有可选模型。'):null,
    h('label',null,'输出上限（tokens）',h('input',{className:'wl-select',type:'number',min:512,max:8192,step:1,required:true,disabled:saving,value:draft.maxTokens,onChange:event=>change('maxTokens',event.target.value)})),
    h('div',{className:'wl-actions'},h('button',{className:'wl-button',type:'submit',disabled:saving||!canSave},saving?'正在保存…':'保存设置')),
    saveStatus&&(saveStatus.error?alert(saveStatus.message):h('div',{className:'wl-note',role:'status'},saveStatus.message))));
 }

 const reviewLabels={passed:'通过',failed:'未通过',manual:'待人工核验'};
 const checkLabels={judgment:'模型核对正文',exists:'文件存在',pdf:'PDF 可解析',contains:'包含指定文字',lines:'非空行数',command:'已配置命令'};
 const cardFields={title:'标题',scope:'适用场景',problem:'问题',method:'做法',verification:'验证方式'};
 const cardLimits={title:150,scope:700,problem:1000,method:1600,verification:1200};
 const receiptLabels={submitted:'已提交，等待回读',readable:'已回读',indexed:'已索引并回读',searchable:'可检索'};

 function TaskAssistant({detail,workspace,children}){
  const [tab,setTab]=React.useState('progress');
  const [data,setData]=React.useState(null);
  const [criteria,setCriteria]=React.useState([]);
  const [cards,setCards]=React.useState([]);
  const [selected,setSelected]=React.useState([]);
  const [dirty,setDirty]=React.useState(false);
  const [busy,setBusy]=React.useState('');
  const [error,setError]=React.useState('');
  const [notice,setNotice]=React.useState('');
  const [focus,setFocus]=React.useState('');
  const [smart,setSmart]=React.useState(null);
  const syncedSmart=React.useRef(null);
  const task=detail.task;
  const target={workspace,taskId:task.id};
  const newCriterion=label=>({label,kind:'judgment',file:'',expected:''});
  const initialize=result=>{
   setData(result);
   setCriteria(result.criteria??(task.acceptance??[]).map(newCriterion));
   setCards(result.draft?.cards??[]);setSelected([]);setDirty(false);
  };
  React.useEffect(()=>{
   if(tab==='progress')return;
   let cancelled=false;
   api('assist.get',target).then(result=>{if(!cancelled)initialize(result);}).catch(e=>{if(!cancelled)setError(e.message);});
   return()=>{cancelled=true;};
  },[tab,workspace,task.id,task.version]);

  React.useEffect(()=>{
   if(tab!=='smart')return;
   let closed=false,timer;
   const poll=async()=>{
    try{
     const job=await api('assist.smartStatus',target);
     if(closed)return;
     setSmart(job);
     if(job?.state==='running')timer=setTimeout(poll,1200);
     else if(job?.reportId&&syncedSmart.current!==job.id){
      const result=await api('assist.get',target);
      if(!closed){syncedSmart.current=job.id;initialize(result);}
     }
    }catch{if(!closed)timer=setTimeout(poll,3500);}
   };
   poll();
   return()=>{closed=true;clearTimeout(timer);};
  },[tab,workspace,task.id,smart?.id]);

  const startSmart=async()=>{
   setBusy('正在提交验收…');setError('');setNotice('');
   try{setSmart(await api('assist.smartStart',{...target,focus,expectedVersion:task.version}));}
   catch(error){setError(error.message);}
   finally{setBusy('');}
  };

  const act=async(action,label,args={})=>{
   setBusy(label);setError('');setNotice('');
   try{
    const result=await api('assist.'+action,{...target,...args});
    if(action==='suggest'){
     setCriteria(current=>[...current,...result.filter(label=>!current.some(row=>row.label===label)).map(newCriterion)].slice(0,16));
     setNotice('建议已加入，请核对后再开始验收。');
     return;
    }
    initialize(await api('assist.get',target));
    setNotice(action==='publish'?`${result.length} 张卡片已提交，见下方回执。`:action==='review'?'验收报告已保存。':action==='saveDraft'?'已保存修改，可以预览并勾选入库。':result.cards.length?'草稿已生成，请核对依据。':'本次未提取到可复用经验。');
   }catch(e){
    setError(e.message);
    if(action==='publish')try{const latest=await api('assist.get',target);setData(latest);}catch{}
   }finally{setBusy('');}
  };
  const button=(label,onClick,disabled=false,extra={})=>h('button',{type:'button',className:'wl-button',onClick,disabled:!!busy||disabled,...extra},label);
  const changeCriterion=(index,key,value)=>setCriteria(current=>current.map((row,i)=>i===index?{...row,[key]:value}:row));
  const choice=(value,label)=>h('option',{key:value,value},label);
  const select=(value,onChange,options,label)=>h('select',{className:'wl-select',value,onChange:e=>onChange(e.target.value),disabled:!!busy,'aria-label':label},...options);
  const updateCard=(id,key,value)=>{
   setCards(current=>current.map(card=>card.id===id?{...card,[key]:value}:card));
   setDirty(true);setSelected([]);
  };
  const controls=h('nav',{className:'wl-actions','aria-label':'任务详情'},...[
   ['progress','进度与恢复'],['smart','智能验收与复盘'],['review','交付物验收'],['experience','经验整理与入库'],
  ].map(([id,label])=>button(label,()=>{if(tab!==id){setError('');setNotice('');setData(null);setTab(id);}},false,{key:id,'aria-pressed':tab===id})));

  const reportPanel=()=>data.report&&h('section',{className:'wl-assist-card'},
   h('strong',null,'验收结果 · '+reviewLabels[data.report.state]),
   data.report.stale&&h('p',{className:'wl-note'},'任务版本或文件已变化，请重新验收。'),
   h('p',{className:'wl-muted'},new Date(data.report.at).toLocaleString()+` · 任务版本 ${data.report.taskVersion}`),
   ...data.report.rows.map((row,index)=>h('div',{key:index,className:'wl-note'},h('strong',null,`${reviewLabels[row.state]} · ${row.label}`),
    h('div',{className:'wl-muted'},row.method==='model'?'模型判断':checkLabels[row.kind]),h('div',null,row.evidence),row.quote&&h('blockquote',null,row.quote),(row.source||row.file)&&h('div',{className:'wl-path'},row.source||row.file))));

  const reviewPanel=()=>h(React.Fragment,null,
   h('p',{className:'wl-muted'},'先核对标准与文件。模型核对只读取文本摘录。'),
   ...criteria.map((row,index)=>h('fieldset',{key:index,className:'wl-assist-card',disabled:!!busy},
    h('legend',null,`标准 ${index+1}`),
    h('input',{value:row.label,placeholder:'例如：文件应有 1 个非空行','aria-label':`标准 ${index+1}`,onChange:e=>changeCriterion(index,'label',e.target.value)}),
    select(row.kind,value=>changeCriterion(index,'kind',value),Object.entries(checkLabels).filter(([id])=>id!=='command'||data.commands?.length).map(([id,label])=>choice(id,label)),`检查方式 ${index+1}`),
    row.kind==='command'?select(row.command??'',value=>changeCriterion(index,'command',value),[choice('','选择命令'),...(data.commands??[]).map(item=>choice(item.id,item.label))],`验收命令 ${index+1}`):
     select(row.file,value=>changeCriterion(index,'file',value),[choice('',row.kind==='judgment'?'全部已登记文本交付物':'选择交付物'),...detail.files.map(file=>choice(file.path,file.path))],`交付物 ${index+1}`),
    ['lines','contains'].includes(row.kind)&&h('input',{value:row.expected,placeholder:row.kind==='lines'?'预期非空行数':'待核对的文字','aria-label':`预期值 ${index+1}`,onChange:e=>changeCriterion(index,'expected',e.target.value)}),
    button('移除标准',()=>setCriteria(rows=>rows.filter((_,i)=>i!==index))))),
   h('div',{className:'wl-actions'},button('添加标准',()=>setCriteria(rows=>[...rows,newCriterion('')]),criteria.length>=16),
    button('建议标准',()=>act('suggest','正在起草验收标准…'),criteria.length>=16),
    button('开始验收',()=>act('review','正在逐项验收…',{criteria,expectedVersion:task.version}),!criteria.length||detail.busySessions.length>0)),
   reportPanel());

  const experiencePanel=(integrated=false)=>h(React.Fragment,null,
   h('p',{className:'wl-muted'},'草稿依据任务证据生成。保存修改后，勾选要写入 OpenViking 的卡片。'),
   !integrated&&button(data.draft?'重新提炼草稿':'提炼经验',()=>act('draft','正在提炼经验草稿…'),dirty),
   data.draft?.taskVersion!==undefined&&data.draft.taskVersion!==task.version&&h('p',{className:'wl-note'},`此草稿源于任务版本 ${data.draft.taskVersion}。`),
   ...cards.map(card=>h('fieldset',{className:'wl-assist-card',key:card.id,disabled:!!busy},
    h('legend',null,card.title||'经验草稿'),
    ...Object.entries(cardFields).map(([key,label])=>h('label',{key},label,h(key==='title'?'input':'textarea',{value:card[key],rows:2,maxLength:cardLimits[key],onChange:e=>updateCard(card.id,key,e.target.value)}))),
    h('details',null,h('summary',null,'查看依据'),...card.sources.map(id=>{
     const item=data.draft.evidence.find(source=>source.id===id);
     return h('div',{className:'wl-note',key:id},h('strong',null,item?.label??id),h('div',null,item?.content));
    })),
    !dirty&&h('details',null,h('summary',null,'预览入库正文'),h('pre',null,card.markdown)),
    h('label',{className:'wl-assist-check'},h('input',{type:'checkbox',checked:selected.includes(card.id),disabled:dirty||!card.sources.length,onChange:e=>{
     const checked=e.target.checked;setSelected(ids=>checked?[...ids,card.id]:ids.filter(id=>id!==card.id));
    }}),card.sources.length?'选择此卡入库':'缺少可核对来源'))),
   !!cards.length&&h('div',{className:'wl-actions'},button('保存草稿',()=>act('saveDraft','正在保存草稿…',{revision:data.draft.revision,cards:cards.map(({id,title,scope,problem,method,verification})=>({id,title,scope,problem,method,verification}))}),!dirty),
    button('确认入库',()=>act('publish','正在写入并核验 OpenViking…',{revision:data.draft.revision,ids:selected}),dirty||!selected.length)),
   ...Object.values(data.publications??{}).reverse().map(receipt=>h('div',{className:'wl-note',key:receipt.hash},
    h('strong',null,`${receiptLabels[receipt.state]} · ${receipt.title}`),h('div',{className:'wl-path'},receipt.uri))));

  const smartPanel=()=>{
   const running=smart?.state==='running';
   const stage={planning:'正在理解任务并制定检查计划',checking:'正在核对交付证据',synthesizing:'验收已保存，正在提炼整改建议和经验',finished:'智能验收与复盘已结束'}[smart?.stage];
   const sameReport=data.report?.mode==='integrated'&&(!running||smart.reportId===data.report.id);
   const synthesis=sameReport&&data.draft?.reportId===data.report.id?data.draft:null;
   return h(React.Fragment,null,
    h('p',{className:'wl-muted'},'模型会读取任务要求、相关对话和已登记交付物。核验结果用于生成整改建议与经验草稿。'),
    h('label',{className:'wl-assist-card'},'特别想核对什么（可选）',h('textarea',{value:focus,rows:2,maxLength:300,disabled:running||!!busy,onChange:event=>setFocus(event.target.value),placeholder:'例如重点核对报告的数字能否由交付文件复现'})),
    button('开始智能验收与复盘',startSmart,running||dirty||detail.busySessions.length>0),
    smart&&h('div',{className:'wl-progress',role:'status'},smart.state==='failed'?'智能验收未完成':smart.state==='partial'?'验收报告已保存，复盘未完成':stage,h('progress',{'aria-label':'智能验收进度',max:smart.total,value:smart.completed})),
    smart?.error&&h('div',{className:'wl-note wl-error',role:'alert'},smart.error),
    sameReport&&reportPanel(),
    synthesis&&(synthesis.summary||synthesis.actions?.length)&&h('section',{className:'wl-assist-card'},
     h('strong',null,'模型复盘'),synthesis.summary&&h('p',null,synthesis.summary),
     ...(synthesis.actions??[]).map((item,index)=>h('div',{className:'wl-note',key:index},h('strong',null,item.action),h('div',{className:'wl-muted'},item.sources.map(id=>synthesis.evidence.find(row=>row.id===id)?.label??id).join(' · '))))),
    synthesis&&h('section',null,h('h4',null,'经验草稿'),experiencePanel(true)));
  };

  return h(React.Fragment,null,controls,tab==='progress'?children:h(React.Fragment,null,
   busy&&h('div',{className:'wl-progress',role:'status'},busy,h('progress',{'aria-label':busy})),
   error&&h('div',{className:'wl-note wl-error',role:'alert'},error),
   notice&&h('div',{className:'wl-note',role:'status'},notice),
   data?(tab==='smart'?smartPanel():tab==='review'?reviewPanel():experiencePanel()):!error&&h('p',null,'正在读取任务资料…')));
 }

 function apply(ctx){
  const style=document.createElement('style');style.textContent=css+`
   .wl-settings{max-width:520px;display:grid;gap:12px}
   .wl-settings label{display:grid;gap:5px;font-weight:600}
   .wl-settings .wl-select{max-width:100%;min-width:0;width:100%;box-sizing:border-box;font:inherit}
   .wl-settings p,.wl-settings .wl-note{margin:0}
   .wl-header-actions{display:flex;gap:8px;align-items:center}
   .wl-progress{margin:8px 0 12px}
   .wl-progress progress{display:block;width:100%;height:8px;margin-top:6px;accent-color:var(--dsw-alias-brand-primary,#638bfa)}
   .wl-assist-card{display:grid;min-width:0;gap:8px;padding:10px;margin:8px 0;border:1px solid var(--dsw-alias-border-l3,#8884);border-radius:8px}
   .wl-assist-card input:not([type=checkbox]),.wl-assist-card textarea,.wl-assist-card select{box-sizing:border-box;width:100%;max-width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#222);border:1px solid #8885;border-radius:5px;padding:6px}
   .wl-assist-card label:not(.wl-assist-check){display:grid;gap:4px}
   .wl-assist-card pre{white-space:pre-wrap;overflow-wrap:anywhere}
   .wl-assist-check{display:flex;align-items:center;gap:8px}
   .wl-actions button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#638bfa);background:#759cff20}
   .wl-inline{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;overflow:hidden;container-type:inline-size;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
   .wl-inline .wl-header{flex:none;flex-wrap:wrap}
   .wl-inline .wl-layout{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)}
   .wl-inline .wl-column{min-width:0;overflow-wrap:anywhere}
   .wl-inline .wl-detail{grid-column:auto;max-height:none;border-top:0;border-right:0}
   @container (max-width:620px){
    .wl-inline .wl-layout{grid-template-columns:minmax(0,1fr);overflow:auto}
    .wl-inline .wl-column{overflow:visible;border-right:0}
    .wl-inline .wl-detail{border-top:1px solid var(--dsw-alias-border-l3,#8884)}
   }
  `;document.head.appendChild(style);ctx.effect(()=>()=>style.remove());const slots=ctx.get('slots');
  const navigate=(id)=>{const workspace=ctx.get('uiWorkspace');if(!workspace?.openSession)throw Error('会话导航尚未就绪，请刷新DSH页面');workspace.openSession(id);};
  function Panel({sessionId,onClose,openView,inline=false}){
   const [data,setData]=React.useState(null),[workspace,setWorkspace]=React.useState(''),[offset,setOffset]=React.useState(0),[chosenSession,setChosenSession]=React.useState(sessionId||''),[chosenTask,setChosenTask]=React.useState(''),[detail,setDetail]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[refresh,setRefresh]=React.useState(0);
   const requestIds=React.useRef(new Map());
   const [showSettings,setShowSettings]=React.useState(false);
   const [starting,setStarting]=React.useState(false);
   const [organization,setOrganization]=React.useState(null);
   React.useEffect(()=>{
    let stopped=false;
    const scope=inline?{sessionId,currentOnly:true}:{sessionId:workspace?undefined:sessionId,workspace:workspace||undefined,offset};
    const load=async()=>{
     try{
      const result=await api('overview',scope);
      if(stopped)return;
      setData(result);
      setChosenSession(current=>result.sessions.some(s=>s.id===current)?current:result.sessions[0]?.id||'');
     }catch(e){if(!stopped)setError(e.message);}
    };
    load();const timer=setInterval(load,10000);
    return()=>{stopped=true;clearInterval(timer);};
   },[workspace,offset,sessionId,refresh,inline]);
   const session=data?.sessions.find(s=>s.id===chosenSession);const task=session?.tasks.find(t=>t.id===chosenTask);const version=task?.version;
   const job=organization?.sessionId===chosenSession?organization:null;
   const organizing=starting||job?.state==='running';
   React.useEffect(()=>{
    if(!chosenSession||starting)return;
    let closed=false,timer;
    const poll=async()=>{
     try{
      const status=await api('organize.status',{sessionId:chosenSession});
      if(closed)return;
      setOrganization(status);
      if(status?.state==='running')timer=setTimeout(poll,1200);
      if(status?.state==='done')setRefresh(value=>value+1);
     }catch(error){
      if(!closed)timer=setTimeout(poll,3500);
     }
    };
    poll();
    return()=>{closed=true;clearTimeout(timer);};
   },[chosenSession,starting]);
   React.useEffect(()=>{setDetail(null);if(!data?.workspace||!chosenTask)return;let stopped=false;api('recovery',{workspace:data.workspace,taskId:chosenTask}).then(v=>{if(!stopped)setDetail(v);}).catch(e=>{if(!stopped)setError(e.message);});return()=>{stopped=true;};},[chosenTask,data?.workspace,version,refresh]);
   React.useEffect(()=>{
    if(inline)return;
    const key=e=>{if(e.key!=='Escape')return;if(showSettings)setShowSettings(false);else onClose();};
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
   },[onClose,showSettings,inline]);
   const openSession=id=>{
    try{
     if(inline&&id===sessionId)openView?.('chat','');
     else navigate(id);
     onClose?.();
    }catch(e){setError(e.message);}
   };
   const organize=async()=>{
    setStarting(true);setError('');setNotice('');
    try{setOrganization(await api('organize.start',{sessionId:chosenSession}));}
    catch(error){setError(error.message);}
    finally{setStarting(false);}
   };
   const progress=job?.total?`${job.completed}/${job.total} 段`:'';
   let progressText='正在读取对话记录…';
   if(job?.state==='failed')progressText=progress?`整理中断，已处理 ${progress}`:'整理未能开始';
   else if(job?.state==='done')progressText=job.cached?`这份记录已整理 · ${progress}`:`整理完成 · ${progress}`;
   else if(job?.phase==='saving')progressText=`已处理 ${progress}，正在保存账本…`;
   else if(progress)progressText=`已处理 ${progress}，正在整理第 ${job.completed+1} 段…`;
   const resume=async mode=>{
    if(!detail)return;setBusy(true);setError('');const key=detail.task.id+'#'+detail.task.version+'#'+mode;if(!requestIds.current.has(key))requestIds.current.set(key,crypto.randomUUID());
    try{const result=await api('resume',{workspace:data.workspace,taskId:detail.task.id,expectedVersion:detail.task.version,mode,requestId:requestIds.current.get(key)});setNotice('恢复消息已派发到对话：'+result.sessionId);setRefresh(v=>v+1);if(result.state==='dispatched')openSession(result.sessionId);}catch(e){setError(e.message);}finally{setBusy(false);}
   };
   const section=(label,items)=>h(React.Fragment,null,h('h4',null,label),items?.length?h('ul',null,...items.map((s,i)=>h('li',{key:i},s))):h('div',{className:'wl-muted'},'尚无记录'));
   const panelProps=inline?{className:'wl-inline',role:'region'}:{className:'wl-overlay',role:'dialog','aria-modal':true};
   return h('div',{...panelProps,'aria-label':'对话任务账本'},
    h('div',{className:'wl-header'},h('div',null,h('h2',null,'对话任务账本'),h('div',{className:'wl-muted'},'打开详情只查看；点击继续才执行。进度记录与验收结果分别判断。')),
     !inline&&!showSettings&&h('select',{'aria-label':'筛选工作区',className:'wl-select',value:workspace||data?.workspace||'',onChange:e=>{setWorkspace(e.target.value);setOffset(0);setChosenSession('');setChosenTask('');}},...(data?.workspaces??[]).map(w=>h('option',{value:w,key:w},w))),
     h('div',{className:'wl-header-actions'},h('button',{type:'button',className:'wl-button',onClick:()=>setShowSettings(open=>!open)},showSettings?'返回账本':'设置'),!inline&&h('button',{className:'wl-button',onClick:onClose,'aria-label':'关闭任务账本'},'关闭 ×'))),
    !showSettings&&error&&h('div',{className:'wl-note wl-error',role:'alert'},error),!showSettings&&notice&&h('div',{className:'wl-note',role:'status'},notice),
    showSettings?h(SettingsPanel,{onSaved:({provider,model,maxTokens})=>{
     setData(current=>current&&({...current,historyModel:{provider,model,maxTokens}}));
     setRefresh(v=>v+1);
    }}):!data?h('div',{className:'wl-column'},inline?'正在读取当前对话的任务…':'正在读取对话列表…'):h('div',{className:'wl-layout'},
     !inline&&h('div',{className:'wl-column'},h('h3',null,'对话 · '+data.totalSessions),...(data.sessions??[]).map(s=>h('button',{key:s.id,className:'wl-row','aria-pressed':s.id===chosenSession,onClick:()=>{setChosenSession(s.id);setChosenTask('');setError('');}},h('strong',null,s.title),h('div',{className:'wl-muted'},(s.busy?'执行中 · ':'')+s.tasks.length+' 项已记录任务'),h('div',{className:'wl-muted'},s.organized?(s.organized.partial?'历史已部分整理':'历史已整理'):'历史尚未整理'))),
      h('div',{className:'wl-actions'},h('button',{className:'wl-button',disabled:!offset,onClick:()=>setOffset(Math.max(0,offset-30))},'上一页'),h('button',{className:'wl-button',disabled:data.nextOffset===null,onClick:()=>setOffset(data.nextOffset)},'下一页')),
      data.unavailableWorkspaces>0&&h('p',{className:'wl-muted'},data.unavailableWorkspaces+' 个对话的工作区路径已不存在，未加载其任务。')),
     h('div',{className:'wl-column'},session?h(React.Fragment,null,h('h3',null,session.title),h('div',{className:'wl-actions'},h('button',{className:'wl-button',onClick:()=>openSession(session.id)},inline?'返回对话':'打开对话'),h('button',{className:'wl-button',disabled:busy||session.busy||organizing,onClick:organize},organizing?'正在整理…':job?.state==='failed'?'重试整理':'整理本对话任务')),
      (job||starting)&&h('div',{className:'wl-progress'},
       h('div',{role:'status'},progressText),
       (job?.total||organizing)?h('progress',{'aria-label':'整理进度',max:job?.total||1,value:job?.total?job.completed:undefined}):null,
       job?.error&&h('div',{className:'wl-note wl-error',role:'alert'},job.error)),
      inline&&session.tasks.length>0&&h('p',{className:'wl-muted'},session.tasks.length+' 项已记录任务'),
      h('p',{className:'wl-muted'},'历史整理按点击调用 '+data.historyModel.provider+' / '+data.historyModel.model+'；不在后台扫描全部会话。'),
      !session.tasks.length&&h('div',{className:'wl-note'},session.organized?.partial?'旧版只整理了最近的记录，可以重新整理完整对话。':session.organized?'已检查记录，未提取到执行任务。':'该对话历史尚未整理。'),
      ...session.tasks.map(t=>h('button',{className:'wl-row',key:t.id,'aria-pressed':chosenTask===t.id,onClick:()=>{setChosenTask(t.id);setError('');}},h('strong',null,t.subject),h('div',null,statusNames[t.status]||t.status,t.interrupted?' · 曾中断':''),h('div',{className:'wl-muted'},'已记录完成 '+t.completedCount+' 项 / 剩余 '+t.remainingCount+' 项'),h('div',{className:'wl-muted'},t.progressSource==='history'?'来源：历史提取，待核实':'来源：Agent 检查点')))) :h('p',null,'选择一个对话')),
     h('div',{className:'wl-column wl-detail'},!chosenTask?h('p',{className:'wl-muted'},'选择任务，查看目标、检查点、文件变化与恢复详情。'):!detail?h('p',null,'正在核对恢复信息…'):h(React.Fragment,null,
      h('h3',null,detail.task.subject),h(TaskAssistant,{key:detail.task.id,detail,workspace:data.workspace},
      h('div',{className:'wl-note'},detail.note),h('h4',null,'任务目标'),h('p',null,detail.task.objective),section('约束',detail.task.constraints),section('验收标准',detail.task.acceptance),section('已完成事项（历史记录）',detail.task.completed),section('剩余事项',detail.task.remaining),section('阻塞原因',detail.task.blockers),h('h4',null,'下一步'),h('p',null,detail.task.nextAction||'尚未记录'),
      h('h4',null,'文件核对'),detail.files.length?detail.files.map(f=>h('div',{className:'wl-note',key:f.path},h('div',{className:'wl-path'},f.path),fileNames[f.state]||f.state)):h('div',{className:'wl-muted'},'尚未记录文件证据；恢复后先核实现状。'),
      h('h4',null,'最后检查点'),h('p',null,detail.task.lastCheckpoint?new Date(detail.task.lastCheckpoint.at).toLocaleString()+' · '+detail.task.lastCheckpoint.note:'历史提取或尚无结构化检查点'),
      h('h4',null,'关联对话'),...detail.task.sessionIds.map(id=>h('button',{className:'wl-button wl-path',key:id,onClick:()=>openSession(id)},id)),
      h('h4',null,'近期工具与回合记录'),...(detail.task.receipts??[]).slice(-8).reverse().map((r,i)=>h('div',{className:'wl-muted',key:i},'#'+r.seq+' '+(r.tool||r.kind)+(r.isError?' · 失败':''))),
      detail.busySessions.length>0&&h('div',{className:'wl-note'},'关联对话正在运行，暂不重复派发。'),
      detail.requiresRecheck&&h('div',{className:'wl-note'},'文件状态发生变化，继续时将要求先核实。'),
      h('div',{className:'wl-actions'},h('button',{className:'wl-button',disabled:busy||!!detail.busySessions.length||detail.task.status==='done',onClick:()=>resume('original')},'继续原对话'),h('button',{className:'wl-button',disabled:busy||!!detail.busySessions.length||detail.task.status==='done',onClick:()=>resume('new')},'新对话接手'),h('button',{className:'wl-button',disabled:busy,onClick:()=>setRefresh(v=>v+1)},'刷新核对')),
      detail.task.status==='done'&&h('p',{className:'wl-muted'},'该任务记录为已结束。新的修改需求可在原对话中建立后续任务。'))))
    ));
  }
  function Entry(props){const [open,setOpen]=React.useState(false);return h(React.Fragment,null,h('button',{type:'button',className:'wl-button wl-open',onClick:()=>setOpen(true)},'对话任务账本'),open&&createPortal(h(Panel,{sessionId:props?.sessionId,onClose:()=>setOpen(false)}),document.body));}
  slots.inject('sidebar.footer.action',()=>slots.register({name:'sidebar.footer.action',id:'workspace-ledger-sidebar.footer.action',order:75,label:'对话任务账本'},props=>h(Entry,props)));
  slots.inject('conversation.view',()=>slots.register({
   name:'conversation.view',id:'workspace-ledger',order:15,label:'任务账本',
   inject:sessionId=>({ledgerSessionId:sessionId}),
  },({ledgerSessionId,openView})=>h(Panel,{key:ledgerSessionId,sessionId:ledgerSessionId,openView,inline:true})));
 }
 return{name:'workspace-ledger',inject:['slots','uiWorkspace'],apply};
}});
