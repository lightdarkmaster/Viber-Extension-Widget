import { state } from "./state.js";
import { formatModuleLabel, extractLookupFields } from "./utils.js";
import { checkReady } from "./ui.js";
import { loadPhoneFields } from "./phoneFields.js";
import { loadTemplates } from "./templates.js";
import { CONFIG } from "./config.js";

// Init Select2
$("#channel").select2({ minimumResultsForSearch: Infinity });
$("#template").select2({ placeholder: "-- Select a template --", allowClear: true });
$("#phoneField").select2({ placeholder: "-- Select a phone field --" });

// Status checks on selection change
$("#template, #phoneField").on("change", checkReady);

// PageLoad — module and saved config come in here
ZOHO.embeddedApp.on("PageLoad", (data) => {
    state.pageLoadData = data;

    const module      = data.Entity || data.entity || data.module || data.Module || data.EntityName || data.moduleName || "";
    const moduleLabel = data.EntityDisplayName || data.entity_label || data.moduleLabel || formatModuleLabel(module);

    $("#moduleText").text(moduleLabel || formatModuleLabel(module) || "Unknown");
    $("#moduleSelect").val(module);

    const cfg = data.configdata || {};
    if (cfg.TemplateId)    state.savedTemplateId  = cfg.TemplateId;
    if (cfg.PhoneSource)   state.savedPhoneSource = cfg.PhoneSource;
    if (cfg.SelectedField) state.savedField       = cfg.SelectedField;
    state.savedLookupField = cfg.LookupField || null;

    if (module) {
        ZOHO.CRM.META.getFields({ Entity: module }).then(resp => {
            const fields = (resp && resp.fields) || [];
            state.lookupFields = extractLookupFields(fields);
            loadPhoneFields(module, fields);
            loadTemplates(module);
        });
    }
});

// Init + submit handler
ZOHO.embeddedApp.init().then(() => {
    document.getElementById("submitBtn").addEventListener("click", () => {
        const templateId  = $("#template").val();
        const module      = $("#moduleSelect").val();
        const phoneRaw    = $("#phoneField").val();
        const moduleLabel = $("#moduleText").text();

        if (!templateId || !module || !phoneRaw) return;

        let phoneConfig;
        try {
            phoneConfig = JSON.parse(phoneRaw);
        } catch (e) {
            phoneConfig = { source: "own", field: phoneRaw, fieldLabel: phoneRaw, lookupField: null, lookupLabel: null };
        }

        const lookupFieldsStr = state.lookupFields
            .map(f => f.fieldApiName + "|" + f.relatedModule)
            .join(",");

        ZOHO.CRM.ACTION.setConfig({
            Channel:             CONFIG.CHANNEL,
            TemplateId:          templateId,
            SelectedModule:      module,
            SelectedModuleLabel: moduleLabel,
            PhoneSource:         phoneConfig.source,
            SelectedField:       phoneConfig.field,
            SelectedFieldLabel:  phoneConfig.fieldLabel,
            LookupField:         phoneConfig.lookupField || "",
            LookupFieldLabel:    phoneConfig.lookupLabel || "",
            LookupFields:        lookupFieldsStr,
            PageLoadData:        JSON.stringify(state.pageLoadData),
        });
    });
});