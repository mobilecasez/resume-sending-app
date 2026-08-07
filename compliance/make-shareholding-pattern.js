/**
 * "Shareholding Pattern" letter for Google Play / BillDesk payments-profile verification.
 *
 * For a One Person Company the pattern is trivially simple — a sole member holding 100% — but the
 * letter still has to SHOW the capital structure, because that is the part a verifier reconciles
 * against the MCA record and the bank account.
 *
 * The 100% figure is the one number stated without being supplied: it follows from the company's
 * constitution, since Section 3(1)(c) of the Companies Act 2013 permits an OPC exactly one member.
 * Every rupee figure comes from details.json, or prints as a rule.
 *
 *   node make-shareholding-pattern.js --details details.json --out Shareholding-Pattern.pdf
 */
const L = require('./letterhead');
const { esc, fill, inr } = L;

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const D = L.loadDetails(args);
const COMPANY = D.company || 'zSellr (OPC) Private Limited';
const C = D.capital || {};

const holders = (Array.isArray(D.shareholders) && D.shareholders.length ? D.shareholders : [{}]);
const sole = holders.length === 1;

// A single member necessarily holds the whole of the paid-up capital; anything else is supplied.
const pctOf = (h) => h.percent || (sole ? '100.00' : '');

const rows = holders.map((h, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td class="nm">${h.name ? esc(h.name) : ''}</td>
    <td class="mono">${h.pan ? esc(h.pan) : ''}</td>
    <td class="r mono">${h.shares ? inr(h.shares) : ''}</td>
    <td class="r mono">${h.amount ? '₹ ' + inr(h.amount) : ''}</td>
    <td class="r"><b>${pctOf(h) ? pctOf(h) + '%' : ''}</b></td>
  </tr>`).join('');

const totalShares = holders.every((h) => h.shares)
  ? holders.reduce((a, h) => a + Number(String(h.shares).replace(/[^0-9.]/g, '')), 0) : null;
const totalAmount = holders.every((h) => h.amount)
  ? holders.reduce((a, h) => a + Number(String(h.amount).replace(/[^0-9.]/g, '')), 0) : null;

const totalRow = `<tr class="total">
    <td colspan="3">Total</td>
    <td class="r mono">${totalShares != null ? inr(totalShares) : ''}</td>
    <td class="r mono">${totalAmount != null ? '₹ ' + inr(totalAmount) : ''}</td>
    <td class="r">100.00%</td>
  </tr>`;

// Capital structure, stated as a sentence rather than a second table — it reads as a letter and
// keeps the page to one side.
const capLine = (label, amount, shares, fv) => `
  <p style="margin-bottom:7px"><b>${label}:</b> ₹ ${amount ? esc(inr(amount)) : fill('', 78)}
  divided into ${shares ? esc(inr(shares)) : fill('', 58)} equity shares of
  ₹ ${fv ? esc(inr(fv)) : fill('', 38)} each.</p>`;

const missing = [];
if (!C.authorisedAmount || !C.authorisedShares) missing.push('authorised capital');
if (!C.paidUpAmount || !C.paidUpShares) missing.push('paid-up capital');
if (!C.faceValue) missing.push('face value per share');
if (!holders[0].shares) missing.push('number of shares held');
if (!D.address) missing.push('registered office address');

const body = `
${L.masthead(D, COMPANY)}

<h1>SHAREHOLDING PATTERN</h1>

<p>This is to certify that ${esc(COMPANY)}${D.incorporated ? `, incorporated on ${esc(D.incorporated)}` : ''}${D.cin ? ` under CIN ${esc(D.cin)}` : ''}, is a One Person Company registered under the Companies Act, 2013. Its capital structure and shareholding pattern as on the date of this letter are as follows:</p>

${capLine('Authorised Share Capital', C.authorisedAmount, C.authorisedShares, C.faceValue)}
${capLine('Issued, Subscribed and Paid-up Share Capital', C.paidUpAmount, C.paidUpShares, C.faceValue)}

<table>
  <thead>
    <tr>
      <th>Sl.</th><th>Name of Shareholder</th><th>PAN</th>
      <th class="r">No. of Equity Shares</th><th class="r">Amount (₹)</th><th class="r">% Holding</th>
    </tr>
  </thead>
  <tbody>${rows}${totalRow}</tbody>
</table>

${sole ? `<p>Being a One Person Company under Section 3(1)(c) of the Companies Act, 2013, the Company has one member only, who holds the entire issued, subscribed and paid-up equity share capital. No shares are held by any other person or body corporate.</p>` : ''}

${L.signature(D, COMPANY)}`;

(async () => {
  await L.render(body, argOf('--out', 'Shareholding-Pattern.pdf'),
    missing.length ? [`missing from details.json: ${missing.join(', ')}`] : []);
})();
