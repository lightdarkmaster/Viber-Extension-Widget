export const PHONE_KEYWORDS = /mobile|phone|fax|whatsapp|contact_no|cell|telephone/i;

export function formatModuleLabel(str) {
    return str.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function filterPhoneFields(fields) {
    return fields.filter((f) => {
        const dtype = (f.data_type || "").toLowerCase();
        return dtype === "phone"
            || PHONE_KEYWORDS.test(f.api_name || "")
            || PHONE_KEYWORDS.test(f.field_label || "");
    });
}

export function extractLookupFields(fields) {
    return fields
        .filter(f => ["lookup", "relate"].includes((f.data_type || "").toLowerCase()))
        .map(f => ({
            fieldApiName:  f.api_name,
            fieldLabel:    f.field_label || f.api_name,
            relatedModule: (
                (f.lookup && f.lookup.module && (f.lookup.module.api_name || f.lookup.module)) ||
                (f.refers_to && (f.refers_to.api_name || f.refers_to)) || ""
            ).toString()
        }));
}