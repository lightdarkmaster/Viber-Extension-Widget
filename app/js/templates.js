import { state } from "./state.js";
import { ENTITY, TEMPLATE_FIELDS } from "./config.js";

export function loadTemplates(module) {
    ZOHO.CRM.API.searchRecord({
        Entity: ENTITY.TEMPLATES,
        Type:   "criteria",
        Query:  `(${TEMPLATE_FIELDS.MODULE}:equals:${module})`,
    })
        .then((resp) => {
            const records = resp.data || [];
            const $sel    = $("#template").empty().append('<option value="">-- Select a template --</option>');

            if (records.length > 0) {
                records.forEach((t) => $sel.append($("<option>", { value: t.id, text: t.Name || t.name || t.id })));
            } else {
                $sel.append('<option value="" disabled>No templates found</option>');
            }

            if (state.savedTemplateId) {
                $("#template").val(state.savedTemplateId).trigger("change");
            } else {
                $sel.trigger("change");
            }
        })
        .catch(() => {
            $("#template").empty().append('<option value="" disabled>Error loading templates</option>');
        });
}