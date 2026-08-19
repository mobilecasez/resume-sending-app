// Half the US state abbreviations are also ISO-2 COUNTRY codes (CA, IN, DE, GA, PA, VA, AZ, MD,
// AL, AR, CO, ID, LA, MT, NE, SC…). Reading the wrong two-letter token files a Palo Alto job under
// Canada, and the user never finds it. These are the assertions that keep that from happening.
const { resolveCountry, countryFromIso2, countryFromLocation } = require('../utils/jobLocation');

let pass = 0, fail = 0;
const eq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`  ✗ ${name}\n      got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); } };

console.log('── the collision cases (state code first, country code last) ──');
eq('Palo Alto CA US → US, not Canada', resolveCountry('Palo Alto, CA, US, 94304', 'Global'), 'US');
eq('Indianapolis IN US → US, not India', resolveCountry('Indianapolis, IN, US, 46204', 'Global'), 'US');
eq('Wilmington DE US → US, not Germany', resolveCountry('Wilmington, DE, US, 19801', 'Global'), 'US');
eq('Atlanta GA US → US, not Georgia', resolveCountry('Atlanta, GA, US, 30301', 'Global'), 'US');
eq('Phoenix AZ US → US, not Azerbaijan', resolveCountry('Phoenix, AZ, US, 85001', 'Global'), 'US');
eq('Newtown Square PA US → US, not Panama', resolveCountry('Newtown Square, PA, US, 19073', 'Global'), 'US');
eq('Baltimore MD US → US', resolveCountry('Baltimore, MD, US, 21201', 'Global'), 'US');
eq('Little Rock AR US → US, not Argentina', resolveCountry('Little Rock, AR, US, 72201', 'Global'), 'US');
eq('Denver CO US → US, not Colombia', resolveCountry('Denver, CO, US, 80201', 'Global'), 'US');
eq('Boise ID US → US, not Indonesia', resolveCountry('Boise, ID, US, 83701', 'Global'), 'US');

console.log('── and the same codes AS countries when they stand last ──');
eq('Walldorf DE → Germany', resolveCountry('Walldorf, DE, 69190', 'Global'), 'Germany');
eq('Gurgaon IN → India', resolveCountry('Gurgaon, IN, 122002', 'Global'), 'India');
eq('Bangalore KA IN → India (state then country)', resolveCountry('Bangalore, KA, IN, 560066', 'Global'), 'India');
eq('Toronto ON CA → Canada', resolveCountry('Toronto, ON, CA, M5H 2N2', 'Global'), 'Canada');
eq('Baku AZ → Azerbaijan', resolveCountry('Baku, AZ, 1000', 'Global'), 'Azerbaijan');
eq('Tbilisi GE → Georgia', resolveCountry('Tbilisi, GE, 0100', 'Global'), 'Georgia');
eq('Panama City PA → Panama', resolveCountry('Panama City, PA, 07096', 'Global'), 'Panama');
eq('Tokyo JP → Japan', resolveCountry('Tokyo, Tokyo, JP, 100-0004', 'Global'), 'Japan');
eq('Sao Paulo SP BR → Brazil', resolveCountry('Sao Paulo, SP, BR, 04571', 'Global'), 'Brazil');
eq('Sydney NSW AU → Australia', resolveCountry('Sydney, NSW, AU, 2000', 'Global'), 'Australia');

console.log('── existing name/city matching still WINS (nothing regressed) ──');
eq('spelled-out country beats any code', resolveCountry('Berlin, Germany', 'Europe'), 'Germany');
eq('known city still resolves', resolveCountry('San Francisco', 'Global'), 'US');
eq('London → UK', resolveCountry('London', 'Global'), 'UK');
eq('countryFromLocation unchanged for plain names', countryFromLocation('Bangalore, India'), 'India');

console.log('── it only ever UPGRADES an unresolved job ──');
eq('no code and no known city → board label as before', resolveCountry('Somewhere Unknown', 'Europe'), 'Europe');
eq('nothing at all → Global as before', resolveCountry('', ''), 'Global');
eq('ISO-2 beats a vague board label', resolveCountry('Nowhereville, PT, 1000', 'Global'), 'Portugal');

console.log('── junk must not become a country ──');
eq('YY is not a country', countryFromIso2('Somewhere, YY, 12345'), null);
eq('KA alone (Indian state) is not a country', countryFromIso2('Bangalore, KA'), null);
eq('DC alone is not a country', countryFromIso2('Washington, DC'), null);
eq('lowercase "de" (a preposition) is not Germany', countryFromIso2('Rio de Janeiro'), null);
eq('lowercase "in" is not India', countryFromIso2('Built in Paris'), null);
eq('3+ letter tokens are ignored', countryFromIso2('Somewhere, USA, 12345'), null);
eq('empty is null', countryFromIso2(''), null);
eq('null-safe', countryFromIso2(null), null);

console.log(`\niso-2 country: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
