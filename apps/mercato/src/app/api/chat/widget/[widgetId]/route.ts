import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(_req: Request, { params }: { params: Promise<{ widgetId: string }> }) {
  try {
    await bootstrap()
    const { widgetId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const widget = await knex('chat_widgets').where('id', widgetId).andWhere('is_active', true).first()
    if (!widget) {
      return new NextResponse('/* widget not found */', {
        status: 404,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
      })
    }

    const config = typeof widget.config === 'string' ? JSON.parse(widget.config) : widget.config || {}
    const primaryColor = config.primaryColor || '#3B82F6'
    const position = config.position || 'bottom-right'
    const greeting = (widget.greeting_message || 'Hi there! How can we help you today?').replace(/'/g, "\\'").replace(/\n/g, '\\n')

    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    const apiBase = `${origin}/api/chat/public`

    const posRight = position === 'bottom-left' ? 'auto' : '20px'
    const posLeft = position === 'bottom-left' ? '20px' : 'auto'

    const script = `(function(){
  if(window.__omChatLoaded) return;
  window.__omChatLoaded=true;

  var WIDGET_ID='${widgetId}';
  var PRIMARY='${primaryColor}';
  var GREETING='${greeting}';
  var API='${apiBase}';
  var convId=sessionStorage.getItem('om_chat_conv_'+WIDGET_ID)||null;
  var pollTimer=null;
  var isOpen=false;
  var hasIdentified=false;

  function hsl(hex,l){var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);r/=255;g/=255;b/=255;var mx=Math.max(r,g,b),mn=Math.min(r,g,b),h,s,ll=(mx+mn)/2;if(mx===mn){h=s=0}else{var d=mx-mn;s=ll>0.5?d/(2-mx-mn):d/(mx+mn);switch(mx){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break}}return 'hsl('+Math.round(h*360)+','+Math.round(s*100)+'%,'+l+'%)';}

  var style=document.createElement('style');
  style.textContent=\`
    #om-chat-bubble{position:fixed;bottom:20px;${position==='bottom-left'?'left:20px':'right:20px'};width:60px;height:60px;border-radius:50%;background:\${PRIMARY};color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:999999;display:flex;align-items:center;justify-content:center;transition:transform 0.2s}
    #om-chat-bubble:hover{transform:scale(1.1)}
    #om-chat-bubble svg{width:28px;height:28px;fill:#fff}
    #om-chat-window{position:fixed;bottom:90px;${position==='bottom-left'?'left:20px':'right:20px'};width:380px;max-width:calc(100vw - 40px);height:500px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,0.12);z-index:999999;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    #om-chat-window.open{display:flex}
    #om-chat-header{background:\${PRIMARY};color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #om-chat-header h3{margin:0;font-size:16px;font-weight:600}
    #om-chat-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;padding:0;line-height:1;opacity:0.8}
    #om-chat-close:hover{opacity:1}
    #om-chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
    .om-msg{max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word}
    .om-msg-visitor{align-self:flex-end;background:\${PRIMARY};color:#fff;border-bottom-right-radius:4px}
    .om-msg-business{align-self:flex-start;background:#f1f5f9;color:#1e293b;border-bottom-left-radius:4px}
    .om-msg-system{align-self:center;background:transparent;color:#94a3b8;font-size:12px;font-style:italic}
    #om-chat-identify{padding:12px 16px;border-top:1px solid #e2e8f0;background:#f8fafc;display:none;flex-direction:column;gap:8px}
    #om-chat-identify input{padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
    #om-chat-identify input:focus{border-color:\${PRIMARY}}
    #om-chat-identify button{padding:8px 12px;background:\${PRIMARY};color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500}
    #om-chat-input-area{padding:12px 16px;border-top:1px solid #e2e8f0;display:flex;gap:8px;background:#fff}
    #om-chat-input{flex:1;padding:10px 14px;border:1px solid #e2e8f0;border-radius:24px;font-size:14px;outline:none;resize:none}
    #om-chat-input:focus{border-color:\${PRIMARY}}
    #om-chat-send{width:36px;height:36px;border-radius:50%;background:\${PRIMARY};color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;align-self:flex-end}
    #om-chat-send:disabled{opacity:0.5;cursor:not-allowed}
    #om-chat-send svg{width:18px;height:18px;fill:#fff}
    #om-chat-typing{display:none;align-items:center;gap:6px;padding:4px 16px;font-size:12px;color:#94a3b8}
    #om-chat-typing.visible{display:flex}
    .om-typing-dot{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:om-pulse 1.4s infinite ease-in-out}
    .om-typing-dot:nth-child(2){animation-delay:0.2s}
    .om-typing-dot:nth-child(3){animation-delay:0.4s}
    @keyframes om-pulse{0%,80%,100%{opacity:0.3;transform:scale(0.8)}40%{opacity:1;transform:scale(1)}}
    @media(max-width:440px){#om-chat-window{width:calc(100vw - 20px);bottom:80px;left:10px;right:10px;height:calc(100vh - 100px)}}
  \`;
  document.head.appendChild(style);

  var bubble=document.createElement('button');
  bubble.id='om-chat-bubble';
  bubble.setAttribute('aria-label','Open chat');
  bubble.innerHTML='<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';
  document.body.appendChild(bubble);

  var win=document.createElement('div');
  win.id='om-chat-window';
  win.innerHTML=\`
    <div id="om-chat-header"><h3>\${GREETING.length>50?GREETING.slice(0,50)+'...':'Chat with us'}</h3><button id="om-chat-close">&times;</button></div>
    <div id="om-chat-messages"></div>
    <div id="om-chat-identify">
      <input type="text" id="om-chat-name" placeholder="Your name (optional)">
      <input type="email" id="om-chat-email" placeholder="Your email (optional)">
      <button id="om-chat-start">Start chatting</button>
    </div>
    <div id="om-chat-typing"><span class="om-typing-dot"></span><span class="om-typing-dot"></span><span class="om-typing-dot"></span><span>Agent is typing...</span></div>
    <div id="om-chat-input-area">
      <input type="text" id="om-chat-input" placeholder="Type a message...">
      <button id="om-chat-send" disabled><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
    </div>
  \`;
  document.body.appendChild(win);

  var msgArea=document.getElementById('om-chat-messages');
  var identifyBox=document.getElementById('om-chat-identify');
  var inputArea=document.getElementById('om-chat-input-area');
  var chatInput=document.getElementById('om-chat-input');
  var sendBtn=document.getElementById('om-chat-send');

  function addMsg(text,type){
    var d=document.createElement('div');
    d.className='om-msg om-msg-'+type;
    d.textContent=text;
    msgArea.appendChild(d);
    msgArea.scrollTop=msgArea.scrollHeight;
  }

  function showIdentify(){
    if(!convId&&!hasIdentified){identifyBox.style.display='flex';inputArea.style.display='none'}
    else{identifyBox.style.display='none';inputArea.style.display='flex'}
  }

  bubble.onclick=function(){
    isOpen=!isOpen;
    if(isOpen){
      win.classList.add('open');
      if(!convId&&!hasIdentified){
        msgArea.innerHTML='';
        addMsg(GREETING,'system');
        showIdentify();
      }else{
        showIdentify();
        chatInput.focus();
        startPoll();
      }
    }else{
      win.classList.remove('open');
      stopPoll();
    }
  };

  document.getElementById('om-chat-close').onclick=function(){
    isOpen=false;
    win.classList.remove('open');
    stopPoll();
  };

  document.getElementById('om-chat-start').onclick=function(){
    hasIdentified=true;
    showIdentify();
    chatInput.focus();
    addMsg(GREETING,'system');
  };

  var typingTimer=null;
  var typingSent=false;
  var TYPING_API=API.replace('/public','/typing');
  var typingIndicator=document.getElementById('om-chat-typing');

  function sendTyping(typing){
    if(!convId)return;
    fetch(TYPING_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversationId:convId,isTyping:typing,sender:'visitor'})}).catch(function(){});
  }

  chatInput.oninput=function(){
    sendBtn.disabled=!chatInput.value.trim();
    if(!typingSent&&chatInput.value.trim()){typingSent=true;sendTyping(true)}
    if(typingTimer)clearTimeout(typingTimer);
    typingTimer=setTimeout(function(){typingSent=false;sendTyping(false)},3000);
  };
  chatInput.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend()}};
  sendBtn.onclick=doSend;

  function doSend(){
    var text=chatInput.value.trim();
    if(!text)return;
    chatInput.value='';
    sendBtn.disabled=true;
    addMsg(text,'visitor');
    if(typingTimer)clearTimeout(typingTimer);
    typingSent=false;
    sendTyping(false);

    if(!convId){
      var name=document.getElementById('om-chat-name').value.trim()||undefined;
      var email=document.getElementById('om-chat-email').value.trim()||undefined;
      fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({widgetId:WIDGET_ID,visitorName:name,visitorEmail:email,message:text})})
        .then(function(r){return r.json()})
        .then(function(d){
          if(d.ok){convId=d.data.conversationId;sessionStorage.setItem('om_chat_conv_'+WIDGET_ID,convId);startPoll()}
          else addMsg('Failed to start conversation. Please try again.','system');
        }).catch(function(){addMsg('Connection error. Please try again.','system')});
    }else{
      fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversationId:convId,message:text})})
        .then(function(r){return r.json()})
        .then(function(d){if(!d.ok)addMsg('Failed to send. Please try again.','system')})
        .catch(function(){addMsg('Connection error. Please try again.','system')});
    }
  }

  var lastMsgCount=0;
  function poll(){
    if(!convId)return;
    fetch(API+'?conversationId='+convId)
      .then(function(r){return r.json()})
      .then(function(d){
        if(!d.ok||!d.data||!d.data.messages)return;
        var msgs=d.data.messages;
        if(msgs.length>lastMsgCount){
          msgArea.innerHTML='';
          addMsg(GREETING,'system');
          for(var i=0;i<msgs.length;i++){
            addMsg(msgs[i].message,msgs[i].sender_type==='visitor'?'visitor':'business');
          }
          lastMsgCount=msgs.length;
        }
        var agentTyping=d.data.agent_typing&&d.data.agent_typing_at&&(Date.now()-new Date(d.data.agent_typing_at).getTime()<5000);
        if(agentTyping){typingIndicator.classList.add('visible')}else{typingIndicator.classList.remove('visible')}
      }).catch(function(){});
  }

  function startPoll(){stopPoll();poll();pollTimer=setInterval(poll,5000)}
  function stopPoll(){if(pollTimer){clearInterval(pollTimer);pollTimer=null}}

  if(convId){
    hasIdentified=true;
    lastMsgCount=0;
  }
})();`;

    return new NextResponse(script, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error) {
    console.error('[chat.widget.script]', error)
    return new NextResponse('/* error */', {
      status: 500,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Embeddable chat widget JavaScript',
  methods: {
    GET: { summary: 'Serve the embeddable chat widget script', tags: ['Chat'] },
  },
}
