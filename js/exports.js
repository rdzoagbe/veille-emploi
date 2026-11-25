import { applicationDate, csvCell } from './history.js';
export function setupExports({ $, t, locale, esc, shortPlace, stKey, todayIso, getOffers, getData }) {
/* export: printable PDF report and CSV */
const exportSheet = $('exportSheet');
$('exportBtn').addEventListener('click', () => { if (exportSheet.showModal) exportSheet.showModal(); else exportSheet.setAttribute('open', ''); });
$('exportClose').addEventListener('click', () => exportSheet.close());
exportSheet.addEventListener('click', (e) => { if (e.target === exportSheet) exportSheet.close(); });
const APPLIED = ['applied', 'interview', 'rejected'];
const dLong = (iso) => !iso ? t('rpUnknown') : new Date(iso).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const srcLabel = (s) => (t('src_' + s) !== 'src_' + s ? t('src_' + s) : s || '');
$('exportPdf').addEventListener('click', () => {
  const apps = getOffers().filter((o) => APPLIED.includes(o.status)).sort((a, b) => (Date.parse(applicationDate(b)) || 0) - (Date.parse(applicationDate(a)) || 0) || Date.parse(b.sent_at) - Date.parse(a.sent_at));
  const who = [getData().prenom, getData().email].filter(Boolean).map(esc).join(' · ');
  const rows = apps.map((o) => `<tr><td>${esc(dLong(applicationDate(o)))}</td><td>${esc(o.title)}</td><td>${esc(o.company || '')}</td><td>${esc(shortPlace(o.location))}</td><td>${esc(t('st_' + o.status))}</td><td>${esc(srcLabel(o.source))}</td></tr>`).join('');
  $('printArea').innerHTML = `<h1>${esc(t('rpTitle'))}</h1><p class="meta">${who}<br>${esc(t('rpGen', { d: dLong(new Date().toISOString()) }))}</p>
    <div class="sum"><b>${esc(t('rpApps', { n: apps.length }))}</b><span>${esc(t('rpInt', { n: apps.filter((o) => o.status === 'interview').length }))}</span><span>${esc(t('rpRej', { n: apps.filter((o) => o.status === 'rejected').length }))}</span></div>
    ${apps.length ? `<table><thead><tr><th>${esc(t('rpDate'))}</th><th>${esc(t('rpJob'))}</th><th>${esc(t('rpCompany'))}</th><th>${esc(t('rpPlace'))}</th><th>${esc(t('rpStatus'))}</th><th>${esc(t('rpSource'))}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>${esc(t('rpNone'))}</p>`}
    <p class="foot">${esc(t('rpNote'))}</p>`;
  exportSheet.close();
  setTimeout(() => window.print(), 50);
});
$('exportCsv').addEventListener('click', () => {
  const q = csvCell;
  const head = [t('rpDate'), t('rpReceived'), t('rpJob'), t('rpCompany'), t('rpPlace'), t('rpStatus'), t('rpSource'), t('rpLink')].map(q).join(';');
  const lines = [...getOffers()].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at)).map((o) => [o.applied_at ? dLong(applicationDate(o)) : '', dLong(o.sent_at), o.title, o.company, o.location, t('st_' + stKey(o)), srcLabel(o.source), o.url || ''].map(q).join(';'));
  const blob = new Blob(['\ufeff' + [head, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `veille-emploi-candidatures-${todayIso()}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  exportSheet.close();
});

}
