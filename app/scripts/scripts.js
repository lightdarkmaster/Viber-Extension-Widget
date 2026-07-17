/* ============================================================
   Viber CRM Chat Widget — script.js
   Full two-way Viber messaging panel inside Zoho CRM.
   Architecture:
     · ZohoCRM  — SDK bootstrap, record fetch, activity logging
     · ViberAPI  — all backend calls (conversations, send, upload)
     · Poller    — real-time polling / SSE with reconnect logic
     · Chat      — message rendering, search, scroll management
     · UI        — toast, theme, attachment preview, composer
   By: Christian Barbosa
   ============================================================ */

'use strict';

/* ════════════════════════════════════════════════════════════
  CONFIGURATION
   Replace these values with your actual backend endpoints.
   NEVER expose Viber Bot tokens in frontend code — all calls
   must go through your secure backend proxy.
════════════════════════════════════════════════════════════ */
const CONFIG = {
    /* Your backend API base URL */
    // API_BASE: 'https://your-backend.example.com/api/viber',
    API_BASE: 'https://chatapi.viber.com/pa/set_webhook',

    /* Polling interval in ms (used when SSE is unavailable) */
    POLL_INTERVAL: 5000,

    /* How many messages to fetch per page */
    PAGE_SIZE: 30,

    /* CRM field name that holds the customer's mobile/phone */
    PHONE_FIELD: 'Mobile',

    /* CRM field name that holds the customer's name */
    NAME_FIELD: 'Full_Name',


    /* Whether to log CRM activities on each message */
    LOG_CRM_ACTIVITY: true,

    /* Character limit warning threshold (% of max) */
    CHAR_WARN_PCT: 0.85,

    /* Max file upload size in bytes (200 MB) */
    MAX_FILE_BYTES: 200 * 1024 * 1024,

    /* Allowed MIME types for attachments (empty allows all types) */
    ALLOWED_TYPES: []
};

/* ════════════════════════════════════════════════════════════
     GLOBAL STATE
════════════════════════════════════════════════════════════ */
const State = {
    crmRecord:       null,   // raw Zoho CRM record object
    customerName:    '—',
    customerPhone:   null,
    crmModule:       null,
    crmRecordId:     null,

    messages:        [],     // full message list (newest last)
    page:            1,      // current pagination page
    hasMorePages:    false,
    unread:          0,

    pendingFiles:    [],     // File objects staged for upload
    isSending:       false,
    isLoadingMore:   false,

    searchActive:    false,
    searchTerm:      '',
    searchMatches:   [],
    searchIdx:       0,

    pollTimer:       null,
    sseSource:       null,
    connStatus:      'disconnected', // connecting | connected | error | disconnected

    theme:           localStorage.getItem('viberWidgetTheme') || 'light',
    lastMessageId:   null,   // for polling delta detection
};

/* ════════════════════════════════════════════════════════════
   🔌  ZOHO CRM SDK
════════════════════════════════════════════════════════════ */
const ZohoCRM = {

    /**
     * Bootstrap the Zoho SDK. Must be the first call.
     * SDK fires PageLoad when the widget iframe is ready inside CRM.
     */
    init() {
        ZOHO.embeddedApp.on('PageLoad', async (pageData) => {
            console.log('[ZohoCRM] PageLoad fired', pageData);
            try {
                await ZohoCRM.loadRecord(pageData);
            } catch (err) {
                console.error('[ZohoCRM] init error', err);
                UI.showState('error', 'Could not load CRM record data.');
            }
        });
        ZOHO.embeddedApp.init();
    },

    /**
     * Extract the CRM module + record ID from PageLoad data,
     * then fetch the full record to get phone / name fields.
     */
    async loadRecord(pageData) {
        const entity = pageData?.Entity || pageData?.entity || 'Leads';
        const id     = pageData?.EntityId?.value
                    || pageData?.EntityId
                    || pageData?.id
                    || null;

        State.crmModule   = entity;
        State.crmRecordId = id;

        if (!id) {
            throw new Error('No record ID found in PageLoad data');
        }

        console.log(`[ZohoCRM] Loading ${entity} record ${id}`);

        const res = await ZOHO.CRM.API.getRecord({ Entity: entity, RecordID: id });
        const record = res?.data?.[0];
        if (!record) throw new Error('Record not found');

        State.crmRecord    = record;
        State.customerName = record[CONFIG.NAME_FIELD]  || record.Name || record.Full_Name || 'Unknown';
        State.customerPhone = ZohoCRM.extractPhone(record);

        console.log(`[ZohoCRM] Customer: ${State.customerName} | Phone: ${State.customerPhone}`);

        /* Update header UI */
        UI.setCustomerInfo(State.customerName, State.customerPhone);

        /* Now bootstrap the chat */
        if (!State.customerPhone) {
            UI.showState('error', `No phone number found in the "${CONFIG.PHONE_FIELD}" field.`);
            return;
        }

        await Chat.init();
    },

    /**
     * Try several common phone field names in order.
     */
    extractPhone(record) {
        const candidates = [
            CONFIG.PHONE_FIELD, 'Mobile', 'Phone', 'Mobile_Number',
            'Phone_Number', 'Viber_Number', 'Contact_Number'
        ];
        for (const key of candidates) {
            if (record[key]) return String(record[key]).replace(/\s+/g, '');
        }
        return null;
    },

    /**
     * Log a Note against the CRM record when a message is sent or received.
     * @param {object} msg — message object { direction, content, timestamp, viber_id }
     */
    async logActivity(msg) {
        if (!CONFIG.LOG_CRM_ACTIVITY || !State.crmRecordId) return;
        try {
            const note = {
                Note_Title: `Viber ${msg.direction} — ${new Date(msg.timestamp).toLocaleString()}`,
                Note_Content:
                    `Direction: ${msg.direction}\n` +
                    `Message: ${msg.content || '[attachment]'}\n` +
                    `Viber ID: ${msg.viber_id || '—'}\n` +
                    `Time: ${new Date(msg.timestamp).toISOString()}`,
                Parent_Id: State.crmRecordId,
                se_module: State.crmModule,
            };
            await ZOHO.CRM.API.insertRecord({ Entity: 'Notes', APIData: note });
            console.log('[ZohoCRM] Activity logged');
        } catch (err) {
            console.warn('[ZohoCRM] Activity log failed (non-fatal):', err);
        }
    }
};

/* ════════════════════════════════════════════════════════════
   🌐  VIBER API  (all calls through your backend proxy)
════════════════════════════════════════════════════════════ */
const ViberAPI = {

    /**
     * Central fetch wrapper. Adds auth headers and error handling.
     */
    async request(path, options = {}) {
        const url = `${CONFIG.API_BASE}${path}`;
        const res = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                /* Backend derives Viber token server-side — no token in frontend */
                'X-CRM-Record-Id': State.crmRecordId || '',
                'X-CRM-Module':    State.crmModule   || '',
                ...options.headers
            },
            ...options
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`API ${res.status}: ${body || res.statusText}`);
        }

        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
    },

    /**
     * GET /conversations?phone=…&page=N&size=N
     * Returns: { messages: [], has_more: bool, total: number }
     */
    async getConversation(phone, page = 1) {
        const params = new URLSearchParams({
            phone, page, size: CONFIG.PAGE_SIZE
        });
        return ViberAPI.request(`/conversations?${params}`);
    },

    /**
     * POST /messages/send
     * Body: { phone, text }
     * Returns: { message_id, status, timestamp }
     */
    async sendText(phone, text) {
        return ViberAPI.request('/messages/send', {
            method: 'POST',
            body: JSON.stringify({ phone, text })
        });
    },

    /**
     * POST /messages/send-media
     * Body: FormData { phone, file, type }
     * Returns: { message_id, status, timestamp }
     */
    async sendMedia(phone, file) {
        const form = new FormData();
        form.append('phone', phone);
        form.append('file', file);
        form.append('type', file.type.startsWith('image/') ? 'image' : 'file');
        return ViberAPI.request('/messages/send-media', {
            method:  'POST',
            headers: {}, /* remove Content-Type so browser sets multipart boundary */
            body:    form
        });
    },

    /**
     * POST /messages/read
     * Body: { phone, message_ids: [] }
     * Marks messages as read on Viber.
     */
    async markRead(phone, messageIds) {
        if (!messageIds.length) return;
        return ViberAPI.request('/messages/read', {
            method: 'POST',
            body: JSON.stringify({ phone, message_ids: messageIds })
        }).catch(err => console.warn('[ViberAPI] markRead failed (non-fatal):', err));
    },

    /**
     * GET /messages/delta?phone=…&after_id=…
     * Lightweight endpoint that returns only messages newer than after_id.
     * Used by the poller for incremental updates.
     */
    async getDelta(phone, afterId) {
        const params = new URLSearchParams({ phone, after_id: afterId || '' });
        return ViberAPI.request(`/messages/delta?${params}`);
    },

    /**
     * GET /customers?phone=…
     * Optional — fetches extended customer info from Viber.
     */
    async getCustomer(phone) {
        const params = new URLSearchParams({ phone });
        return ViberAPI.request(`/customers?${params}`).catch(() => null);
    }
};

/* ════════════════════════════════════════════════════════════
   🔄  POLLER — real-time synchronisation
   Strategy: try SSE first; fall back to polling every N seconds.
   Auto-reconnects on network loss with exponential back-off.
════════════════════════════════════════════════════════════ */
const Poller = {

    reconnectDelay: CONFIG.POLL_INTERVAL,
    maxDelay:       60000,
    _retryTimer:    null,

    /**
     * Start listening for new messages.
     * Tries SSE; if the browser or server doesn't support it, falls back to polling.
     */
    start() {
        Poller.stop();
        Poller.setStatus('connecting');

        const sseUrl = `${CONFIG.API_BASE}/stream?phone=${encodeURIComponent(State.customerPhone)}&record_id=${State.crmRecordId}`;

        /* Test SSE availability */
        if (typeof EventSource !== 'undefined') {
            Poller._startSSE(sseUrl);
        } else {
            Poller._startPolling();
        }
    },

    _startSSE(url) {
        console.log('[Poller] Starting SSE…');
        const es = new EventSource(url);
        State.sseSource = es;

        /* Timeout: if SSE doesn't open within 8 s, fall back to polling */
        const connectTimeout = setTimeout(() => {
            if (State.connStatus !== 'connected') {
                console.warn('[Poller] SSE connect timeout — falling back to polling');
                es.close();
                State.sseSource = null;
                Poller._startPolling();
            }
        }, 8000);

        es.onopen = () => {
            console.log('[Poller] SSE connected');
            clearTimeout(connectTimeout);
            Poller.setStatus('connected');
            Poller.reconnectDelay = CONFIG.POLL_INTERVAL;
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                Poller._handleIncoming(data);
            } catch (e) {
                console.warn('[Poller] SSE parse error', e);
            }
        };

        es.addEventListener('typing', (event) => {
            const data = JSON.parse(event.data || '{}');
            if (data.is_typing) Chat.showTyping();
            else Chat.hideTyping();
        });

        es.onerror = () => {
            console.warn('[Poller] SSE error — falling back to polling');
            clearTimeout(connectTimeout);
            es.close();
            State.sseSource = null;
            Poller._startPolling();
        };
    },

    _startPolling() {
        console.log(`[Poller] Polling every ${Poller.reconnectDelay}ms`);
        /* Only set connecting on the very first attempt; subsequent retries keep
           the current status so the bar doesn't flicker back to "Connecting…"
           after a successful poll. */
        if (State.connStatus !== 'connected') {
            Poller.setStatus('connecting');
        }

        const poll = async () => {
            try {
                const res = await ViberAPI.getDelta(State.customerPhone, State.lastMessageId);
                if (res?.messages?.length) {
                    Poller._handleIncoming(res);
                }
                Poller.reconnectDelay = CONFIG.POLL_INTERVAL; /* reset back-off */
                Poller.setStatus('connected');
            } catch (err) {
                console.warn('[Poller] Poll error:', err);
                Poller.setStatus('error');
                /* Exponential back-off, capped at maxDelay */
                Poller.reconnectDelay = Math.min(Poller.reconnectDelay * 1.5, Poller.maxDelay);
            }
            State.pollTimer = setTimeout(poll, Poller.reconnectDelay);
        };

        poll();
    },

    /**
     * Process a batch of new incoming messages from SSE or polling delta.
     */
    _handleIncoming(data) {
        const newMsgs = Array.isArray(data.messages) ? data.messages : (data.message ? [data.message] : []);
        if (!newMsgs.length) return;

        let addedCount = 0;
        newMsgs.forEach(msg => {
            /* Deduplicate by message ID */
            if (!State.messages.find(m => m.id === msg.id)) {
                State.messages.push(msg);
                Chat.appendMessage(msg);
                addedCount++;

                /* Log to CRM */
                ZohoCRM.logActivity({
                    direction:  msg.direction || 'Inbound',
                    content:    msg.text || null,
                    timestamp:  msg.timestamp || Date.now(),
                    viber_id:   msg.id
                });
            }
        });

        if (addedCount > 0) {
            /* Update last known ID for delta polling */
            State.lastMessageId = State.messages[State.messages.length - 1].id;

            /* Manage unread counter */
            const atBottom = Chat.isAtBottom();
            if (!atBottom) {
                State.unread += addedCount;
                UI.setUnread(State.unread);
            } else {
                Chat.scrollToBottom();
                ViberAPI.markRead(State.customerPhone, newMsgs.map(m => m.id).filter(Boolean));
            }
        }
    },

    /** Update connection status dot + text */
    setStatus(status) {
        State.connStatus = status;
        const dot  = document.getElementById('connDot');
        const text = document.getElementById('connText');
        const bar  = document.getElementById('connBar');
        const avSt = document.getElementById('avatarStatus');

        const MAP = {
            connecting:    { cls: 'connecting', label: 'Connecting…',    barCls: '',            avCls: '',        barHide: false },
            connected:     { cls: 'connected',  label: 'Connected',      barCls: 'connected',   avCls: 'online',  barHide: true  },
            error:         { cls: 'error',      label: 'Connection lost — retrying…', barCls: 'error-state', avCls: 'error',   barHide: false },
            disconnected:  { cls: '',           label: 'Disconnected',   barCls: '',            avCls: 'offline', barHide: false }
        };

        const cfg = MAP[status] || MAP.disconnected;
        dot.className  = `conn-dot ${cfg.cls}`;
        text.textContent = cfg.label;
        bar.className  = `conn-bar ${cfg.barCls}`;
        avSt.className = `avatar-status ${cfg.avCls}`;

        /* Slide the bar in/out so it doesn't permanently consume layout space */
        bar.style.display = cfg.barHide ? 'none' : '';
    },

    stop() {
        if (State.sseSource)  { State.sseSource.close(); State.sseSource = null; }
        if (State.pollTimer)  { clearTimeout(State.pollTimer); State.pollTimer = null; }
    },

    /** Restart on network recovery */
    restart() {
        console.log('[Poller] Restarting…');
        Poller.stop();
        Poller.reconnectDelay = CONFIG.POLL_INTERVAL;
        Poller.start();
    }
};

/* ════════════════════════════════════════════════════════════
   💬  CHAT — rendering, scrolling, search
════════════════════════════════════════════════════════════ */
const Chat = {

    /**
     * Load initial conversation history then start real-time sync.
     */
    async init() {
        UI.showState('loading');
        try {
            const res = await ViberAPI.getConversation(State.customerPhone, 1);
            const msgs = res?.messages || [];

            State.messages    = msgs;
            State.hasMorePages = !!res?.has_more;
            State.page        = 1;

            if (msgs.length === 0) {
                UI.showState('empty');
            } else {
                UI.showState('chat');
                Chat.renderAll();
                Chat.scrollToBottom(false);
                State.lastMessageId = msgs[msgs.length - 1]?.id || null;

                /* Mark all visible as read */
                const ids = msgs.filter(m => m.direction === 'Inbound').map(m => m.id);
                ViberAPI.markRead(State.customerPhone, ids);
            }

            /* Show load-more button if there are older pages */
            document.getElementById('loadMoreWrap').style.display = State.hasMorePages ? 'block' : 'none';

            /* Start real-time listener */
            Poller.start();

        } catch (err) {
            console.error('[Chat] init error:', err);
            UI.showState('error', 'Failed to load conversation. Check your backend connection.');
        }
    },

    /** Render all messages from scratch */
    renderAll() {
        const container = document.getElementById('messages');
        container.innerHTML = '';

        let lastDate = null;
        let lastDirection = null;

        State.messages.forEach((msg, idx) => {
            const msgDate = Chat.formatDate(msg.timestamp);
            if (msgDate !== lastDate) {
                container.appendChild(Chat.makeDateSeparator(msgDate));
                lastDate = msgDate;
            }

            /* Group consecutive same-direction messages (no tail on non-last) */
            const next = State.messages[idx + 1];
            const isLast = !next || next.direction !== msg.direction || Chat.formatDate(next.timestamp) !== msgDate;

            container.appendChild(Chat.makeRow(msg, !isLast));
            lastDirection = msg.direction;
        });
    },

    /** Append a single new message to the bottom */
    appendMessage(msg) {
        const container = document.getElementById('messages');
        const lastMsg   = State.messages[State.messages.length - 2]; /* before this one */
        const msgDate   = Chat.formatDate(msg.timestamp);
        const lastDate  = lastMsg ? Chat.formatDate(lastMsg.timestamp) : null;

        if (msgDate !== lastDate) {
            container.appendChild(Chat.makeDateSeparator(msgDate));
        }

        /* Fix no-tail on previously last bubble if same direction */
        if (lastMsg && lastMsg.direction === msg.direction) {
            const prev = container.querySelector(`.msg-row[data-id="${lastMsg.id}"]`);
            if (prev) prev.classList.add('no-tail');
        }

        const row = Chat.makeRow(msg, false);
        container.appendChild(row);
    },

    /** Build a date separator element */
    makeDateSeparator(label) {
        const div = document.createElement('div');
        div.className = 'date-sep';
        div.innerHTML = `<span class="date-sep-label">${label}</span>`;
        return div;
    },

    /**
     * Build a complete message row element.
     * @param {object} msg
     * @param {boolean} noTail — true when followed by same-direction message
     */
    makeRow(msg, noTail = false) {
        const row = document.createElement('div');
        const dir = (msg.direction === 'Outbound') ? 'outgoing' : 'incoming';
        row.className = `msg-row ${dir}${noTail ? ' no-tail' : ''}${msg._sending ? ' sending' : ''}`;
        row.dataset.id = msg.id || '';

        /* Avatar (incoming only; hidden for non-last in group) */
        if (dir === 'incoming') {
            const av = document.createElement('div');
            av.className = `msg-avatar${noTail ? ' hidden' : ''}`;
            av.textContent = (State.customerName[0] || '?').toUpperCase();
            row.appendChild(av);
        }

        /* Bubble */
        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        /* Content */
        bubble.appendChild(Chat.makeContent(msg));

        /* Meta (time + status) */
        const meta = document.createElement('div');
        meta.className = 'bubble-meta';
        meta.innerHTML =
            `<span class="bubble-time">${Chat.formatTime(msg.timestamp)}</span>` +
            (dir === 'outgoing' ? `<span class="status-icon">${Chat.statusIcon(msg.status)}</span>` : '');
        bubble.appendChild(meta);

        row.appendChild(bubble);
        return row;
    },

    /** Build the content portion of a bubble based on message type */
    makeContent(msg) {
        const frag = document.createDocumentFragment();

        if (msg.type === 'image' && msg.url) {
            const wrap = document.createElement('a');
            wrap.className = 'bubble-image';
            wrap.href = msg.url;
            wrap.target = '_blank';
            wrap.rel = 'noopener noreferrer';
            const img = document.createElement('img');
            img.src = msg.url;
            img.alt = msg.file_name || 'Image';
            img.loading = 'lazy';
            wrap.appendChild(img);
            frag.appendChild(wrap);
        } else if ((msg.type === 'file' || msg.type === 'document') && msg.url) {
            const wrap = document.createElement('a');
            wrap.className = 'bubble-doc';
            wrap.href = msg.url;
            wrap.target = '_blank';
            wrap.rel = 'noopener noreferrer';
            const ext = (msg.file_name || msg.url).split('.').pop().toUpperCase().slice(0, 4);
            wrap.innerHTML =
                `<div class="doc-icon">${ext}</div>` +
                `<div class="doc-info">
                    <div class="doc-name">${msg.file_name || 'Attachment'}</div>
                    <div class="doc-size">${msg.file_size ? Chat.fmtSize(msg.file_size) : ''}</div>
                </div>`;
            frag.appendChild(wrap);
        }

        /* Text content (may accompany media) */
        if (msg.text) {
            const p = document.createElement('p');
            p.textContent = msg.text;
            frag.appendChild(p);
        }

        return frag;
    },

    /** SVG icon for message delivery status */
    statusIcon(status) {
        switch (status) {
            case 'sent':
                return `<svg class="status-sent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
            case 'delivered':
                return `<svg class="status-delivered" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/><polyline points="16 6 9 13"/></svg>`;
            case 'read':
                return `<svg class="status-read" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/><polyline points="16 6 9 13"/></svg>`;
            case 'failed':
                return `<svg class="status-failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
            default:
                return `<svg class="status-sent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".5"><circle cx="12" cy="12" r="3"/></svg>`;
        }
    },

    /* ── Load more (older messages) ── */
    async loadMore() {
        if (State.isLoadingMore || !State.hasMorePages) return;
        State.isLoadingMore = true;
        const btn = document.getElementById('btnLoadMore');
        btn.disabled = true;
        btn.textContent = 'Loading…';

        const body = document.getElementById('chatBody');
        const prevScrollH = body.scrollHeight;

        try {
            State.page++;
            const res  = await ViberAPI.getConversation(State.customerPhone, State.page);
            const msgs = res?.messages || [];
            State.hasMorePages = !!res?.has_more;

            /* Prepend to State.messages */
            State.messages = [...msgs, ...State.messages];

            /* Prepend to DOM */
            const container = document.getElementById('messages');
            const frag = document.createDocumentFragment();
            let lastDate = null;

            msgs.forEach((msg, idx) => {
                const msgDate = Chat.formatDate(msg.timestamp);
                if (msgDate !== lastDate) {
                    frag.appendChild(Chat.makeDateSeparator(msgDate));
                    lastDate = msgDate;
                }
                const next = msgs[idx + 1];
                const isLast = !next || next.direction !== msg.direction;
                frag.appendChild(Chat.makeRow(msg, !isLast));
            });

            container.insertBefore(frag, container.firstChild);

            /* Restore scroll position so user doesn't jump */
            body.scrollTop = body.scrollHeight - prevScrollH;

        } catch (err) {
            console.error('[Chat] loadMore error:', err);
            UI.toast('Failed to load older messages.', 'error');
            State.page--;
        } finally {
            State.isLoadingMore = false;
            btn.disabled = false;
            btn.textContent = State.hasMorePages ? 'Load earlier messages' : 'No more messages';
            if (!State.hasMorePages) btn.style.display = 'none';
        }
    },

    /* ── Typing indicator ── */
    showTyping() {
        document.getElementById('typingIndicator').style.display = 'flex';
        Chat.scrollToBottom();
    },
    hideTyping() {
        document.getElementById('typingIndicator').style.display = 'none';
    },

    /* ── Scroll helpers ── */
    scrollToBottom(smooth = true) {
        const body = document.getElementById('chatBody');
        body.scrollTo({ top: body.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    },

    isAtBottom() {
        const body = document.getElementById('chatBody');
        return body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    },

    /* ── Search ── */
    search(term) {
        State.searchTerm    = term.trim().toLowerCase();
        State.searchMatches = [];
        State.searchIdx     = 0;

        /* Remove previous highlights */
        document.querySelectorAll('.search-highlight').forEach(el => {
            el.outerHTML = el.textContent;
        });

        if (!State.searchTerm) {
            document.getElementById('searchCount').textContent = '';
            return;
        }

        /* Find and highlight matching text nodes */
        const bubbles = document.querySelectorAll('.bubble p');
        bubbles.forEach(p => {
            if (p.textContent.toLowerCase().includes(State.searchTerm)) {
                p.innerHTML = p.textContent.replace(
                    new RegExp(`(${State.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                    '<mark class="search-highlight">$1</mark>'
                );
                State.searchMatches.push(p);
            }
        });

        const count = State.searchMatches.length;
        document.getElementById('searchCount').textContent = count ? `1/${count}` : 'No results';

        if (count) Chat.scrollToMatch(0);
    },

    scrollToMatch(idx) {
        const match = State.searchMatches[idx];
        if (!match) return;
        State.searchIdx = idx;
        match.scrollIntoView({ behavior: 'smooth', block: 'center' });
        document.getElementById('searchCount').textContent = `${idx + 1}/${State.searchMatches.length}`;
    },

    /* ── Utility formatters ── */
    formatDate(ts) {
        if (!ts) return 'Unknown date';
        const d   = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
        const now = new Date();
        const diff = now - d;
        if (diff < 86400000 && now.getDate() === d.getDate()) return 'Today';
        if (diff < 172800000) return 'Yesterday';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    },

    formatTime(ts) {
        if (!ts) return '';
        const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    },

    fmtSize(bytes) {
        if (bytes < 1024)         return bytes + ' B';
        if (bytes < 1024 * 1024)  return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
};

/* ════════════════════════════════════════════════════════════
   📤  SEND — compose and transmit messages
════════════════════════════════════════════════════════════ */
const Send = {

    /**
     * Send text message and any queued file attachments.
     */
    async send() {
        if (State.isSending) return;

        const input   = document.getElementById('msgInput');
        const text    = input.value.trim();
        const files   = [...State.pendingFiles];

        if (!text && !files.length) return;
        if (!State.customerPhone) { UI.toast('No customer phone number available.', 'error'); return; }

        State.isSending = true;
        UI.setSendingState(true);

        /* Optimistically add text message to UI */
        let optimisticId = null;
        if (text) {
            optimisticId = `_opt_${Date.now()}`;
            const optMsg = {
                id:        optimisticId,
                direction: 'Outbound',
                text,
                timestamp: Date.now(),
                status:    'pending',
                _sending:  true
            };
            State.messages.push(optMsg);
            Chat.appendMessage(optMsg);
            Chat.scrollToBottom();
        }

        /* Clear input immediately */
        input.value = '';
        UI.autoResizeTextarea(input);
        UI.clearAttachments();

        try {
            /* Send text */
            if (text) {
                const res = await ViberAPI.sendText(State.customerPhone, text);
                /* Replace optimistic message with confirmed */
                Send._confirmOptimistic(optimisticId, {
                    id:        res.message_id,
                    status:    res.status || 'sent',
                    timestamp: res.timestamp || Date.now()
                });

                /* Log CRM activity */
                ZohoCRM.logActivity({
                    direction:  'Outbound',
                    content:    text,
                    timestamp:  res.timestamp || Date.now(),
                    viber_id:   res.message_id
                });
            }

            /* Send each attachment sequentially */
            for (const file of files) {
                const fileMsg = {
                    id:        `_opt_file_${Date.now()}`,
                    direction: 'Outbound',
                    type:      file.type.startsWith('image/') ? 'image' : 'file',
                    file_name: file.name,
                    text:      null,
                    timestamp: Date.now(),
                    status:    'pending',
                    _sending:  true
                };
                State.messages.push(fileMsg);
                Chat.appendMessage(fileMsg);
                Chat.scrollToBottom();

                try {
                    const res = await ViberAPI.sendMedia(State.customerPhone, file);
                    Send._confirmOptimistic(fileMsg.id, {
                        id:        res.message_id,
                        status:    res.status || 'sent',
                        url:       res.url,
                        timestamp: res.timestamp || Date.now()
                    });
                    ZohoCRM.logActivity({
                        direction:  'Outbound',
                        content:    `[File: ${file.name}]`,
                        timestamp:  res.timestamp || Date.now(),
                        viber_id:   res.message_id
                    });
                } catch (fileErr) {
                    console.error('[Send] File send failed:', fileErr);
                    Send._markFailed(fileMsg.id);
                    UI.toast(`Failed to send ${file.name}.`, 'error');
                }
            }

        } catch (err) {
            console.error('[Send] Text send failed:', err);
            if (optimisticId) Send._markFailed(optimisticId);
            UI.toast('Message failed to send. Please try again.', 'error');
        } finally {
            State.isSending = false;
            UI.setSendingState(false);
        }
    },

    /**
     * Update optimistic message in state + DOM after server confirmation.
     */
    _confirmOptimistic(tempId, updates) {
        const msg = State.messages.find(m => m.id === tempId);
        if (msg) {
            Object.assign(msg, updates);
            msg._sending = false;
        }
        const row = document.querySelector(`.msg-row[data-id="${tempId}"]`);
        if (row) {
            row.dataset.id = updates.id;
            row.classList.remove('sending');
            const statusIcon = row.querySelector('.status-icon');
            if (statusIcon) statusIcon.innerHTML = Chat.statusIcon(updates.status);
        }
    },

    _markFailed(tempId) {
        const msg = State.messages.find(m => m.id === tempId);
        if (msg) { msg.status = 'failed'; msg._sending = false; }
        const row = document.querySelector(`.msg-row[data-id="${tempId}"]`);
        if (row) {
            row.classList.remove('sending');
            const statusIcon = row.querySelector('.status-icon');
            if (statusIcon) statusIcon.innerHTML = Chat.statusIcon('failed');
        }
    }
};

/* ════════════════════════════════════════════════════════════
   🎨  UI — state management, theme, toast, attachments
════════════════════════════════════════════════════════════ */
const UI = {

    /** Switch between loading / error / empty / chat views */
    showState(state, msg) {
        document.getElementById('stateLoading').style.display = 'none';
        document.getElementById('stateError').style.display   = 'none';
        document.getElementById('stateEmpty').style.display   = 'none';
        document.getElementById('messages').style.display     = 'flex';
        document.getElementById('loadMoreWrap').style.display = 'none';

        if (state === 'loading') {
            document.getElementById('stateLoading').style.display = '';
            document.getElementById('messages').style.display     = 'none';
        } else if (state === 'error') {
            document.getElementById('stateError').style.display   = '';
            document.getElementById('stateErrorMsg').textContent  = msg || 'An error occurred.';
            document.getElementById('messages').style.display     = 'none';
        } else if (state === 'empty') {
            document.getElementById('stateEmpty').style.display   = '';
            document.getElementById('messages').style.display     = 'none';
        }
        /* 'chat' → defaults above (all hidden, messages visible) */
    },

    setCustomerInfo(name, phone) {
        document.getElementById('headerName').textContent       = name || '—';
        document.getElementById('headerAvatarInitial').textContent = (name?.[0] || '?').toUpperCase();
        document.getElementById('headerPhoneText').textContent  = phone || 'No phone';
    },

    setUnread(count) {
        State.unread = count;
        const badge    = document.getElementById('unreadBadge');
        const fabBadge = document.getElementById('fabBadge');
        const fab      = document.getElementById('scrollFab');

        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = '';
            fabBadge.textContent = count > 99 ? '99+' : count;
            fabBadge.style.display = '';
            fab.style.display = '';
        } else {
            badge.style.display    = 'none';
            fabBadge.style.display = 'none';
        }
    },

    /** Toast notification — type: 'info' | 'success' | 'error' | 'warning' */
    toast(message, type = 'info', duration = 3000) {
        const wrap  = document.getElementById('toastWrap');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        wrap.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'toastOut 0.25s ease forwards';
            setTimeout(() => toast.remove(), 250);
        }, duration);
    },

    /** Enable / disable the composer while a message is sending */
    setSendingState(sending) {
        const btn   = document.getElementById('btnSend');
        const input = document.getElementById('msgInput');
        const att   = document.getElementById('btnAttach');
        btn.disabled   = sending;
        input.disabled = sending;
        att.disabled   = sending;
        if (sending) {
            btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/></svg>`;
            btn.style.animation = 'spin 0.7s linear infinite';
        } else {
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
            btn.style.animation = '';
            UI.updateSendBtn();
        }
    },

    updateSendBtn() {
        const input = document.getElementById('msgInput');
        const btn   = document.getElementById('btnSend');
        const hasText = input.value.trim().length > 0;
        const hasFiles = State.pendingFiles.length > 0;
        btn.disabled = !(hasText || hasFiles) || State.isSending;
    },

    /** Auto-grow textarea height */
    autoResizeTextarea(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    },

    /* ── Theme ── */
    applyTheme(theme) {
        State.theme = theme;
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('viberWidgetTheme', theme);
        const moon = document.querySelector('.icon-moon');
        const sun  = document.querySelector('.icon-sun');
        if (theme === 'dark') { moon.style.display = 'none'; sun.style.display = ''; }
        else                  { moon.style.display = '';     sun.style.display = 'none'; }
    },

    toggleTheme() {
        UI.applyTheme(State.theme === 'light' ? 'dark' : 'light');
    },

    /* ── Attachments ── */
    addFiles(fileList) {
        const files = Array.from(fileList);
        let rejected = 0;

        files.forEach(file => {
            if (file.size > CONFIG.MAX_FILE_BYTES) {
                const limitMB = CONFIG.MAX_FILE_BYTES / (1024 * 1024);
                UI.toast(`${file.name} exceeds ${limitMB} MB limit.`, 'warning');
                rejected++;
                return;
            }
            // File type check disabled when ALLOWED_TYPES is empty to allow all files
            if (CONFIG.ALLOWED_TYPES.length > 0 && !CONFIG.ALLOWED_TYPES.includes(file.type)) {
                UI.toast(`${file.name}: file type not supported.`, 'warning');
                rejected++;
                return;
            }
            State.pendingFiles.push(file);
        });

        UI.renderAttachments();
        UI.updateSendBtn();
    },

    renderAttachments() {
        const preview = document.getElementById('attachmentPreview');
        const list    = document.getElementById('attachmentList');

        if (!State.pendingFiles.length) {
            preview.style.display = 'none';
            return;
        }

        preview.style.display = 'flex';
        list.innerHTML = '';

        State.pendingFiles.forEach((file, idx) => {
            const thumb = document.createElement('div');
            thumb.className = 'att-thumb';

            if (file.type.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(file);
                img.onload = () => URL.revokeObjectURL(img.src);
                thumb.appendChild(img);
            } else {
                const lbl = document.createElement('div');
                lbl.className = 'att-thumb-label';
                lbl.textContent = file.name.split('.').pop().toUpperCase().slice(0, 4);
                thumb.appendChild(lbl);
            }

            const rm = document.createElement('button');
            rm.className = 'att-thumb-remove';
            rm.innerHTML = '×';
            rm.title = 'Remove';
            rm.addEventListener('click', () => {
                State.pendingFiles.splice(idx, 1);
                UI.renderAttachments();
                UI.updateSendBtn();
            });

            thumb.appendChild(rm);
            list.appendChild(thumb);
        });
    },

    clearAttachments() {
        State.pendingFiles = [];
        document.getElementById('attachmentPreview').style.display = 'none';
        document.getElementById('attachmentList').innerHTML = '';
        document.getElementById('fileInput').value = '';
    }
};

/* ════════════════════════════════════════════════════════════
   🎛️  EVENT WIRING
════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

    /* Apply saved theme */
    UI.applyTheme(State.theme);

    /* ── Send on button click ── */
    document.getElementById('btnSend').addEventListener('click', () => Send.send());

    /* ── Send on Enter (Shift+Enter = newline) ── */
    document.getElementById('msgInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            Send.send();
        }
    });

    /* ── Auto-resize textarea + send button state ── */
    document.getElementById('msgInput').addEventListener('input', (e) => {
        UI.autoResizeTextarea(e.target);
        UI.updateSendBtn();

        /* Character count */
        const len   = e.target.value.length;
        const max   = parseInt(e.target.maxLength);
        const count = document.getElementById('charCount');
        const warn  = Math.floor(max * CONFIG.CHAR_WARN_PCT);
        if (len >= warn) {
            count.style.display = '';
            count.textContent = `${len}/${max}`;
            count.className = `char-count ${len >= max * 0.95 ? 'danger' : 'warn'}`;
        } else {
            count.style.display = 'none';
        }
    });

    /* ── Attach button ── */
    document.getElementById('btnAttach').addEventListener('click', () => {
        document.getElementById('fileInput').click();
    });

    document.getElementById('fileInput').addEventListener('change', (e) => {
        UI.addFiles(e.target.files);
    });

    /* ── Drag-and-drop onto composer ── */
    const footer = document.getElementById('chatFooter');
    footer.addEventListener('dragover', (e) => { e.preventDefault(); footer.style.background = 'var(--viber-light)'; });
    footer.addEventListener('dragleave', ()  => { footer.style.background = ''; });
    footer.addEventListener('drop', (e) => {
        e.preventDefault();
        footer.style.background = '';
        UI.addFiles(e.dataTransfer.files);
    });

    /* ── Clear all attachments ── */
    document.getElementById('attClearAll').addEventListener('click', () => UI.clearAttachments());

    /* ── Paste image from clipboard ── */
    document.getElementById('msgInput').addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'));
        if (imageItems.length) {
            e.preventDefault();
            UI.addFiles(imageItems.map(i => i.getAsFile()));
        }
    });

    /* ── Theme toggle ── */
    document.getElementById('btnTheme').addEventListener('click', () => UI.toggleTheme());

    /* ── Refresh ── */
    document.getElementById('btnRefresh').addEventListener('click', async () => {
        document.getElementById('btnRefresh').style.animation = 'spin 0.7s linear infinite';
        Poller.stop();
        await Chat.init();
        document.getElementById('btnRefresh').style.animation = '';
    });

    /* ── Retry button ── */
    document.getElementById('btnRetry').addEventListener('click', () => Chat.init());

    /* ── Search toggle ── */
    document.getElementById('btnSearch').addEventListener('click', () => {
        const bar = document.getElementById('searchBar');
        State.searchActive = !State.searchActive;
        bar.style.display = State.searchActive ? 'flex' : 'none';
        document.getElementById('btnSearch').classList.toggle('active', State.searchActive);
        if (State.searchActive) document.getElementById('searchInput').focus();
        else Chat.search('');
    });

    document.getElementById('searchInput').addEventListener('input', (e) => {
        Chat.search(e.target.value);
    });

    document.getElementById('searchClear').addEventListener('click', () => {
        document.getElementById('searchInput').value = '';
        Chat.search('');
    });

    /* Cycle through matches on Enter in search */
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const matches = State.searchMatches;
            if (!matches.length) return;
            const next = (State.searchIdx + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
            Chat.scrollToMatch(next);
        }
    });

    /* ── Load more (scroll to top) ── */
    document.getElementById('btnLoadMore').addEventListener('click', () => Chat.loadMore());

    /* ── Scroll FAB ── */
    document.getElementById('scrollFab').addEventListener('click', () => {
        Chat.scrollToBottom();
        State.unread = 0;
        UI.setUnread(0);
        document.getElementById('scrollFab').style.display = 'none';
        ViberAPI.markRead(State.customerPhone, State.messages.filter(m => m.direction === 'Inbound').map(m => m.id));
    });

    /* ── Scroll events on chat body ── */
    const chatBody = document.getElementById('chatBody');
    chatBody.addEventListener('scroll', () => {
        const atBottom = Chat.isAtBottom();
        const fab = document.getElementById('scrollFab');

        /* Show/hide FAB */
        if (!atBottom && State.messages.length > 10) {
            fab.style.display = '';
        } else {
            fab.style.display = 'none';
            if (State.unread > 0) {
                State.unread = 0;
                UI.setUnread(0);
            }
        }

        /* Load more when scrolled to top */
        if (chatBody.scrollTop < 80 && State.hasMorePages && !State.isLoadingMore) {
            Chat.loadMore();
        }
    });

    /* ── Network reconnect on online event ── */
    window.addEventListener('online',  () => { UI.toast('Back online.', 'success'); Poller.restart(); });
    window.addEventListener('offline', () => { UI.toast('No network connection.', 'warning'); Poller.setStatus('error'); });

    /* ── Keyboard shortcut: Escape closes search ── */
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && State.searchActive) {
            document.getElementById('btnSearch').click();
        }
    });

    /* ── Init Zoho SDK ── */
    ZohoCRM.init();
});