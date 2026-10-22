const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<button role="combobox">Veo 3.1</button><button role="option">Gemini Omni Flash</button><button role="option">10s</button><button role="switch" aria-checked="false">Audio off</button>',{url:'https://flow.google.com/'});
for(const key of ['window','document','Event','HTMLElement','getComputedStyle'])globalThis[key]=dom.window[key];
Object.defineProperty(HTMLElement.prototype,'offsetWidth',{get(){return 50}});
Object.defineProperty(HTMLElement.prototype,'innerText',{get(){return this.textContent}});
globalThis.PointerEvent=dom.window.PointerEvent || dom.window.MouseEvent;globalThis.MouseEvent=dom.window.MouseEvent;
globalThis.chrome={runtime:{id:'test',onMessage:{addListener(){}},sendMessage:async()=>({})}};
globalThis.AA=require('../content/common.js').AA;AA.sleep=async()=>{};
const flow=require('../content/flow.js');
const clicked=[];
for(const btn of document.querySelectorAll('button'))btn.addEventListener('click',()=>{clicked.push(btn.textContent);btn.setAttribute('aria-selected','true');if(btn.getAttribute('role')==='switch')btn.setAttribute('aria-checked','true')});
(async()=>{
 await flow.configureTurboFlow({needUser:async()=>assert.fail('available settings should be selected automatically')});
 assert.ok(clicked.includes('Gemini Omni Flash'));assert.ok(clicked.includes('10s'));assert.ok(clicked.includes('Audio off'));
 // Regression: the global gallery gear precedes the actual prompt settings.
 document.body.innerHTML=`<button id="gallery" aria-label="Settings">tune</button>
 <div role="menu"><p>Chế độ xem</p><p>Kích thước lưới</p><button id="gallery-silent" role="switch" aria-checked="false">Trả về video không có âm thanh</button></div>
 <form><textarea placeholder="Bạn muốn tạo gì?"></textarea><button type="button" id="video">Video • 720p • 8 s</button></form><div id="popup"></div>`;
 globalThis.KeyboardEvent=dom.window.KeyboardEvent;
 let galleryClicks=0;
 document.querySelector('#gallery').onclick=()=>galleryClicks++;
 document.querySelector('#gallery-silent').onclick=()=>assert.fail('must not touch gallery audio preferences');
 const popup=document.querySelector('#popup');
 document.querySelector('#video').onclick=()=>{
  popup.innerHTML='<div role="dialog"><button id="model" role="combobox">Veo 3.1</button></div>';
  document.querySelector('#model').onclick=()=>{
   popup.innerHTML='<div role="listbox"><button id="omni" role="option">Gemini Omni Flash 1.1</button></div>';
   document.querySelector('#omni').onclick=()=>{
    popup.innerHTML='<div role="dialog"><button id="duration" role="combobox">8 giây</button></div>';
    document.querySelector('#duration').onclick=()=>{
     popup.innerHTML='<div role="listbox"><button id="ten" role="option">10 giây</button></div>';
     document.querySelector('#ten').onclick=()=>{document.querySelector('#video').textContent='Video • 720p • 10s';popup.innerHTML=''};
    };
   };
  };
 };
 assert.equal(flow.flowVideoSettingsTrigger().id,'video');
 await flow.configureTurboFlow({needUser:async()=>assert.fail('nested model and duration menus should be selected')});
 assert.equal(galleryClicks,0);
 assert.equal(flow.flowDurationConfirmed(),true,'confirm committed toolbar even after options unmount');
 // Merely visible options, old gallery clips and punctuation must not give false confirmations.
 document.body.innerHTML='<button>Video - 720p - 8s</button><div role="menu"><button role="menuitem">10 seconds</button></div><flow-grid-tile-container><button>Video 10s</button></flow-grid-tile-container>';
 assert.equal(flow.flowDurationConfirmed(),false);
 document.body.innerHTML='<button aria-haspopup="listbox">10s</button>';
 assert.equal(flow.flowDurationConfirmed(),true);
 document.body.innerHTML='<select><option value="8">8 seconds</option><option value="10" selected>10 seconds</option></select>';
 assert.equal(flow.flowDurationConfirmed(),true);
 document.body.innerHTML='<button>Video · 720p · 10s</button>';
 assert.equal(flow.flowDurationConfirmed(),true);
 document.body.innerHTML='<button aria-label="Settings">tune</button><div role="menu"><p>Chế độ xem</p><p>Kích thước lưới</p></div>';
 let unexpectedGear=0;document.querySelector('button').onclick=()=>unexpectedGear++;
 let galleryNotice='';AA.waitFor=async()=>false;
 await assert.rejects(flow.configureTurboFlow({needUser:async message=>{galleryNotice=message},beat:async()=>{}}),/10/);
 assert.equal(unexpectedGear,0);
 assert.match(galleryNotice,/không phải bánh răng/);
 document.body.innerHTML='<button>8s</button>';
 let needsUser=false;AA.waitFor=async()=>false;
 await assert.rejects(flow.configureTurboFlow({needUser:async()=>{needsUser=true},beat:async()=>{}}),/10/);
 assert.equal(needsUser,true);
 console.log('Turbo Flow: model, 10s and audio selected; unsupported settings pause before spending credits passed');
})().catch(e=>{console.error(e);process.exitCode=1});
