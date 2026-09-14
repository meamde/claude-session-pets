const {app,BrowserWindow}=require('electron');const path=require('path'),fs=require('fs'),os=require('os');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'pets-ui-')));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:780,show:false,webPreferences:{preload:path.join(__dirname,'ui-preload.cjs'),contextIsolation:true,nodeIntegration:false}});const errors=[];
 win.webContents.on('console-message',(_e,level,message)=>{if(level===3)errors.push(message)});
 try{await win.loadFile(path.join(__dirname,'../pet.html'));await new Promise(r=>setTimeout(r,700));
 const initial=await win.webContents.executeJavaScript(`({count:sessionPets.size,keys:[...sessionPets.keys()],providers:[...sessionPets.values()].map(s=>s.provider),allWork:[...sessionPets.values()].every(s=>s.working)})`);
 if(initial.count!==3||!initial.allWork)throw Error('Independent sessions failed '+JSON.stringify(initial));
 await win.webContents.executeJavaScript(`showPanel(); providerSelect.value='codex';providerSelect.dispatchEvent(new Event('change'));document.querySelector('[data-tab="procs"]').click();`);
 await new Promise(r=>setTimeout(r,200));
 const capture=process.env.PETS_SCREENSHOT||path.join(os.tmpdir(),'session-pets-smoke.png');fs.writeFileSync(capture,(await win.webContents.capturePage()).toPNG());
 const transition=await win.webContents.executeJavaScript(`(()=>{const p=procs[1],sp=sessionPets.get(p.id);p.state='waiting';detectEvents();const wait=sp.sticky==='wait';p.state='working';detectEvents();const work=sp.working&&!sp.sticky;p.state='idle';detectEvents();tracked.get(p.id).idleSince=performance.now()-4000;detectEvents();const done=sp.sticky==='done';sp.enter('drag');sp.setWorking('drag task');const drag=sp.state==='drag'&&sp.working;sp.landRestore();return {wait,work,done,drag,land:sp.state==='work'}})()`);
 if(Object.values(transition).some(v=>!v))throw Error('State transitions failed '+JSON.stringify(transition));
 const closeChecks=await win.webContents.executeJavaScript(`(async()=>{
   const p=procs[1],other=procs[2],sp=sessionPets.get(p.id);
   const badges=[...sessionPets.values()].filter(s=>getComputedStyle(s.el.querySelector('.desktop-badge')).display!=='none').length===2;
   sp.el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:30,clientY:30}));
   document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:55,clientY:30}));
   await new Promise(r=>setTimeout(r,650));const dragCancels=!document.body.classList.contains('pet-editing');
   document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));sp.y=sp.groundY();sp.landRestore();
   sp.el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:30,clientY:30}));
   await new Promise(r=>setTimeout(r,650));
   const hold=document.body.classList.contains('pet-editing')&&dragPet===null;
   document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
   sp.el.querySelector('.desktop-close').click();detectEvents();detectEvents();
   const hidden=!sessionPets.has(p.id)&&sessionPets.has(other.id)&&localStorage.getItem('hiddenDesktopPet:'+p.id)==='1';
   setDesktopPetHidden(p,false);
   const restored=sessionPets.has(p.id)&&!hiddenDesktopPet(p);
   document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
   return {badges,dragCancels,hold,hidden,restored,escape:!document.body.classList.contains('pet-editing')};
 })()`);
 if(Object.values(closeChecks).some(v=>!v))throw Error('Desktop close failed '+JSON.stringify(closeChecks));
 const wakeChecks=await win.webContents.executeJavaScript(`(()=>{
   const p=procs[1];p.state='working';p.turnId='turn-a';setDesktopPetHidden(p,true);detectEvents();
   const sameTurnStaysHidden=!sessionPets.has(p.id);
   p.state='idle';detectEvents();p.state='working';detectEvents();
   const newWorkShows=sessionPets.has(p.id)&&sessionPets.get(p.id).working;
   setDesktopPetHidden(p,true);p.turnId='turn-b';detectEvents();
   const activeNewTurnShows=sessionPets.has(p.id);
   setDesktopPetHidden(p,true);p.disconnected=true;p.turnId='turn-c';detectEvents();
   const disconnectStaysHidden=!sessionPets.has(p.id);p.disconnected=false;detectEvents();
   const reconnectNewTurnShows=sessionPets.has(p.id);
   setDesktopPetHidden(p,true);p.state='idle';p.turnId='turn-d';detectEvents();
   const shortTurnShows=sessionPets.has(p.id);
   return {sameTurnStaysHidden,newWorkShows,activeNewTurnShows,disconnectStaysHidden,reconnectNewTurnShows,shortTurnShows};
 })()`);
 if(Object.values(wakeChecks).some(v=>!v))throw Error('Hidden wake failed '+JSON.stringify(wakeChecks));
 const priority=await win.webContents.executeJavaScript(`(()=>{
   const pets=[...sessionPets.values()],a=pets[0],b=pets[1];
   a.setWorking('work');b.setWorking('work');a.setDone();
   const higher=Number(getComputedStyle(a.el).zIndex)>Number(getComputedStyle(b.el).zIndex)&&Number(getComputedStyle(a.el).zIndex)>Number(getComputedStyle(document.getElementById('pet')).zIndex);
   a.enter('drag');a.landRestore();const retained=a.el.classList.contains('alerting');
   b.setWaiting();const newest=Boolean(a.el.compareDocumentPosition(b.el)&Node.DOCUMENT_POSITION_FOLLOWING);
   a.goIdle();const cleared=!a.el.classList.contains('alerting')&&Number(getComputedStyle(a.el).zIndex)<Number(getComputedStyle(b.el).zIndex);
   return {higher,retained,newest,cleared};
 })()`);
 if(Object.values(priority).some(v=>!v))throw Error('Alert stacking failed '+JSON.stringify(priority));
 const providerCycle=await win.webContents.executeJavaScript(`(async()=>{
   providerSelect.value='claude';providerSelect.dispatchEvent(new Event('change'));await refreshUsage(false);
   petEl.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await refreshUsage(false);
   const codex=selectedProvider==='codex'&&document.querySelector('#usage-provider-icon').alt==='Codex'&&document.querySelectorAll('.hplbl')[1].textContent==='주간';
   petEl.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await refreshUsage(false);
   return {codex,claude:selectedProvider==='claude'&&document.querySelector('#usage-provider-icon').alt==='Claude',saved:localStorage.getItem('selectedProvider')==='claude'};
 })()`);
 if(Object.values(providerCycle).some(v=>!v))throw Error('Provider cycle failed '+JSON.stringify(providerCycle));
 if(errors.length)throw Error(errors.join('\n'));
 console.log('UI_PASS',JSON.stringify({initial,transition,closeChecks,wakeChecks,priority,providerCycle,capture}));app.quit();
 }catch(e){console.error(e);app.exit(1)}
});
