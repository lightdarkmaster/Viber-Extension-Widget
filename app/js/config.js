// ─────────────────────────────────────────────────────────────────────────────
// Devtac Messaging – Widget Config
//
// This file is the single source of truth for all channel-specific and
// namespace-specific values. When duplicating this widget for Viber or
// WhatsApp, only edit this file.
//
// CHANNEL VALUES:
//   Viber      → namespace: devtacVibermessaging
//   Viber    → namespace: devtacvibermessaging   (future)
//   WhatsApp → namespace: devtacwhatsappmessaging   future)
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIG = {

    // ── Identity ───────────────────────────────────────────────────────────────
    // The Zoho Sigma extension namespace. Change this when duplicating for
    // another channel.
    NAMESPACE: "devtacvibermessaging",

    // The messaging channel. Used as a display label and as the "channel"
    // parameter sent to the backend send function.
    CHANNEL: "Viber",

    // The display name of this widget. Shown in the custom action UI header
    // and the chat widget header. Change this when duplicating for another
    // channel (e.g. "Devtac Viber Messaging", "Devtac WhatsApp Messaging").
    WIDGET_NAME: "Devtac Viber Extension",


    // ── Derived from NAMESPACE (do not edit manually) ──────────────────────────
    // These are computed below and exported for use across all widget JS files.

    // Zoho CRM custom module API names
    // get_TEMPLATES_ENTITY:  "<ns>__Devtac_Viber_Templates"
    // get_LOGS_ENTITY:       "<ns>__Devtac_Viber_Logs"

    // Org variable API names
    // get_VAR_*: "<ns>__<Variable>"

    // Zoho CRM function API name
    // get_FN_SEND:           "<ns>__senddevtacmessage"
    // get_FN_SET_PHONE:      "<ns>__setPhoneField"

    // Related list API names per module
    // get_RELATED_LIST(module): "<ns>__Related_Messages_<Module>"
};

// ── Shorthand helper ──────────────────────────────────────────────────────────
const ns = CONFIG.NAMESPACE;

// ── CRM Module / Entity names ─────────────────────────────────────────────────
export const ENTITY = {
    TEMPLATES: `${ns}__Devtac_Viber_Templates`,
    LOGS:      `${ns}__Devtac_Viber_Logs`,
};

// ── Template field names (on the Templates entity) ────────────────────────────
export const TEMPLATE_FIELDS = {
    MODULE:          `${ns}__Module`,
    MESSAGE_CONTENT: `${ns}__Message_Content`,
};

// ── Log record field names (on the Logs entity) ───────────────────────────────
export const LOG_FIELDS = {
    DIRECTION:          `${ns}__Direction`,
    STATUS:             `${ns}__Status`,
    MESSAGE_CONTENT:    `${ns}__Message_Content`,
    MESSAGE_TIMESTAMP:  `${ns}__Message_Timestamp`,
    RECIPIENT_NUMBER:   `${ns}__Recipient_Number`,
    SENDER_NUMBER:      `${ns}__Sender_Number`,
    SELECTED_PHONE_FIELD: `${ns}__Selected_Phone_Field`,
    // Legacy phone lookup fields (kept for backwards-compat with older logs)
    TO_NUMBER:          `${ns}__To_Number`,
    FROM_NUMBER:        `${ns}__From_Number`,
    PHONE_NUMBER:       `${ns}__Phone_Number`,
    RECIPIENT:          `${ns}__Recipient`,
};

// ── Related list names per CRM module ─────────────────────────────────────────
export const RELATED_LISTS = {
    Leads:    `${ns}__Related_Messages_Leads`,
    Deals:    `${ns}__Related_Messages_Deals`,
    Contacts: `${ns}__Related_Messages_Contacts`,
};

// ── Related lookup field names on the Logs entity ────────────────────────────
export const LOG_RELATED_FIELDS = {
    Leads:    `${ns}__Related_Lead`,
    Deals:    `${ns}__Related_Deal`,
    Contacts: `${ns}__Related_Contact`,
};

// ── Org variable API names ────────────────────────────────────────────────────
export const ORG_VARS = {
    // Generic / shared
    CLIENT_API_KEY:          `${ns}__Client_API_Key`,
    MESSAGES_PER_PAGE:       `${ns}__Messages_Per_Page`,
    ENABLE_POPUP:            `${ns}__Enable_Pop_up_Reminder_Notification`,
    POPUP_INTERVAL:          `${ns}__Pop_up_Reminder_Interval`,

    // Per-module saved phone field preference
    PHONE_FIELD_LEADS:       `${ns}__Leads_Phone_Field`,
    PHONE_FIELD_CONTACTS:    `${ns}__Contacts_Phone_Field`,
    PHONE_FIELD_DEALS:       `${ns}__Deals_Phone_Field`,

    // Viber-channel-specific (prefixed with channel name in Sigma)
    LICENSE_KEY:             `${ns}__Viber_License_Key`,
    TRIAL_STATUS:            `${ns}__Viber_Trial_Status`,
    CREDIT_BALANCE:          `${ns}__Viber_Credit_Balance`,
    IS_THRESHOLD_REACHED:    `${ns}__Viber_Is_Message_Threshold_Reached`,
};

// ── Module → phone field org variable map ─────────────────────────────────────
// Matches the MODULE_PHONE_VAR map previously hardcoded in chat-notification-main.js.
export const MODULE_PHONE_VAR = {
    Leads:    ORG_VARS.PHONE_FIELD_LEADS,
    Contacts: ORG_VARS.PHONE_FIELD_CONTACTS,
    Deals:    ORG_VARS.PHONE_FIELD_DEALS,
};

// ── CRM Function names ────────────────────────────────────────────────────────
export const FUNCTIONS = {
    SEND_MESSAGE:  `${ns}__senddevtacmessage`,
    SET_PHONE_FIELD: `${ns}__setPhoneField`,
};

// ── Zoho CRM API send endpoint ────────────────────────────────────────────────
// Used in chat-notification-main.js for ZOHO.CRM.HTTP.post
export const SEND_API_URL = (zapiKey) =>
    `https://www.zohoapis.com/crm/v7/functions/${FUNCTIONS.SEND_MESSAGE}/actions/execute` +
    `?auth_type=apikey&zapikey=${encodeURIComponent(zapiKey)}`;