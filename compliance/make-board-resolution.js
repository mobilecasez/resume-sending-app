/**
 * Board Resolution / Authority Letter for the Google Play payments profile (BillDesk).
 *
 * This is a DIFFERENT instrument from the management list and the shareholding pattern, and that
 * distinction is what a rejection on this item usually comes down to. Those two certify facts about
 * the company. This one is the company ACTING: a resolution that authorises a named person to bind
 * it, which is what the payment processor needs before it will accept documents signed by anybody.
 *
 * Form matters here for a One Person Company. An OPC with a single director does not hold board
 * meetings, and a resolution reciting a meeting, a quorum or "the Board of Directors" is wrong on
 * its face — quite possibly why the first attempt came back. Section 122(3) of the Companies Act,
 * 2013 provides that where such a company has one director, a resolution is validly passed when he
 * ENTERS IT IN THE MINUTES BOOK AND SIGNS IT. This document is drafted as a certified true copy of
 * exactly that, and says so.
 *
 *   node make-board-resolution.js --details details.json --out Board-Resolution.pdf
 */
const L = require('./letterhead');
const { esc, fill } = L;

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const D = L.loadDetails(args);
const COMPANY = D.company || 'zSellr (OPC) Private Limited';
const R = D.resolution || {};
const B = D.bank || {};

const who = D.signatoryName || '';
const desig = D.signatoryDesignation || 'Director';
const din = D.signatoryDin || '';
const rdate = R.date || D.date || '';
const appId = R.applicationId || '';

// Named only when supplied. An unverifiable account number on a document a bank will read is worse
// than no account clause at all.
const bankNamed = B.accountNumber && B.bankName;

const missing = [];
if (!rdate) missing.push('resolution date');
if (!who) missing.push('authorised signatory name');
if (!bankNamed) missing.push('bank details (optional — clause stays generic without them)');

const body = `
${L.masthead(D, COMPANY, { addressee: false })}

<h1>CERTIFIED TRUE COPY OF THE RESOLUTION PASSED BY THE SOLE DIRECTOR</h1>

<p style="text-align:center;margin-bottom:13px">of <b>${esc(COMPANY)}</b>, entered in the Minutes Book and signed by the sole Director pursuant to Section 122(3) of the Companies Act, 2013, on ${rdate ? `<b>${esc(rdate)}</b>` : fill('', 130)} at the Registered Office of the Company.</p>

<p><b>1. Enabling payment acceptance on Google Play.</b> <b>RESOLVED THAT</b> the Company be and is hereby authorised to register with and avail the payment aggregation, collection and settlement services of BillDesk (IndiaIdeas.com Limited) for the purpose of accepting payments in respect of the Company&rsquo;s applications distributed on Google Play${appId ? `, in connection with Application ID <b>${esc(appId)}</b>` : ''}, and to accept and execute the applicable merchant agreements, terms and conditions and policies.</p>

<p><b>2. Authorised signatory.</b> <b>RESOLVED FURTHER THAT</b> ${who ? `<b>Mr. ${esc(who)}</b>` : fill('', 190)}, ${esc(desig)}${din ? ` (DIN ${esc(din)})` : ''}, be and is hereby authorised to sign, execute and submit, for and on behalf of the Company, all applications, agreements, undertakings, declarations and know-your-customer documents required in connection therewith; to attest copies of the Company&rsquo;s constitutional and statutory documents; and to do all such acts and things as may be necessary to give effect to this resolution.</p>

<p><b>3. Settlement account.</b> <b>RESOLVED FURTHER THAT</b> the said authorised signatory be and is hereby authorised to nominate and link the bank account of the Company${bankNamed ? ` bearing account number <b>${esc(B.accountNumber)}</b> maintained with <b>${esc(B.bankName)}</b>${B.ifsc ? ` (IFSC ${esc(B.ifsc)})` : ''}` : ''} for the receipt of settlement proceeds, and to give such instructions in relation thereto as may be required.</p>

<p><b>4. Validity and ratification.</b> <b>RESOLVED FURTHER THAT</b> this authority shall remain in force until expressly revoked by a further resolution of the Company, and that all acts already done by the said authorised signatory in furtherance hereof be and are hereby ratified and confirmed.</p>

<p><b>Certified to be a true copy</b> of the resolution passed as aforesaid and entered in the Minutes Book of the Company.</p>

<div class="sign">
  <div class="signL">
    <div class="forco">For ${esc(COMPANY)}</div>
    <div class="sigline">Sole Director</div>
    <div class="sigfield"><span class="k">Name</span>${fill(who, 200)}</div>
    <div class="sigfield"><span class="k">Designation</span>${fill(desig, 200)}</div>
    ${din ? `<div class="sigfield"><span class="k">DIN</span>${fill(din, 200)}</div>` : ''}
    <div class="sigfield"><span class="k">Place</span>${fill(D.place, 200)}</div>
    <div class="sigfield"><span class="k">Date</span>${fill(rdate, 200)}</div>
  </div>
  <div class="sealwrap">
    <div class="sealspace"></div>
    <div class="sealcap">Company Seal</div>
  </div>
</div>

<div class="foot">${esc(COMPANY)}${D.cin ? ` &nbsp;·&nbsp; CIN ${esc(D.cin)}` : ''} &nbsp;·&nbsp; Certified true copy — valid only when signed by the sole Director and bearing the Company seal.</div>`;

(async () => {
  await L.render(body, argOf('--out', 'Board-Resolution.pdf'),
    missing.length ? [`check: ${missing.join('; ')}`] : []);
})();
