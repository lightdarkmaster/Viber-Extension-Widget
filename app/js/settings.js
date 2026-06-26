// ─────────────────────────────────────────────────────────────────────────────
// Devtac Messaging – Settings page JS
// Platform: Zoho CRM Extension Settings page (not a widget sidebar/popup)
//
// KEY API FACTS (confirmed from Zoho SDK docs):
//   READ  org var  → ZOHO.CRM.API.getOrgVariable(apiname)
//                    response shape: { "Success": { "Content": "<value>" } }
//   WRITE org var  → ZOHO.CRM.CONNECTOR.invokeAPI("crm.set", { apiname, value })
//   WIDGET.store   → DOES NOT EXIST on settings pages – never use it here
// ─────────────────────────────────────────────────────────────────────────────

import { ORG_VARS } from "./config.js";

// License key format: DM- + 8 groups of 8 alphanumeric chars
// e.g. DM-OIP4U5A0-11E12RN8-ENI0Y28C-DQFN560Z-WCYEE2MY-SKDQDBO1-X6SBBUSF-76I5WACJ
const LICENSE_REGEX = /^DM(-[A-Z0-9]{8}){8}$/i;
const LICENSE_TOTAL_CHARS = 75; // "DM" + 8 dashes + 64 alphanum chars

let keyVisible = false;
let toastTimer = null;

/* ── Tab switching ── */
export function switchTab(id, btn) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    btn.classList.add('active');
}

/* ── License key visibility toggle ── */
export function toggleVis() {
    keyVisible = !keyVisible;
    document.getElementById('license-key').type = keyVisible ? 'text' : 'password';
    document.getElementById('eye-icon').innerHTML = keyVisible
        ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
}

/* ── License key live validation ── */
export function onKeyInput() {
    const v = document.getElementById('license-key').value.trim();
    if (!v) { document.getElementById('key-status').className = 'key-status'; return; }

    if (LICENSE_REGEX.test(v)) {
        showKeyStatus('valid', 'License key format is valid ✓');
    } else if (v.length < LICENSE_TOTAL_CHARS) {
        showKeyStatus('invalid', `Key is incomplete (${v.length}/${LICENSE_TOTAL_CHARS} chars)`);
    } else {
        showKeyStatus('invalid', 'Invalid format — expected DM-XXXXXXXX×8');
    }
}

function showKeyStatus(type, text) {
    const el = document.getElementById('key-status');
    el.className = `key-status ${type} show`;
    document.getElementById('key-status-text').textContent = text;
}

/* ── Parse getOrgVariable response ──────────────────────────────────────────
   Confirmed SDK docs response shape:
     Single var:  { "Success": { "Content": "value_string" } }
     Multi var:   { "Success": { "content": { "key": { "value": "..." } } } }
   Also handles legacy/undocumented shapes as fallbacks.
*/
function parseOrgVar(res, label) {
    console.log('[DevtacSettings] getOrgVariable(' + label + ') raw:', JSON.stringify(res));
    try {
        // ✅ Shape 1 – confirmed single-var response: { Success: { Content: "val" } }
        if (res && res.Success && res.Success.Content !== undefined) {
            return res.Success.Content;
        }
        // Shape 2 – multi-var response: { Success: { content: { key: { value: "val" } } } }
        if (res && res.Success && res.Success.content && typeof res.Success.content === 'object') {
            const keys = Object.keys(res.Success.content);
            if (keys.length === 1) {
                const first = res.Success.content[keys[0]];
                if (first && first.value !== undefined) return first.value;
            }
        }
        // Fallback shapes (older SDK versions)
        if (res && res.Content && res.Content.variable && res.Content.variable.value !== undefined) {
            return res.Content.variable.value;
        }
        if (res && res.Content !== undefined && typeof res.Content !== 'object') {
            return res.Content;
        }
        if (res && res.variable && res.variable.value !== undefined) {
            return res.variable.value;
        }
        if (res && res.value !== undefined) {
            return res.value;
        }
        console.warn('[DevtacSettings] Unrecognised shape for', label, res);
        return null;
    } catch (e) {
        console.error('[DevtacSettings] parseOrgVar error for', label, e);
        return null;
    }
}

/* ── Read an org variable (settings-page safe) ───────────────────────────── */
function getOrgVar(apiname) {
    return ZOHO.CRM.API.getOrgVariable(apiname)
        .then(function(res) {
            return parseOrgVar(res, apiname);
        });
}

/* ── Write an org variable (settings-page safe) ─────────────────────────────
   ZOHO.CRM.WIDGET.store does NOT exist on settings pages — crashes with
   "Cannot read properties of undefined (reading 'store')".
   ZOHO.CRM.CONNECTOR.invokeAPI("crm.set", { apiname, value }) is the correct
   alternative that works in both widget and settings page contexts.
*/
function setOrgVar(apiname, value) {
    return ZOHO.CRM.CONNECTOR.invokeAPI('crm.set', { apiname: apiname, value: value })
        .then(function(res) {
            console.log('[DevtacSettings] crm.set(' + apiname + ') response:', JSON.stringify(res));
            return res;
        });
}

/* ── Trial status renderer ── */
function renderTrialStatus(status) {
    console.log('[DevtacSettings] renderTrialStatus called with:', status);
    const wrap = document.getElementById('trial-status-wrap');
    const hint = document.getElementById('trial-hint');
    const s = (status || '').toLowerCase().trim();

    let cls, label, hintText;

    if (s === 'active') {
        cls = 'trial-tag active-trial';
        label = 'Trial Active';
        hintText = 'You are on a trial. Enter your license key to activate the full extension.';
    } else if (s === 'has_ended') {
        cls = 'trial-tag ended-trial';
        label = 'Trial Ended';
        hintText = 'Your trial has ended. Enter a valid license key to continue using Devtac Messaging.';
    } else {
        cls = 'trial-tag licensed';
        label = status || '—';
        hintText = '';
    }

    wrap.innerHTML = '<span class="' + cls + '"><span class="dot"></span>' + label + '</span>';
    hint.textContent = hintText;
}

/* ── Load all saved settings ── */
function loadSettings() {
    console.log('[DevtacSettings] loadSettings() called');

    // Viber License Key  (was: devtacmessaging__License_Key)
    getOrgVar(ORG_VARS.LICENSE_KEY)
        .then(function(licKey) {
            console.log('[DevtacSettings] LICENSE_KEY parsed value:', licKey);
            const el = document.getElementById('license-key');
            el.dataset.savedKey = licKey || '';
            if (licKey) {
                el.value = licKey;
                const valid = LICENSE_REGEX.test(licKey);
                showKeyStatus(
                    valid ? 'valid' : 'invalid',
                    valid ? 'License key saved ✓' : 'Saved key may be invalid — please verify'
                );
            }
        })
        .catch(function(e) {
            console.error('[DevtacSettings] LICENSE_KEY fetch error:', e);
        });

    // Messages Per Page
    getOrgVar(ORG_VARS.MESSAGES_PER_PAGE)
        .then(function(val) {
            console.log('[DevtacSettings] MESSAGES_PER_PAGE parsed value:', val);
            const perLoad = parseInt(val, 10);
            if (!isNaN(perLoad)) {
                document.getElementById('msg-per-load').value = Math.min(100, Math.max(5, perLoad));
            }
        })
        .catch(function(e) {
            console.error('[DevtacSettings] MESSAGES_PER_PAGE fetch error:', e);
        });

    // Viber Credit Balance
    getOrgVar(ORG_VARS.CREDIT_BALANCE)
        .then(function(val) {
            console.log('[DevtacSettings] CREDIT_BALANCE parsed value:', val);
            const num = parseFloat(val);
            document.getElementById('credit-val').textContent = isNaN(num) ? '—' : num.toLocaleString();
        })
        .catch(function(e) {
            console.error('[DevtacSettings] CREDIT_BALANCE fetch error:', e);
            document.getElementById('credit-val').textContent = '—';
        });

    // Viber Trial Status  (was: devtacmessaging__Trial_Status)
    getOrgVar(ORG_VARS.TRIAL_STATUS)
        .then(function(val) {
            console.log('[DevtacSettings] TRIAL_STATUS parsed value:', val);
            renderTrialStatus(val || '');
        })
        .catch(function(e) {
            console.error('[DevtacSettings] TRIAL_STATUS fetch error:', e);
            renderTrialStatus('');
        });

    // Viber Is Message Threshold Reached  (was: devtacmessaging__Is_Message_Threshold_Reached)
    getOrgVar(ORG_VARS.IS_THRESHOLD_REACHED)
        .then(function(val) {
            console.log('[DevtacSettings] IS_THRESHOLD_REACHED parsed value:', val);
            const v = (val || '').toString().toLowerCase().trim();
            if (v === 'true' || v === 'on') {
                document.getElementById('thresholdAlert').classList.add('show');
            }
        })
        .catch(function(e) {
            console.error('[DevtacSettings] IS_THRESHOLD_REACHED fetch error:', e);
        });

    // Enable Pop-up Reminder Notification
    getOrgVar(ORG_VARS.ENABLE_POPUP)
        .then(function(val) {
            console.log('[DevtacSettings] ENABLE_POPUP parsed value:', val);
            const v = (val || '').toString().toUpperCase().trim();
            setPopUpToggle(v === 'ON' || v === 'TRUE');
        })
        .catch(function(e) {
            console.error('[DevtacSettings] ENABLE_POPUP fetch error:', e);
        });

    // Pop-up Reminder Interval
    getOrgVar(ORG_VARS.POPUP_INTERVAL)
        .then(function(val) {
            console.log('[DevtacSettings] POPUP_INTERVAL parsed value:', val);
            const num = parseInt(val, 10);
            document.getElementById('popup-interval').value = isNaN(num) ? 0 : Math.max(0, num);
        })
        .catch(function(e) {
            console.error('[DevtacSettings] POPUP_INTERVAL fetch error:', e);
        });
}

/* ── Save settings ── */
export function saveSettings() {
    const btn       = document.getElementById('submitBtn');
    const keyEl     = document.getElementById('license-key');
    const key       = keyEl.value.trim();
    const savedKey  = keyEl.dataset.savedKey || '';
    const perLoad   = parseInt(document.getElementById('msg-per-load').value, 10);

    if (!key && savedKey) {
        showToast('⚠️', 'License key cannot be cleared. Please enter a valid key.', 'error');
        showKeyStatus('invalid', 'Key cannot be empty once set');
        keyEl.value = savedKey;
        return;
    }

    if (key && !LICENSE_REGEX.test(key)) {
        showToast('⚠️', 'License key format is invalid', 'error');
        showKeyStatus('invalid', 'Fix the key before saving');
        return;
    }

    if (isNaN(perLoad) || perLoad < 5 || perLoad > 100) {
        showToast('⚠️', 'Messages per load must be between 5 and 100', 'error');
        return;
    }

    const origHTML = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V7l-4-4zm-5 16a3 3 0 110-6 3 3 0 010 6zm3-10H5V5h10v4z"/></svg> Saving…';
    btn.disabled = true;

    const popUpEnabled  = document.getElementById('popup-toggle').getAttribute('aria-pressed') === 'true';
    const popUpInterval = parseInt(document.getElementById('popup-interval').value, 10);

    const saves = [
        setOrgVar(ORG_VARS.MESSAGES_PER_PAGE, String(perLoad)),
        setOrgVar(ORG_VARS.ENABLE_POPUP,       popUpEnabled ? 'ON' : 'OFF'),
        setOrgVar(ORG_VARS.POPUP_INTERVAL,     String(isNaN(popUpInterval) ? 0 : Math.max(0, popUpInterval))),
    ];
    if (key) {
        saves.push(setOrgVar(ORG_VARS.LICENSE_KEY, key));
    }

    console.log('[DevtacSettings] Saving via crm.set — perLoad:', perLoad, 'hasKey:', !!key);

    Promise.all(saves)
        .then(function(results) {
            console.log('[DevtacSettings] Save results:', JSON.stringify(results));
            if (key) showKeyStatus('valid', 'License key saved ✓');
            showToast('✓', 'Configuration saved successfully', 'success');
        })
        .catch(function(err) {
            console.error('[DevtacSettings] Save error:', err);
            showToast('✕', 'Save failed — please try again', 'error');
        })
        .finally(function() {
            btn.innerHTML = origHTML;
            btn.disabled = false;
        });
}

/* ── Refresh Viber balance ── */
export function refreshBalance() {
    const icon = document.getElementById('refresh-icon');
    icon.classList.add('spinning');

    getOrgVar(ORG_VARS.CREDIT_BALANCE)
        .then(function(val) {
            const num = parseFloat(val);
            document.getElementById('credit-val').textContent = isNaN(num) ? '—' : num.toLocaleString();
        })
        .catch(function(e) {
            console.error('[DevtacSettings] Refresh balance error:', e);
        })
        .finally(function() {
            icon.classList.remove('spinning');
        });
}

/* ── Pop-up Reminder toggle ── */
export function togglePopUp() {
    const btn           = document.getElementById('popup-toggle');
    const label         = document.getElementById('popup-toggle-label');
    const intervalGroup = document.getElementById('popup-interval-group');
    const isOn          = btn.getAttribute('aria-pressed') === 'true';

    btn.setAttribute('aria-pressed', String(!isOn));
    btn.classList.toggle('on', !isOn);
    label.textContent            = !isOn ? 'Enabled' : 'Disabled';
    intervalGroup.style.display  = !isOn ? 'block'   : 'none';
}

function setPopUpToggle(isOn) {
    const btn           = document.getElementById('popup-toggle');
    const label         = document.getElementById('popup-toggle-label');
    const intervalGroup = document.getElementById('popup-interval-group');

    btn.setAttribute('aria-pressed', String(isOn));
    btn.classList.toggle('on', isOn);
    label.textContent            = isOn ? 'Enabled'  : 'Disabled';
    intervalGroup.style.display  = isOn ? 'block'    : 'none';
}

function showToast(icon, msg, type) {
    type = type || 'success';
    document.getElementById('toast-icon').textContent = icon;
    document.getElementById('toast-msg').textContent  = msg;
    const t = document.getElementById('toast');
    t.className = 'toast ' + type + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2800);
}

/* ── Init ── */
ZOHO.embeddedApp.on('PageLoad', function() {
    console.log('[DevtacSettings] PageLoad fired');
    loadSettings();
});
ZOHO.embeddedApp.init();