import { state } from "./state.js";
import { filterPhoneFields } from "./utils.js";

function restorePhoneField() {
    if (!state.savedField) return;
    $("#phoneField option").each(function () {
        try {
            const cfg = JSON.parse($(this).val());
            if (
                cfg.field       === state.savedField &&
                cfg.source      === state.savedPhoneSource &&
                (cfg.lookupField || "") === (state.savedLookupField || "")
            ) {
                $("#phoneField").val($(this).val()).trigger("change");
                return false;
            }
        } catch (e) {}
    });
}

export function loadPhoneFields(module, fields) {
    const $pf = $("#phoneField");
    $pf.empty().append('<option value="">Loading fields…</option>').prop("disabled", true).trigger("change");

    const ownPhoneFields = filterPhoneFields(fields);
    const contactLookups = fields.filter((f) => {
        const dtype   = (f.data_type || "").toLowerCase();
        const apiName = (f.api_name  || "").toLowerCase();

        // Zoho Deals exposes Contact_Name as a "relate" field that may not carry
        // refers_to/lookup.module — catch it by api_name as a fallback.
        if (apiName === "contact_name") return true;

        const refModule = (
            (f.lookup && f.lookup.module && (f.lookup.module.api_name || f.lookup.module)) ||
            (f.refers_to && (f.refers_to.api_name || f.refers_to)) || ""
        );
        return (dtype === "lookup" || dtype === "relate") && refModule.toString().toLowerCase() === "contacts";
    });

    $pf.empty();

    if (ownPhoneFields.length > 0) {
        const $og = $("<optgroup>", { label: module + " Fields" });
        ownPhoneFields.forEach((f) => {
            $og.append($("<option>", {
                value: JSON.stringify({ source: "own", field: f.api_name, fieldLabel: f.field_label || f.api_name, lookupField: null, lookupLabel: null }),
                text:  f.field_label || f.api_name,
            }));
        });
        $pf.append($og);
    }

    function afterFields() {
        if ($pf.find("option").length === 0) $pf.append('<option value="">No phone fields found</option>');
        $pf.prop("disabled", false).trigger("change");
        restorePhoneField();
    }

    if (contactLookups.length > 0) {
        ZOHO.CRM.META.getFields({ Entity: "Contacts" })
            .then((cr) => {
                const cPhones = filterPhoneFields((cr && cr.fields) || []);
                contactLookups.forEach((lookup) => {
                    const ll = lookup.field_label || lookup.api_name;
                    const $g = $("<optgroup>", { label: "Via " + ll + " (Contact)" });
                    cPhones.forEach((cf) => {
                        $g.append($("<option>", {
                            value: JSON.stringify({ source: "contact_lookup", field: cf.api_name, fieldLabel: cf.field_label || cf.api_name, lookupField: lookup.api_name, lookupLabel: ll }),
                            text:  cf.field_label || cf.api_name,
                        }));
                    });
                    if (cPhones.length > 0) $pf.append($g);
                });
                afterFields();
            })
            .catch(afterFields);
    } else {
        afterFields();
    }
}
