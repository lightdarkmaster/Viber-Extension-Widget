import { state }                          from "./state.js";
import { filterPhoneFields, formatModuleLabel, extractLookupFields } from "./utils.js";
import {
    CONFIG,
    ENTITY,
    TEMPLATE_FIELDS,
    LOG_FIELDS,
    RELATED_LISTS,
    LOG_RELATED_FIELDS,
    ORG_VARS,
    MODULE_PHONE_VAR,
    FUNCTIONS,
    SEND_API_URL,
} from "./config.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_CHARS = 1000;

// ── Chat-widget state ─────────────────────────────────────────────────────────
const chat = {
    module:           "",
    recordId:         "",
    recordName:       "",
    record:           {},
    zapiKey:          "",
    phoneOptions:     [],
    activePhone:      null,
    selectedTpl:      null,
    messages:         [],
    templates:        [],
    historyPage:      0,
    historyBatchSize: 20,
    historyExhausted: false,
    allMessages:      [],
    seenIds:          new Set(),
    ViberCredits:       null,
    noPhoneMode:      false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $msg        = $("#msgInput");
const $chars      = $("#charCount");
const $sendBtn    = $("#sendBtn");
const $area       = $("#messagesArea");
const $emptyState = $("#emptyState");
const $emptyText  = $("#emptyText");
const $phoneLabel = $("#phoneFieldBadge");
const $overlay    = $("#phonePickerOverlay");
const $optsList   = $("#phoneOptionsList");
const $tplPanel   = $("#tplPanel");
const $tplList    = $("#tplList");
const $tplTrigger = $("#tplTriggerBtn");

// ── Template panel ────────────────────────────────────────────────────────────
$tplTrigger.on("click", (e) => {
    e.stopPropagation();
    const opening = !$tplPanel.hasClass("open");
    $tplPanel.toggleClass("open");
    $tplTrigger.toggleClass("active", $tplPanel.hasClass("open"));
    if (opening) setTimeout(() => $("#tplSearch").focus(), 50);
});

$("#tplPanelClose").on("click", closeTplPanel);

$(document).on("click", (e) => {
    if ($tplPanel.hasClass("open") &&
        !$tplPanel[0].contains(e.target) &&
        !$tplTrigger[0].contains(e.target)) {
        closeTplPanel();
    }
});

$("#tplSearch").on("input", function () {
    renderTemplateList($(this).val().trim());
});

$tplPanel.on("click", (e) => e.stopPropagation());

function closeTplPanel() {
    $tplPanel.removeClass("open");
    $tplTrigger.removeClass("active");
    $("#tplSearch").val("");
}

function renderTemplateList(query) {
    $tplList.empty();
    const q = (query || "").toLowerCase().trim();

    const filtered = q
        ? chat.templates.filter(t =>
            t.name.toLowerCase().includes(q) ||
            (t.body || "").toLowerCase().includes(q))
        : chat.templates;

    if (!filtered.length) {
        $tplList.html(`<div class="tpl-empty">${q ? "No templates match your search." : "No templates found for this module."}</div>`);
        return;
    }

    filtered.forEach((t) => {
        const isActive = chat.selectedTpl && chat.selectedTpl.id === t.id;
        const body     = t.body || "";
        const preview  = body.replace(/\n/g, " ").slice(0, 55) + (body.length > 55 ? "…" : "");

        const highlightedName    = q ? highlight(t.name, q)  : escapeHtml(t.name);
        const highlightedPreview = q ? highlight(preview, q) : escapeHtml(preview);

        const $item = $(`
            <div class="tpl-item ${isActive ? "active" : ""}" data-id="${t.id}">
                <div class="tpl-item-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                    </svg>
                </div>
                <div>
                    <div class="tpl-item-name">${highlightedName}</div>
                    ${preview ? `<div class="tpl-item-preview">${highlightedPreview}</div>` : ""}
                </div>
            </div>
        `);

        $item.on("click", () => { selectTemplate(t); closeTplPanel(); });
        $tplList.append($item);
    });
}

function highlight(str, query) {
    const safe = escapeHtml(str);
    if (!query) return safe;
    const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    return safe.replace(re, '<span class="tpl-highlight">$1</span>');
}

// ── Placeholder preview resolver ──────────────────────────────────────────────
// Best-effort client-side replacement of ${FieldApiName} tokens. Complex tokens
// (${Lookup.Field}, ${System.*}, ${Record_Id}) are left for the server.
function resolvePlaceholders(body) {
    if (!body || !body.includes("${")) return body;

    return body.replace(/\$\{([^}]+)\}/g, (match, token) => {
        const trimmed = token.trim();

        if (trimmed === "Record_Id")         return chat.recordId || match;
        if (trimmed.startsWith("System."))   return match;
        if (trimmed.includes("."))           return match;

        const val = chat.record[trimmed];
        if (val !== undefined && val !== null && val !== "") {
            if (typeof val === "object" && val.name) return val.name;
            return String(val);
        }
        return match;
    });
}

function selectTemplate(t) {
    chat.selectedTpl = t;
    $msg.val(resolvePlaceholders(t.body || "")).prop("disabled", false);
    $tplTrigger.addClass("has-tpl");
    updateCharCount();
    updateSendBtn();
    renderTemplateList();
}

function clearTemplate() {
    chat.selectedTpl = null;
    $tplTrigger.removeClass("has-tpl");
    $msg.val("").prop("disabled", chat.activePhone === null);
    updateCharCount();
    updateSendBtn();
    renderTemplateList();
}

// ── Textarea ──────────────────────────────────────────────────────────────────
$msg.on("input", () => {
    // If the user has edited the content away from the selected template, deselect it
    // so the template_id is not sent with a custom/modified message.
    if (chat.selectedTpl) {
        const resolved = resolvePlaceholders(chat.selectedTpl.body || "");
        if (($msg.val() || "") !== resolved) {
            chat.selectedTpl = null;
            $tplTrigger.removeClass("has-tpl");
            renderTemplateList();
        }
    }
    updateCharCount();
    updateSendBtn();
});

$msg.on("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!$sendBtn.prop("disabled")) sendMessage();
    }
});

function updateCharCount() {
    const len = ($msg.val() || "").length;
    $chars.text(`${len}/${MAX_CHARS}`);
    $chars.removeClass("warn over")
        .addClass(len > MAX_CHARS ? "over" : len > 900 ? "warn" : "");
}

function updateSendBtn() {
    const len       = ($msg.val() || "").trim().length;
    const over      = ($msg.val() || "").length > MAX_CHARS;
    const hasNumber = !!(chat.activePhone && chat.activePhone.resolvedNumber);
    $sendBtn.prop("disabled", !len || over || !chat.activePhone || !hasNumber);
}

// ── Phone picker ──────────────────────────────────────────────────────────────
$("#phonePickBtn, #phoneFieldBadge").on("click", () => $overlay.addClass("open"));
$("#sheetCloseBtn").on("click", () => $overlay.removeClass("open"));
$overlay.on("click", (e) => { if (e.target === $overlay[0]) $overlay.removeClass("open"); });

function renderPhoneOptions() {
    $optsList.empty();
    if (!chat.phoneOptions.length) {
        $optsList.html('<p style="font-size:11.5px;color:var(--muted-lt);padding:8px 0;">No phone fields found on this module.</p>');
        return;
    }

    chat.phoneOptions.forEach((opt, i) => {
        const isActive = chat.activePhone &&
            chat.activePhone.fieldApiName === opt.fieldApiName &&
            chat.activePhone.lookupField  === opt.lookupField;

        const $row = $(`
            <div class="phone-option ${isActive ? "active" : ""}" data-idx="${i}">
                <div>
                    <div class="phone-option-label">${escapeHtml(opt.label)}</div>
                    ${opt.source === "contact_lookup"
            ? `<div style="font-size:9.5px;color:var(--muted-lt);">via ${escapeHtml(opt.lookupLabel)}</div>`
            : ""}
                </div>
                <div class="phone-option-val">${escapeHtml(opt.resolvedNumber || "—")}</div>
            </div>
        `);

        $row.on("click", () => { setActivePhone(opt); $overlay.removeClass("open"); });
        $optsList.append($row);
    });
}

function setActivePhone(opt) {
    const prevCore      = chat.activePhone ? normalizePhone(chat.activePhone.resolvedNumber) : null;
    const prevField     = chat.activePhone ? chat.activePhone.fieldApiName : null;
    // Reload if the number changed OR if the field itself changed (handles empty-field switches
    // where both numbers are blank but each field has its own failed message history).
    const numberChanged = prevCore !== null && prevCore !== normalizePhone(opt.resolvedNumber);
    const fieldChanged  = prevField !== null && prevField !== opt.fieldApiName;
    const shouldReload  = numberChanged || fieldChanged;

    chat.activePhone = opt;
    $phoneLabel.text(opt.label);
    $("#recipientNumber").text(opt.resolvedNumber || "—");
    $msg.prop("disabled", !opt.resolvedNumber);
    updateSendBtn();

    if (!opt.resolvedNumber) {
        chat.noPhoneMode = true;
        stopPolling();
        $area.children(":not(#historyHeader):not(#emptyState)").remove();
        $historyHeader.hide().empty();
        $emptyState.show();
        $emptyText.html(
            "No phone number found on the <strong>" + escapeHtml(opt.label) + "</strong> field.<br>" +
            "Please add a phone number to this record, then refresh."
        );
    } else {
        chat.noPhoneMode = false;
        if ($area.children(".bubble-row").length) $emptyState.hide();
    }

    if (opt.fieldApiName) {
        ZOHO.CRM.FUNCTIONS.execute(FUNCTIONS.SET_PHONE_FIELD, {
            apiname: MODULE_PHONE_VAR[chat.module],
            value:   opt.fieldApiName,
        }, { headers: { "Content-Type": "application/json" } }).catch(() => {});
    }

    renderPhoneOptions();

    if (shouldReload && chat.module && chat.recordId && !chat.noPhoneMode) {
        chat.allMessages      = [];
        chat.historyPage      = 0;
        chat.historyExhausted = false;
        chat.seenIds.clear();
        loadMessageHistory(chat.module, chat.recordId, 1);
    }
}

// ── Templates ─────────────────────────────────────────────────────────────────
function loadTemplates(module) {
    $tplList.html('<div class="tpl-empty">Loading templates…</div>');
    chat.templates = [];

    ZOHO.CRM.API.searchRecord({
        Entity: ENTITY.TEMPLATES,
        Type:   "criteria",
        Query:  `(${TEMPLATE_FIELDS.MODULE}:equals:${module})`,
    })
        .then((resp) => {
            const records = (resp && resp.data) || [];
            chat.templates = records.map((t) => ({
                id:   t.id,
                name: t.Name || t.name || t.id,
                body: t[TEMPLATE_FIELDS.MESSAGE_CONTENT] || "",
            }));
            renderTemplateList();
        })
        .catch(() => {
            $tplList.html('<div class="tpl-empty">Error loading templates.</div>');
        });
}

// ── Phone field org variable map ──────────────────────────────────────────────
// Imported from config.js — see MODULE_PHONE_VAR there.

// ── Phone fields + resolve numbers ───────────────────────────────────────────
function loadPhoneFieldsAndRecord(module, fields, record, savedPhoneField) {
    const ownPhoneFields = filterPhoneFields(fields);
    const contactLookups = extractContactLookups(fields);
    const options        = [];

    ownPhoneFields.forEach((f) => {
        options.push({
            source:         "own",
            fieldApiName:   f.api_name,
            label:          f.field_label || f.api_name,
            lookupField:    null,
            lookupLabel:    null,
            resolvedNumber: record[f.api_name] || null,
        });
    });

    function afterOptions() {
        chat.phoneOptions = options;

        let chosen = null;

        if (savedPhoneField) {
            chosen = options.find((o) => o.source === "own" && o.fieldApiName === savedPhoneField) || null;
        }

        if (!chosen) {
            chosen = options.find((o) => o.resolvedNumber) || options[0] || null;

            if (chosen && chosen.source === "own") {
                const phoneVar = MODULE_PHONE_VAR[module];
                if (phoneVar && chat.zapiKey) {
                    ZOHO.CRM.HTTP.patch({
                        url:     "https://www.zohoapis.com/crm/v7/org/variables" +
                            "?auth_type=apikey&zapikey=" + encodeURIComponent(chat.zapiKey),
                        headers: { "Content-Type": "application/json" },
                        body:    { variables: [{ apiname: phoneVar, value: chosen.fieldApiName }] },
                    }).catch(() => {});
                }
            }
        }

        if (chosen) setActivePhone(chosen);

        renderPhoneOptions();
        updateSendBtn();

        if (!options.length) {
            $emptyText.text("No phone fields found on this record.\nPlease use the phone picker to add one.");
        }

        if (!chat.noPhoneMode) {
            loadMessageHistory(chat.module, chat.recordId, 1);
            startPolling();
        }
    }

    if (contactLookups.length > 0) {
        Promise.all(contactLookups.map((lookup) => {
            const rawVal   = record[lookup.api_name];
            const lookupId = (rawVal && typeof rawVal === "object" ? rawVal.id : rawVal) || null;
            if (!lookupId) return Promise.resolve([]);

            return ZOHO.CRM.API.getRecord({ Entity: "Contacts", RecordID: lookupId })
                .then((cr) => {
                    const cRec = (cr && cr.data && cr.data[0]) || {};
                    return ZOHO.CRM.META.getFields({ Entity: "Contacts" })
                        .then((meta) =>
                            filterPhoneFields((meta && meta.fields) || []).map((cf) => ({
                                source:         "contact_lookup",
                                fieldApiName:   cf.api_name,
                                label:          cf.field_label || cf.api_name,
                                lookupField:    lookup.api_name,
                                lookupLabel:    lookup.field_label || lookup.api_name,
                                resolvedNumber: cRec[cf.api_name] || null,
                            }))
                        );
                })
                .catch(() => []);
        })).then((results) => {
            results.forEach((r) => options.push(...r));
            afterOptions();
        });
    } else {
        afterOptions();
    }
}

function extractContactLookups(fields) {
    return fields.filter((f) => {
        const dtype     = (f.data_type || "").toLowerCase();
        const apiName   = (f.api_name  || "").toLowerCase();

        if (apiName === "contact_name") return true;

        const refModule = (
            (f.lookup && f.lookup.module && (f.lookup.module.api_name || f.lookup.module)) ||
            (f.refers_to && (f.refers_to.api_name || f.refers_to)) || ""
        ).toString().toLowerCase();

        return (dtype === "lookup" || dtype === "relate") && refModule === "contacts";
    });
}

// ── Recipient display ─────────────────────────────────────────────────────────
function setRecipient(name, module) {
    chat.recordName = name;
    const initials  = name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join("");

    $("#recipientAvatar").text(initials || "??");
    $("#recipientName").text(name || formatModuleLabel(module) + " Record");
}

// ── Bubble rendering ──────────────────────────────────────────────────────────
function getNow() {
    return new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true });
}

let _bubbleId = 0;

function buildBubbleHtml({ dir, text, time, statusClass, retryParams, logId }) {
    const id       = "bubble-" + (++_bubbleId);
    const initials = dir === "out" ? "ME" : ($("#recipientAvatar").text() || "??");
    const showRetry  = !!(dir === "out" && retryParams);
    const statusHtml = dir === "out" ? buildStatusHtml(statusClass || "sending", showRetry) : "";

    const retryAttr = showRetry
        ? ` data-retry-params='${JSON.stringify(retryParams).replace(/'/g, "&#39;")}'`
        : "";
    const logAttr = (dir === "out" && logId)
        ? ` data-log-id="${logId}"`
        : "";

    return `
        <div class="bubble-row ${dir}" id="${id}"${retryAttr}${logAttr}>
            <div class="bubble-avatar ${dir}">${initials}</div>
            <div class="bubble-wrap">
                <div class="bubble-sender">${dir === "out" ? "You" : escapeHtml(chat.recordName)}</div>
                <div class="bubble ${dir}">${escapeHtml(text)}</div>
                <div class="bubble-meta">
                    <span class="bubble-time">${time}</span>
                    ${statusHtml}
                </div>
            </div>
        </div>`;
}

function appendBubble({ dir, text, time, statusClass }) {
    $emptyState.hide();
    const html = buildBubbleHtml({ dir, text, time, statusClass });
    $area.append(html);
    $area[0].scrollTop = $area[0].scrollHeight;
    return $area.children(".bubble-row").last().attr("id");
}

function buildStatusHtml(statusClass, showRetry = false) {
    const icons = {
        sending:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/></svg>`,
        sent:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
        delivered: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M2 13l4 4L16 7M8 13l4 4L22 7"/></svg>`,
        failed:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
    };
    const labels = { sending: "Sending", sent: "Sent", delivered: "", failed: "Failed" };

    let retryBtn = "";
    if (statusClass === "failed" && showRetry) {
        retryBtn = `<button class="retry-btn" title="Retry sending">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                   <path stroke-linecap="round" stroke-linejoin="round"
                         d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/>
               </svg>
           </button>`;
    }

    return `<span class="status-icon ${statusClass}">
                ${icons[statusClass] || icons.sent}
                <span class="status-label">${labels[statusClass] || ""}</span>
            </span>${retryBtn}`;
}

function updateBubbleStatus(bubbleId, statusClass, logId) {
    const $bubble = $("#" + bubbleId);
    if (!$bubble.length) return;
    const showRetry = statusClass === "failed" && !!$bubble.attr("data-retry-params");
    $bubble.find(".status-icon, .retry-btn").remove();
    $bubble.find(".bubble-meta").append(buildStatusHtml(statusClass, showRetry));
    if (logId) $bubble.attr("data-log-id", logId);
}

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
}

// ── Phone normalisation ───────────────────────────────────────────────────────
// Strips non-digits then removes leading country/trunk code so that
// 09123456789, +639123456789, and 9123456789 all reduce to "9123456789".
function normalizePhone(raw) {
    if (!raw) return "";
    let digits = String(raw).replace(/\D/g, "");
    if (digits.length > 10 && digits.startsWith("0")) {
        digits = digits.slice(1);
    } else if (digits.length > 10) {
        const stripped2 = digits.slice(2);
        const stripped3 = digits.slice(3);
        if      (stripped3.length === 10) digits = stripped3;
        else if (stripped2.length === 10) digits = stripped2;
    }
    return digits;
}

function getLogPhone(log) {
    return log[LOG_FIELDS.TO_NUMBER]
        || log[LOG_FIELDS.FROM_NUMBER]
        || log[LOG_FIELDS.PHONE_NUMBER]
        || log[LOG_FIELDS.RECIPIENT]
        || log[LOG_FIELDS.RECIPIENT_NUMBER]
        || "";
}

function filterLogsByPhone(logs, activePhone) {
    if (!activePhone || !activePhone.resolvedNumber) return logs;
    const targetCore = normalizePhone(activePhone.resolvedNumber);
    if (!targetCore) return logs;

    const matched    = logs.filter((log) => {
        const logPhone = getLogPhone(log);
        if (!logPhone) return true;
        return normalizePhone(logPhone) === targetCore;
    });

    const anyHasPhone = logs.some((log) => !!getLogPhone(log));
    return anyHasPhone ? matched : logs;
}

// ── PH timestamp helpers ──────────────────────────────────────────────────────
function getPHTimestamp(format = "iso") {
    const now  = new Date();
    const d    = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const pad  = n => String(n).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const MM   = pad(d.getUTCMonth() + 1);
    const dd   = pad(d.getUTCDate());
    const HH   = pad(d.getUTCHours());
    const mm   = pad(d.getUTCMinutes());
    const ss   = pad(d.getUTCSeconds());
    return format === "name"
        ? `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`
        : `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}+08:00`;
}

// ── History helpers ───────────────────────────────────────────────────────────
function clampBatchSize(n) {
    const v = parseInt(n, 10);
    if (isNaN(v) || v < 20) return 20;
    if (v > 100)            return 100;
    return v;
}

const $historyHeader = $("#historyHeader");

function showHistoryLoading() {
    $historyHeader.show().html(`
        <div class="history-loading">
            <span class="history-loading-dot"></span>
            <span class="history-loading-dot"></span>
            <span class="history-loading-dot"></span>
        </div>`);
}

function renderHistoryHeader() {
    if (chat.historyExhausted) {
        $historyHeader.show().html('<span class="history-exhausted">✓ All messages loaded</span>');
        return;
    }
    if (chat.historyPage > 0) {
        $historyHeader.show().html('<button id="loadMoreBtn" class="load-more-btn">Load older messages</button>');
        $("#loadMoreBtn").on("click", () => {
            $("#loadMoreBtn").prop("disabled", true).text("Loading…");
            showHistoryLoading();
            loadMessageHistory(chat.module, chat.recordId, chat.historyPage + 1);
        });
    } else {
        $historyHeader.hide().empty();
    }
}

// ── Load message history ──────────────────────────────────────────────────────
// page 1  = fresh load / refresh  → fetch all, show newest slice, scroll to bottom
// page 2+ = "load older"          → slice from allMessages, prepend
function loadMessageHistory(module, recordId, page = 1) {
    const mod = (module || "").toLowerCase();

    // RELATED_LISTS keys are PascalCase (Leads/Deals/Contacts); lower-case for lookup
    const relatedListMap = Object.fromEntries(
        Object.entries(RELATED_LISTS).map(([k, v]) => [k.toLowerCase(), v])
    );

    const relatedList = relatedListMap[mod];
    if (!relatedList) return;

    if (page === 1) {
        $area.children(":not(#historyHeader):not(#emptyState)").remove();
        $emptyState.show();
        chat.historyPage      = 0;
        chat.historyExhausted = false;
        chat.allMessages      = [];
        showHistoryLoading();

        // Always call fetchLogsByPhone when there is an active phone field — even if
        // resolvedNumber is empty — so the field-based query for no-number failed logs runs.
        const phoneSearchPromise = chat.activePhone
            ? fetchLogsByPhone(chat.activePhone.resolvedNumber).catch(() => [])
            : Promise.resolve([]);

        phoneSearchPromise
            .then((logs) => {
                // Allow logs through if they have a phone number on either side,
                // OR if they are a failed send tied to the active phone field
                // (no-number failed sends stored via Selected_Phone_Field).
                const activeField = chat.activePhone ? chat.activePhone.fieldApiName : null;
                const filtered = logs.filter((log) => {
                    const hasRecipient = !!(log[LOG_FIELDS.RECIPIENT_NUMBER] || "").toString().trim();
                    const hasSender    = !!(log[LOG_FIELDS.SENDER_NUMBER]    || "").toString().trim();
                    if (hasRecipient || hasSender) return true;
                    // No phone on either side — only show if tied to the active field
                    const logField = (log[LOG_FIELDS.SELECTED_PHONE_FIELD] || "").toString().trim();
                    return !!(activeField && logField && logField === activeField);
                });

                if (!filtered.length) { $historyHeader.hide().empty(); return; }

                filtered.sort((a, b) =>
                    new Date(a.Created_Time || a[LOG_FIELDS.MESSAGE_TIMESTAMP] || 0).getTime() -
                    new Date(b.Created_Time || b[LOG_FIELDS.MESSAGE_TIMESTAMP] || 0).getTime()
                );

                chat.allMessages = filtered;
                filtered.forEach((log) => { if (log.id) chat.seenIds.add(log.id); });
                renderPage(1);
            })
            .catch((err) => {
                renderHistoryHeader();
                console.warn("[DevtacMessaging] Could not load message history.", err);
            });
    } else {
        renderPage(page);
    }
}

// Recursively fetches all Zoho related-list pages (200 per request).
function fetchAllRelatedRecords(module, relatedList, accumulated, page) {
    return ZOHO.CRM.API.getRelatedRecords({
        Entity:      module,
        RecordID:    chat.recordId,
        RelatedList: relatedList,
        page,
        per_page:    200,
    }).then((resp) => {
        const logs     = (resp && resp.data) || [];
        const combined = accumulated.concat(logs);
        return logs.length === 200
            ? fetchAllRelatedRecords(module, relatedList, combined, page + 1)
            : combined;
    });
}

// Searches message logs by phone number in all common PH formats in parallel.
// Also fetches no-number failed logs whose Selected_Phone_Field matches the active field,
// so that failed sends on empty phone fields appear in the correct field's history.
function fetchLogsByPhone(rawNumber) {
    const activeFieldApiName = chat.activePhone ? chat.activePhone.fieldApiName : null;

    const phoneQueries = [];

    if (rawNumber) {
        const core = normalizePhone(rawNumber);
        if (core) {
            const candidates = core.length === 10
                ? ["+63" + core, "0" + core, "63" + core, core, rawNumber]
                : [rawNumber];
            const unique = [...new Set(candidates.filter(Boolean))];

            unique.forEach((num) => {
                phoneQueries.push(
                    ZOHO.CRM.API.searchRecord({
                        Entity: ENTITY.LOGS,
                        Type:   "criteria",
                        Query:  `(${LOG_FIELDS.RECIPIENT_NUMBER}:equals:${num})`,
                    }).then((r) => (r && r.data) || []).catch(() => []),
                    ZOHO.CRM.API.searchRecord({
                        Entity: ENTITY.LOGS,
                        Type:   "criteria",
                        Query:  `(${LOG_FIELDS.SENDER_NUMBER}:equals:${num})`,
                    }).then((r) => (r && r.data) || []).catch(() => [])
                );
            });
        }
    }

    const fieldQuery = activeFieldApiName
        ? ZOHO.CRM.API.searchRecord({
            Entity: ENTITY.LOGS,
            Type:   "criteria",
            Query:  `(${LOG_FIELDS.SELECTED_PHONE_FIELD}:equals:${activeFieldApiName})AND(${LOG_FIELDS.STATUS}:equals:Failed)`,
        }).then((r) => (r && r.data) || []).catch(() => [])
        : Promise.resolve([]);

    if (!phoneQueries.length && !activeFieldApiName) return Promise.resolve([]);

    return Promise.all([...phoneQueries, fieldQuery]).then((results) => {
        const seen = new Set();
        const out  = [];
        for (const logs of results) {
            for (const log of logs) {
                if (!log.id || seen.has(log.id)) continue;
                seen.add(log.id);
                out.push(log);
            }
        }
        return out;
    });
}

// Reconstructs the minimum params needed to retry a historically-loaded failed message.
// template_id and lookup_fields are intentionally omitted — the resolved message content
// stored on the log is used as free-text, which produces the same result for the recipient.
function buildRetryParams(log) {
    // Prefer the field stored on the log itself (Selected_Phone_Field) so that a
    // no-phone failed log retried from history targets the correct field.
    const logField      = (log[LOG_FIELDS.SELECTED_PHONE_FIELD] || "").toString().trim();
    const fieldApiName  = logField || (chat.activePhone ? chat.activePhone.fieldApiName : "");
    const fieldLabel    = chat.activePhone && chat.activePhone.fieldApiName === fieldApiName
        ? chat.activePhone.label : fieldApiName;
    return {
        record_id:             chat.recordId,
        template_id:           "",
        message:               log[LOG_FIELDS.MESSAGE_CONTENT] || "",
        channel:               CONFIG.CHANNEL,
        selected_module:       chat.module,
        selected_module_label: chat.module,
        phone_source:          chat.activePhone ? chat.activePhone.source        : "own",
        selected_field:        fieldApiName,
        selected_field_label:  fieldLabel,
        lookup_field:          chat.activePhone ? (chat.activePhone.lookupField  || "") : "",
        lookup_field_label:    chat.activePhone ? (chat.activePhone.lookupLabel  || "") : "",
        lookup_fields:         "",
    };
}

function renderPage(page) {
    const batchSize  = chat.historyBatchSize;
    const all        = chat.allMessages;
    const total      = all.length;
    const totalPages = Math.ceil(total / batchSize);
    const sliceEnd   = total - (page - 1) * batchSize;
    const sliceStart = Math.max(0, sliceEnd - batchSize);
    const slice      = all.slice(sliceStart, sliceEnd);

    if (!chat.noPhoneMode) $emptyState.hide();

    const batchHtml = slice.map((log) => {
        chat.seenIds.add(log.id);
        console.log("[DevtacMessaging] renderPage log:", log.id, log);
        const dir         = (log[LOG_FIELDS.DIRECTION] || "").toLowerCase() === "inbound" ? "in" : "out";
        const status      = (log[LOG_FIELDS.STATUS]    || "").toLowerCase() === "failed"  ? "failed" : "sent";
        const ts          = log.Created_Time || log[LOG_FIELDS.MESSAGE_TIMESTAMP];
        const time        = ts
            ? new Date(ts).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true })
            : "—";
        const recipientNum = (log[LOG_FIELDS.RECIPIENT_NUMBER] || "").toString().trim();
        const retryParams  = (dir === "out" && status === "failed") ? buildRetryParams(log) : null;
        return buildBubbleHtml({ dir, text: log[LOG_FIELDS.MESSAGE_CONTENT] || "", time, statusClass: dir === "out" ? status : null, retryParams, logId: log.id });
    }).join("");

    chat.historyPage      = page;
    chat.historyExhausted = page >= totalPages;

    if (page === 1) {
        $area.append(batchHtml);
        renderHistoryHeader();
        setTimeout(() => {
            $area[0].scrollTop = $area[0].scrollHeight;
        }, 100);
    } else {
        const prevScrollTop    = $area[0].scrollTop;
        const prevScrollHeight = $area[0].scrollHeight;
        $historyHeader.after(batchHtml);
        renderHistoryHeader();
        setTimeout(() => {
            const addedHeight = $area[0].scrollHeight - prevScrollHeight;
            $area[0].scrollTop = prevScrollTop + addedHeight;
        }, 100);
    }
}

function buildRelatedField(module, recordId) {
    const mod = (module || "").toLowerCase();
    const key = Object.keys(LOG_RELATED_FIELDS).find(k => k.toLowerCase() === mod);
    if (key) return { [LOG_RELATED_FIELDS[key]]: { id: recordId } };
    return {};
}

// ── Send ──────────────────────────────────────────────────────────────────────
function sendMessage() {
    const text = ($msg.val() || "").trim();
    if (!text || !chat.activePhone) return;

    const tplId          = chat.selectedTpl ? chat.selectedTpl.id : null;
    const lookupFieldsStr = (state.lookupFields || [])
        .map(f => f.fieldApiName + "|" + f.relatedModule)
        .join(",");

    const params = {
        record_id:             chat.recordId,
        template_id:           tplId || "",
        message:               text,
        channel:               CONFIG.CHANNEL,
        selected_module:       chat.module,
        selected_module_label: chat.module,
        phone_source:          chat.activePhone.source,
        selected_field:        chat.activePhone.fieldApiName,
        selected_field_label:  chat.activePhone.label,
        lookup_field:          chat.activePhone.lookupField  || "",
        lookup_field_label:    chat.activePhone.lookupLabel  || "",
        lookup_fields:         lookupFieldsStr,
    };

    const time     = getNow();
    const bubbleId = appendBubble({ dir: "out", text, time, statusClass: "sending", retryParams: params });

    $sendBtn.prop("disabled", true);
    $msg.val("");
    clearTemplate();
    updateCharCount();

    executeSend({ params, bubbleId });
}

function executeSend({ params, bubbleId, existingLogId }) {
    const body = existingLogId
        ? { ...params, existing_log_id: existingLogId }
        : { ...params };

    ZOHO.CRM.HTTP.post({
        url:     SEND_API_URL(chat.zapiKey),
        headers: { "Content-Type": "application/json" },
        body,
    })
        .then((res) => {
            const data      = typeof res === "string" ? JSON.parse(res) : (res?.data ? (typeof res.data === "string" ? JSON.parse(res.data) : res.data) : res);
            const rawResult = data?.details?.output;
            const result    = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
            const success   = result?.success === true || result?.success === "true";

            const logId = result?.log_id || null;
            if (logId) chat.seenIds.add(logId);

            if (result?.new_balance !== undefined && result?.new_balance !== null) {
                chat.ViberCredits = result.new_balance;
                renderViberCredits();
            }

            // Store retry params on bubble only while it's failed so retry works
            const $bubble = $("#" + bubbleId);
            if (!success && params) {
                $bubble.attr("data-retry-params", JSON.stringify(params));
            } else {
                $bubble.removeAttr("data-retry-params");
            }

            updateBubbleStatus(bubbleId, success ? "sent" : "failed", logId);
        })
        .catch(() => {
            const $bubble = $("#" + bubbleId);
            if (params) $bubble.attr("data-retry-params", JSON.stringify(params));
            updateBubbleStatus(bubbleId, "failed");
        })
        .finally(() => updateSendBtn());
}

// ── Retry handler (delegated) ─────────────────────────────────────────────────
$area.on("click", ".retry-btn", function () {
    const $row     = $(this).closest(".bubble-row");
    const bubbleId  = $row.attr("id");
    const logId     = $row.attr("data-log-id") || null;
    const rawParams = $row.attr("data-retry-params");
    if (!rawParams) return;

    let params;
    try { params = JSON.parse(rawParams); } catch (e) { return; }

    // Update params to use the current active phone at retry time
    params.phone_source         = chat.activePhone.source;
    params.selected_field       = chat.activePhone.fieldApiName;
    params.selected_field_label = chat.activePhone.label;
    params.lookup_field         = chat.activePhone.lookupField  || "";
    params.lookup_field_label   = chat.activePhone.lookupLabel  || "";

    updateBubbleStatus(bubbleId, "sending");
    $row.removeAttr("data-retry-params");

    executeSend({ params, bubbleId, existingLogId: logId });
});

$sendBtn.on("click", sendMessage);

// ── Refresh ───────────────────────────────────────────────────────────────────
$("#refreshBtn").on("click", () => {
    if (!chat.module || !chat.recordId) return;
    const $btn = $("#refreshBtn");
    $btn.addClass("spinning").prop("disabled", true);
    loadMessageHistory(chat.module, chat.recordId, 1);
    setTimeout(() => $btn.removeClass("spinning").prop("disabled", false), 1200);
});

// ── Silent polling ────────────────────────────────────────────────────────────
const POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes

let _pollTimer   = null;
let _pollPending = false;
let _pageVisible = true;

function pollNewMessages() {
    if (_pollPending || !chat.module || !chat.recordId || !_pageVisible) return;

    const relatedListMap = Object.fromEntries(
        Object.entries(RELATED_LISTS).map(([k, v]) => [k.toLowerCase(), v])
    );

    const relatedList = relatedListMap[chat.module.toLowerCase()];
    if (!relatedList) return;

    _pollPending = true;

    // When the active phone field has no number, skip the broad related-list query —
    // it would return all messages for the record (including those from other fields).
    // Only the field-targeted fetchLogsByPhone query is relevant in that case.
    const hasActiveNumber = !!(chat.activePhone && chat.activePhone.resolvedNumber);

    const pollOwn = hasActiveNumber
        ? ZOHO.CRM.API.getRelatedRecords({
            Entity:      chat.module,
            RecordID:    chat.recordId,
            RelatedList: relatedList,
            page:        1,
            per_page:    chat.historyBatchSize,
        }).then((resp) => (resp && resp.data) || []).catch(() => [])
        : Promise.resolve([]);

    // Always call fetchLogsByPhone when there is an active phone field — even if
    // resolvedNumber is empty — so the field-based query for no-number failed logs runs.
    const pollPhone = chat.activePhone
        ? fetchLogsByPhone(chat.activePhone.resolvedNumber).catch(() => [])
        : Promise.resolve([]);

    Promise.all([pollOwn, pollPhone])
        .then(([ownLogs, phoneLogs]) => {
            const seenMerge = new Set();
            const logs = [];
            for (const log of [...ownLogs, ...phoneLogs]) {
                if (log.id && !seenMerge.has(log.id)) { seenMerge.add(log.id); logs.push(log); }
            }

            const newLogs = logs
                .filter((log) => log.id && !chat.seenIds.has(log.id))
                .filter((log) => {
                    const hasRecipient = !!(log[LOG_FIELDS.RECIPIENT_NUMBER] || "").toString().trim();
                    const hasSender    = !!(log[LOG_FIELDS.SENDER_NUMBER]    || "").toString().trim();
                    const activeField  = chat.activePhone ? chat.activePhone.fieldApiName : null;
                    const logField     = (log[LOG_FIELDS.SELECTED_PHONE_FIELD] || "").toString().trim();

                    // No phone on either side — only include if tied to the active field via Selected_Phone_Field
                    if (!hasRecipient && !hasSender) {
                        return !!(activeField && logField && logField === activeField);
                    }

                    // If the active phone has no number, only show inbound logs or
                    // field-matched outbound failures
                    if (!chat.activePhone || !chat.activePhone.resolvedNumber) {
                        if ((log[LOG_FIELDS.DIRECTION] || "").toLowerCase() === "inbound") return true;
                        return !!(activeField && logField && logField === activeField);
                    }

                    // Otherwise filter by matching phone number
                    const logPhone = getLogPhone(log);
                    if (!logPhone) return true;
                    return normalizePhone(logPhone) === normalizePhone(chat.activePhone.resolvedNumber);
                });

            if (!newLogs.length) return;

            newLogs.sort((a, b) =>
                new Date(a.Created_Time || a[LOG_FIELDS.MESSAGE_TIMESTAMP] || 0).getTime() -
                new Date(b.Created_Time || b[LOG_FIELDS.MESSAGE_TIMESTAMP] || 0).getTime()
            );

            const isAtBottom = $area[0].scrollHeight - $area[0].scrollTop - $area[0].clientHeight < 60;
            if (!chat.noPhoneMode) $emptyState.hide();

            newLogs.forEach((log) => {
                chat.seenIds.add(log.id);
                const dir          = (log[LOG_FIELDS.DIRECTION] || "").toLowerCase() === "inbound" ? "in" : "out";
                const status       = (log[LOG_FIELDS.STATUS]    || "").toLowerCase() === "failed"  ? "failed" : "sent";
                const ts           = log.Created_Time || log[LOG_FIELDS.MESSAGE_TIMESTAMP];
                const time         = ts
                    ? new Date(ts).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true })
                    : "—";
                const recipientNum = (log[LOG_FIELDS.RECIPIENT_NUMBER] || "").toString().trim();
                // Build retryParams for all failed outbound logs
                const retryParams  = (dir === "out" && status === "failed") ? buildRetryParams(log) : null;
                $area.append(buildBubbleHtml({ dir, text: log[LOG_FIELDS.MESSAGE_CONTENT] || "", time, statusClass: dir === "out" ? status : null, retryParams, logId: log.id }));
            });

            if (isAtBottom) $area[0].scrollTop = $area[0].scrollHeight;
        })
        .catch((err) => console.warn("[DevtacMessaging] Poll error:", err))
        .finally(() => { _pollPending = false; });
}

function startPolling() {
    stopPolling();
    _pollTimer = setInterval(pollNewMessages, POLL_INTERVAL);
}

function stopPolling() {
    if (_pollTimer !== null) { clearInterval(_pollTimer); _pollTimer = null; }
}

document.addEventListener("visibilitychange", () => {
    _pageVisible = !document.hidden;
    if (_pageVisible) { pollNewMessages(); startPolling(); }
    else stopPolling();
});

// ── Viber Credit display ────────────────────────────────────────────────────────
function renderViberCredits() {
    const $badge = $("#ViberCreditBadge");
    if (!$badge.length) return;
    const credits = chat.ViberCredits;
    if (credits === null || credits === undefined || credits === "") { $badge.hide(); return; }
    const num = parseInt(credits, 10);
    $badge.show()
        .toggleClass("low", !isNaN(num) && num < 50)
        .find(".credit-value").text(isNaN(num) ? credits : num.toLocaleString());
}

// ── PageLoad ──────────────────────────────────────────────────────────────────
ZOHO.embeddedApp.on("PageLoad", (data) => {
    state.pageLoadData = data;

    const module   = data.Entity || data.entity || data.module || data.Module || "";
    const recordId = data.EntityId || data.recordId || data.id || "";
    const name     = data.EntityData?.Full_Name
        || data.EntityData?.Deal_Name
        || data.EntityData?.Account_Name
        || data.EntityData?.Name
        || data.EntityData?.name
        || "";

    chat.module           = module;
    chat.recordId         = recordId;
    chat.activePhone      = null;
    chat.messages         = [];
    chat.allMessages      = [];
    chat.historyPage      = 0;
    chat.historyExhausted = false;
    chat.seenIds          = new Set();
    chat.noPhoneMode      = false;
    stopPolling();

    setRecipient(name, module);
    loadTemplates(module);

    if (module && recordId) {
        const modulePhoneVar = MODULE_PHONE_VAR[module] || null;

        Promise.all([
            ZOHO.CRM.API.getOrgVariable(ORG_VARS.MESSAGES_PER_PAGE).catch(() => null),
            ZOHO.CRM.CONFIG.getOrgInfo().catch(() => null),
            ZOHO.CRM.API.getOrgVariable(ORG_VARS.CLIENT_API_KEY).catch(() => null),
            modulePhoneVar ? ZOHO.CRM.API.getOrgVariable(modulePhoneVar).catch(() => null) : Promise.resolve(null),
            ZOHO.CRM.API.getOrgVariable(ORG_VARS.CREDIT_BALANCE).catch(() => null),
        ])
            .then(([varRes, orgRes, keyRes, phoneVarRes, creditsRes]) => {
                chat.historyBatchSize = clampBatchSize(varRes?.Success?.Content);
                state.orgName         = orgRes?.org?.[0]?.company_name || "";
                chat.zapiKey          = keyRes?.Success?.Content || "";
                chat.savedPhoneField  = phoneVarRes?.Success?.Content || null;
                chat.ViberCredits       = creditsRes?.Success?.Content ?? null;
                renderViberCredits();

                return Promise.all([
                    ZOHO.CRM.META.getFields({ Entity: module }),
                    ZOHO.CRM.API.getRecord({ Entity: module, RecordID: recordId }),
                ]);
            })
            .then(([metaResp, recResp]) => {
                const fields = (metaResp && metaResp.fields) || [];
                const record = (recResp && recResp.data && recResp.data[0]) || {};
                state.lookupFields = extractLookupFields(fields);
                chat.record        = record;

                const liveName = record.Full_Name || record.Deal_Name || record.Account_Name || record.Name || name;
                setRecipient(liveName, module);
                loadPhoneFieldsAndRecord(module, fields, record, chat.savedPhoneField);
            })
            .catch(() => { $emptyText.text("Failed to load record data."); });
    }
});

ZOHO.embeddedApp.init();