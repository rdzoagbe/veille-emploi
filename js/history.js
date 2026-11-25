// A received date or a later status change is not an application date.
export function applicationDate(offer) {
  return offer.applied_at && Number.isFinite(Date.parse(offer.applied_at)) ? offer.applied_at : null;
}
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
