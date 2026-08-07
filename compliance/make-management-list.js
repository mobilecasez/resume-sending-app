/**
 * "List of Senior Management Officials" letter for Google Play / BillDesk payments-profile
 * verification, as a print-ready A4 PDF on the company letterhead.
 *
 * Written as a LETTER, not a form: the statutory identifiers sit in the masthead where a verifier
 * expects them, the officials are typeset rather than ruled for handwriting, and the only thing left
 * to do on paper is sign and stamp it.
 *
 * The masthead, closing declaration and signature block come from ./letterhead so this letter and
 * the shareholding pattern are word-for-word identical wherever they overlap. They are submitted
 * together, and a difference between them is what gets a submission queried.
 *
 *   node make-management-list.js --details details.json --out zSellr-Senior-Management-Officials.pdf
 */
const L = require('./letterhead');
const { esc } = L;

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const D = L.loadDetails(args);
const COMPANY = D.company || 'zSellr (OPC) Private Limited';

const officials = (Array.isArray(D.officials) && D.officials.length ? D.officials : [{}]);
// Only claimed when we actually know it — it is a factual statement about the company's constitution.
const sole = officials.length === 1 && officials[0].name;

const rows = officials.map((o, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td class="nm">${o.name ? esc(o.name) : ''}</td>
    <td>${o.designation ? esc(o.designation) : ''}</td>
    <td class="mono">${o.din ? esc(o.din) : ''}</td>
    <td class="mono">${o.pan ? esc(o.pan) : ''}</td>
  </tr>`).join('');

const body = `
${L.masthead(D, COMPANY)}

<h1>LIST OF SENIOR MANAGEMENT OFFICIALS</h1>

<p>This is to certify that ${esc(COMPANY)}${D.incorporated ? `, incorporated on ${esc(D.incorporated)}` : ''}${D.cin ? ` under CIN ${esc(D.cin)}` : ''}, is a One Person Company registered under the Companies Act, 2013, and that the following ${sole ? 'person is the Senior Management Official' : 'persons are the Senior Management Officials'} of the Company as on the date of this letter:</p>

<table>
  <thead>
    <tr><th>Sl.</th><th>Name</th><th>Designation</th><th>DIN</th><th>PAN</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

${sole ? `<p>Being a One Person Company under Section 3(1)(c) of the Companies Act, 2013, the Company has a sole Director, who is also the Authorised Signatory for all statutory, banking and payment-related matters on behalf of the Company.</p>` : ''}

${L.signature(D, COMPANY)}`;

(async () => {
  await L.render(body, argOf('--out', 'Senior-Management-Officials.pdf'),
    D.address ? [] : ['registered office is blank — fill "address" in details.json']);
})();
