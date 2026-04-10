
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const widget = await knex('chat_widgets')
      .where('slug', slug)
      .andWhere('is_active', true)
      .first()

    if (!widget) {
      return new NextResponse(notFoundHtml(), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    const businessName = widget.business_name || widget.name || 'Chat'
    const brandColor = widget.brand_color || '#3B82F6'
    const welcomeMessage = (widget.welcome_message || widget.greeting_message || 'Hi there! How can we help you today?')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    const description = widget.description
      ? widget.description.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : 'We typically reply in a few minutes'
    const safeBusinessName = businessName.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const initials = getInitials(safeBusinessName)

    const html = buildChatPageHtml({
      widgetId: widget.id,
      businessName: safeBusinessName,
      brandColor,
      welcomeMessage,
      description,
      initials,
      origin,
    })

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error) {
    console.error('[chat.page.slug]', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return parts[0] ? parts[0][0].toUpperCase() : '?'
}

function notFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat Not Found</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #334155; }
    .container { text-align: center; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Chat Not Found</h1>
    <p>This chat page doesn't exist or has been deactivated.</p>
  </div>
</body>
</html>`
}

function buildChatPageHtml({
  widgetId,
  businessName,
  brandColor,
  welcomeMessage,
  description,
  initials,
  origin,
}: {
  widgetId: string
  businessName: string
  brandColor: string
  welcomeMessage: string
  description: string
  initials: string
  origin: string
}): string {
  // Escape for JS strings
  const jsBusinessName = businessName.replace(/'/g, "\\'").replace(/\\/g, '\\\\')
  const jsWelcomeMessage = welcomeMessage.replace(/'/g, "\\'").replace(/\\/g, '\\\\').replace(/\n/g, '\\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat with ${businessName}</title>
  <meta name="description" content="${description}">
  <link rel="icon" href="${origin}/favicon.ico">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --brand: ${brandColor};
      --brand-light: ${brandColor}15;
      --brand-hover: ${brandColor}dd;
      --bg: #ffffff;
      --bg-secondary: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-secondary: #64748b;
      --text-muted: #94a3b8;
      --visitor-bubble: var(--brand);
      --visitor-text: #ffffff;
      --agent-bubble: #f1f5f9;
      --agent-text: #0f172a;
      --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
      --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.06);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg-secondary);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .chat-wrapper {
      max-width: 640px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      background: var(--bg);
      box-shadow: var(--shadow-lg);
    }

    @media (min-width: 768px) {
      .chat-wrapper {
        min-height: 100vh;
        border-left: 1px solid var(--border);
        border-right: 1px solid var(--border);
      }
    }

    /* Header */
    .chat-header {
      background: var(--brand);
      color: #ffffff;
      padding: 1.25rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.875rem;
      flex-shrink: 0;
    }

    .chat-header .avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(255,255,255,0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 1rem;
      flex-shrink: 0;
    }

    .chat-header .info h1 {
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.3;
    }

    .chat-header .info p {
      font-size: 0.8125rem;
      opacity: 0.85;
      margin-top: 0.125rem;
    }

    .online-dot {
      width: 8px;
      height: 8px;
      background: #34d399;
      border-radius: 50%;
      display: inline-block;
      margin-right: 4px;
      vertical-align: middle;
    }

    /* Messages */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem 1rem 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .message {
      display: flex;
      max-width: 80%;
      animation: fadeIn 0.2s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.visitor {
      align-self: flex-end;
    }

    .message.agent {
      align-self: flex-start;
    }

    .message .bubble {
      padding: 0.625rem 0.875rem;
      border-radius: 1.125rem;
      font-size: 0.875rem;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .message.visitor .bubble {
      background: var(--visitor-bubble);
      color: var(--visitor-text);
      border-bottom-right-radius: 0.375rem;
    }

    .message.agent .bubble {
      background: var(--agent-bubble);
      color: var(--agent-text);
      border-bottom-left-radius: 0.375rem;
    }

    .message .meta {
      font-size: 0.6875rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .message.visitor .meta {
      justify-content: flex-end;
    }

    .message .bot-badge {
      font-size: 0.625rem;
      color: #8b5cf6;
      font-weight: 500;
    }

    .message-spacer {
      margin-top: 0.75rem;
    }

    /* Welcome message */
    .welcome-message {
      text-align: center;
      padding: 1.5rem 1rem;
    }

    .welcome-message p {
      font-size: 0.875rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .typing-dots {
      display: flex;
      gap: 3px;
    }

    .typing-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--text-muted);
      animation: typingBounce 1.2s infinite;
    }

    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typingBounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }

    /* Identify form */
    .identify-form {
      padding: 1.5rem;
      border-top: 1px solid var(--border);
      background: var(--bg);
    }

    .identify-form h3 {
      font-size: 0.9375rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .identify-form p {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-bottom: 1rem;
    }

    .identify-form .field {
      margin-bottom: 0.75rem;
    }

    .identify-form label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 0.25rem;
    }

    .identify-form input {
      width: 100%;
      padding: 0.5625rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
      background: var(--bg);
      color: var(--text);
    }

    .identify-form input:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 3px var(--brand-light);
    }

    .identify-form .start-btn {
      width: 100%;
      padding: 0.625rem 1rem;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      font-family: inherit;
      margin-top: 0.25rem;
    }

    .identify-form .start-btn:hover {
      background: var(--brand-hover);
    }

    .identify-form .start-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Composer */
    .composer {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      background: var(--bg);
      flex-shrink: 0;
    }

    .composer textarea {
      flex: 1;
      resize: none;
      border: 1px solid var(--border);
      border-radius: 1.25rem;
      padding: 0.5625rem 1rem;
      font-size: 0.875rem;
      font-family: inherit;
      outline: none;
      max-height: 120px;
      min-height: 40px;
      line-height: 1.4;
      background: var(--bg);
      color: var(--text);
      transition: border-color 0.15s;
    }

    .composer textarea:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 3px var(--brand-light);
    }

    .composer .send-btn {
      width: 40px;
      height: 40px;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, transform 0.1s;
      flex-shrink: 0;
    }

    .composer .send-btn:hover {
      background: var(--brand-hover);
      transform: scale(1.05);
    }

    .composer .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }

    .composer .send-btn svg {
      width: 18px;
      height: 18px;
    }

    /* Scrollbar */
    .messages::-webkit-scrollbar {
      width: 5px;
    }
    .messages::-webkit-scrollbar-track {
      background: transparent;
    }
    .messages::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }

    /* Hidden */
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="chat-wrapper">
    <div class="chat-header">
      <div class="avatar">${initials}</div>
      <div class="info">
        <h1>${businessName}</h1>
        <p><span class="online-dot"></span>${description}</p>
      </div>
    </div>

    <div class="messages" id="messages">
      <div class="welcome-message" id="welcome">
        <p>${welcomeMessage}</p>
      </div>
    </div>

    <div class="typing-indicator hidden" id="typing">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <span>Typing...</span>
    </div>

    <div class="identify-form" id="identifyForm">
      <h3>Start a conversation</h3>
      <p>Let us know who you are so we can help you better.</p>
      <div class="field">
        <label for="visitorName">Your name</label>
        <input type="text" id="visitorName" placeholder="John Doe" autocomplete="name">
      </div>
      <div class="field">
        <label for="visitorEmail">Email address</label>
        <input type="email" id="visitorEmail" placeholder="john@example.com" autocomplete="email">
      </div>
      <div class="field">
        <label for="firstMessage">Message</label>
        <input type="text" id="firstMessage" placeholder="How can we help you?">
      </div>
      <button class="start-btn" id="startBtn" disabled>Start Chat</button>
    </div>

    <div class="composer hidden" id="composer">
      <textarea id="messageInput" rows="1" placeholder="Type a message..."></textarea>
      <button class="send-btn" id="sendBtn" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
    <p style="text-align:center;font-size:10px;color:rgba(0,0,0,0.35);margin:0;padding:4px 0 8px;line-height:1.3;flex-shrink:0">AI can make mistakes. Please double check responses.</p>

  </div>

  <script>
    (function() {
      var API = '${origin}/api/chat/public';
      var WIDGET_ID = '${widgetId}';
      var conversationId = null;
      var pollTimer = null;
      var lastMessageCount = 0;

      var messagesEl = document.getElementById('messages');
      var welcomeEl = document.getElementById('welcome');
      var typingEl = document.getElementById('typing');
      var identifyForm = document.getElementById('identifyForm');
      var composerEl = document.getElementById('composer');
      var nameInput = document.getElementById('visitorName');
      var emailInput = document.getElementById('visitorEmail');
      var firstMsgInput = document.getElementById('firstMessage');
      var startBtn = document.getElementById('startBtn');
      var messageInput = document.getElementById('messageInput');
      var sendBtn = document.getElementById('sendBtn');

      // Enable start button when message is entered
      function checkStartEnabled() {
        startBtn.disabled = !firstMsgInput.value.trim();
      }
      firstMsgInput.addEventListener('input', checkStartEnabled);
      nameInput.addEventListener('input', checkStartEnabled);
      emailInput.addEventListener('input', checkStartEnabled);

      // Start chat
      startBtn.addEventListener('click', function() {
        startChat();
      });

      firstMsgInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !startBtn.disabled) {
          e.preventDefault();
          startChat();
        }
      });

      function startChat() {
        var name = nameInput.value.trim();
        var email = emailInput.value.trim();
        var message = firstMsgInput.value.trim();
        if (!message) return;

        startBtn.disabled = true;
        startBtn.textContent = 'Starting...';

        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widgetId: WIDGET_ID,
            visitorName: name || null,
            visitorEmail: email || null,
            message: message,
          }),
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            conversationId = data.data.conversationId;
            identifyForm.classList.add('hidden');
            composerEl.classList.remove('hidden');
            welcomeEl.classList.add('hidden');
            addMessage(message, 'visitor');
            startPolling();
            messageInput.focus();
          } else {
            startBtn.disabled = false;
            startBtn.textContent = 'Start Chat';
            alert('Failed to start chat. Please try again.');
          }
        })
        .catch(function() {
          startBtn.disabled = false;
          startBtn.textContent = 'Start Chat';
          alert('Connection error. Please try again.');
        });
      }

      // Send message
      function sendMessage() {
        var text = messageInput.value.trim();
        if (!text || !conversationId) return;
        sendBtn.disabled = true;
        messageInput.value = '';
        autoResize();

        addMessage(text, 'visitor');

        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversationId,
            message: text,
          }),
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.ok) {
            addSystemMessage('Failed to send message');
          }
          sendBtn.disabled = false;
        })
        .catch(function() {
          addSystemMessage('Connection error');
          sendBtn.disabled = false;
        });
      }

      sendBtn.addEventListener('click', sendMessage);
      messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      messageInput.addEventListener('input', function() {
        sendBtn.disabled = !messageInput.value.trim();
        autoResize();
        // Send typing indicator
        if (conversationId && messageInput.value.trim()) {
          fetch('${origin}/api/chat/typing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: conversationId, isTyping: true, sender: 'visitor' }),
          }).catch(function() {});
        }
      });

      function autoResize() {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
      }

      // Render messages
      function addMessage(text, type, isBot) {
        var wrapper = document.createElement('div');
        wrapper.className = 'message ' + type;

        var prevLast = messagesEl.querySelector('.message:last-of-type');
        if (prevLast && !prevLast.classList.contains(type)) {
          wrapper.classList.add('message-spacer');
        }

        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = text;
        wrapper.appendChild(bubble);

        if (isBot) {
        }

        messagesEl.appendChild(wrapper);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function addSystemMessage(text) {
        var div = document.createElement('div');
        div.style.textAlign = 'center';
        div.style.padding = '0.5rem';
        var span = document.createElement('span');
        span.style.fontSize = '0.75rem';
        span.style.color = 'var(--text-muted)';
        span.style.background = 'var(--bg-secondary)';
        span.style.padding = '0.25rem 0.75rem';
        span.style.borderRadius = '1rem';
        span.textContent = text;
        div.appendChild(span);
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // Poll for new messages
      function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollMessages();
        pollTimer = setInterval(pollMessages, 3000);
      }

      function pollMessages() {
        if (!conversationId) return;
        fetch(API + '?conversationId=' + conversationId)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data.ok) return;
            var msgs = data.data.messages;

            // Show typing indicator
            if (data.data.agent_typing && data.data.agent_typing_at) {
              var elapsed = Date.now() - new Date(data.data.agent_typing_at).getTime();
              if (elapsed < 5000) {
                typingEl.classList.remove('hidden');
              } else {
                typingEl.classList.add('hidden');
              }
            } else {
              typingEl.classList.add('hidden');
            }

            // Only add new messages (agent/business/system only, visitor messages are added locally)
            if (msgs.length > lastMessageCount) {
              var newMsgs = msgs.slice(lastMessageCount);
              for (var i = 0; i < newMsgs.length; i++) {
                var m = newMsgs[i];
                if (m.sender_type === 'business') {
                  addMessage(m.message, 'agent', m.is_bot);
                } else if (m.sender_type === 'system') {
                  addSystemMessage(m.message);
                }
                // Skip visitor messages — already rendered locally
              }
              lastMessageCount = msgs.length;
            }
          })
          .catch(function() {});
      }

      // Restore session
      try {
        var stored = sessionStorage.getItem('chat_session_' + WIDGET_ID);
        if (stored) {
          var session = JSON.parse(stored);
          conversationId = session.conversationId;
          if (conversationId) {
            identifyForm.classList.add('hidden');
            composerEl.classList.remove('hidden');
            welcomeEl.classList.add('hidden');

            // Load existing messages
            fetch(API + '?conversationId=' + conversationId)
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data.ok) {
                  var msgs = data.data.messages;
                  for (var i = 0; i < msgs.length; i++) {
                    var m = msgs[i];
                    if (m.sender_type === 'visitor') {
                      addMessage(m.message, 'visitor');
                    } else if (m.sender_type === 'business') {
                      addMessage(m.message, 'agent', m.is_bot);
                    } else if (m.sender_type === 'system') {
                      addSystemMessage(m.message);
                    }
                  }
                  lastMessageCount = msgs.length;
                  startPolling();
                } else {
                  // Session invalid, clear it
                  sessionStorage.removeItem('chat_session_' + WIDGET_ID);
                  conversationId = null;
                  identifyForm.classList.remove('hidden');
                  composerEl.classList.add('hidden');
                }
              })
              .catch(function() {
                sessionStorage.removeItem('chat_session_' + WIDGET_ID);
                conversationId = null;
                identifyForm.classList.remove('hidden');
                composerEl.classList.add('hidden');
              });
          }
        }
      } catch(e) {}

      // Save session when conversation starts
      var origStartChat = startChat;
      var origFetch = fetch;

      // Override to save session
      var _origStartChat = startChat;
      // We use MutationObserver to detect when conversationId is set
      setInterval(function() {
        if (conversationId) {
          try {
            sessionStorage.setItem('chat_session_' + WIDGET_ID, JSON.stringify({ conversationId: conversationId }));
          } catch(e) {}
        }
      }, 1000);
    })();
  </script>
</body>
</html>`
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Branded public chat page',
  methods: {
    GET: { summary: 'Serve branded chat page by slug', tags: ['Chat'] },
  },
}
