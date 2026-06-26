export function checkReady() {
    const t     = !!$("#template").val();
    const p     = !!$("#phoneField").val();
    const ready = t && p;

    $("#submitBtn").prop("disabled", !ready);
    $("#statusDot").toggleClass("ready", ready);

    if (ready) {
        $("#statusText").text("Ready — will send to the " + $("#phoneField option:selected").text() + " field");
    } else if (!t) {
        $("#statusText").text("Select a template to continue");
    } else {
        $("#statusText").text("Select a phone field to continue");
    }
}
