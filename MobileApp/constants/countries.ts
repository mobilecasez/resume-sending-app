// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Countries and their dial codes, for the "About you" step.
//
// ⚠️ STORED AS ONE PACKED STRING, NOT 250 OBJECT LITERALS. The list is parsed once at module load
// into the shape the pickers want. It is data, and data that is typed out as 250 four-key objects
// is data nobody will ever re-check.
//
// ⚠️ THE FLAG IS COMPUTED, NEVER STORED. A flag emoji is just its two ISO letters shifted into the
// regional-indicator block, so deriving it cannot disagree with the country code the way a
// hand-pasted emoji can. Devices that have no flag font (some older Android builds) render the two
// letters instead, which is a fine answer and not a broken glyph.
//
// ⚠️ DIAL CODES ARE NOT UNIQUE and this list does not pretend they are: +1 is the US, Canada and
// twenty Caribbean states; +7 is Russia and Kazakhstan. So a code alone can never be turned back
// into a country — which is why the phone step stores the code the user PICKED, and the country
// step asks separately instead of inferring one from the other.

export type Country = { iso: string; name: string; dial: string; flag: string };

/** iso|dial|name — one country per entry. */
const PACKED = [
  'AF|93|Afghanistan', 'AL|355|Albania', 'DZ|213|Algeria', 'AD|376|Andorra', 'AO|244|Angola',
  'AG|1|Antigua and Barbuda', 'AR|54|Argentina', 'AM|374|Armenia', 'AU|61|Australia', 'AT|43|Austria',
  'AZ|994|Azerbaijan', 'BS|1|Bahamas', 'BH|973|Bahrain', 'BD|880|Bangladesh', 'BB|1|Barbados',
  'BY|375|Belarus', 'BE|32|Belgium', 'BZ|501|Belize', 'BJ|229|Benin', 'BT|975|Bhutan',
  'BO|591|Bolivia', 'BA|387|Bosnia and Herzegovina', 'BW|267|Botswana', 'BR|55|Brazil',
  'BN|673|Brunei', 'BG|359|Bulgaria', 'BF|226|Burkina Faso', 'BI|257|Burundi', 'KH|855|Cambodia',
  'CM|237|Cameroon', 'CA|1|Canada', 'CV|238|Cape Verde', 'CF|236|Central African Republic',
  'TD|235|Chad', 'CL|56|Chile', 'CN|86|China', 'CO|57|Colombia', 'KM|269|Comoros', 'CG|242|Congo',
  'CD|243|Congo (DRC)', 'CR|506|Costa Rica', 'CI|225|Côte d’Ivoire', 'HR|385|Croatia', 'CU|53|Cuba',
  'CY|357|Cyprus', 'CZ|420|Czechia', 'DK|45|Denmark', 'DJ|253|Djibouti', 'DM|1|Dominica',
  'DO|1|Dominican Republic', 'EC|593|Ecuador', 'EG|20|Egypt', 'SV|503|El Salvador',
  'GQ|240|Equatorial Guinea', 'ER|291|Eritrea', 'EE|372|Estonia', 'SZ|268|Eswatini',
  'ET|251|Ethiopia', 'FJ|679|Fiji', 'FI|358|Finland', 'FR|33|France', 'GA|241|Gabon',
  'GM|220|Gambia', 'GE|995|Georgia', 'DE|49|Germany', 'GH|233|Ghana', 'GR|30|Greece',
  'GD|1|Grenada', 'GT|502|Guatemala', 'GN|224|Guinea', 'GW|245|Guinea-Bissau', 'GY|592|Guyana',
  'HT|509|Haiti', 'HN|504|Honduras', 'HK|852|Hong Kong', 'HU|36|Hungary', 'IS|354|Iceland',
  'IN|91|India', 'ID|62|Indonesia', 'IR|98|Iran', 'IQ|964|Iraq', 'IE|353|Ireland', 'IL|972|Israel',
  'IT|39|Italy', 'JM|1|Jamaica', 'JP|81|Japan', 'JO|962|Jordan', 'KZ|7|Kazakhstan', 'KE|254|Kenya',
  'KI|686|Kiribati', 'KW|965|Kuwait', 'KG|996|Kyrgyzstan', 'LA|856|Laos', 'LV|371|Latvia',
  'LB|961|Lebanon', 'LS|266|Lesotho', 'LR|231|Liberia', 'LY|218|Libya', 'LI|423|Liechtenstein',
  'LT|370|Lithuania', 'LU|352|Luxembourg', 'MO|853|Macao', 'MG|261|Madagascar', 'MW|265|Malawi',
  'MY|60|Malaysia', 'MV|960|Maldives', 'ML|223|Mali', 'MT|356|Malta', 'MH|692|Marshall Islands',
  'MR|222|Mauritania', 'MU|230|Mauritius', 'MX|52|Mexico', 'FM|691|Micronesia', 'MD|373|Moldova',
  'MC|377|Monaco', 'MN|976|Mongolia', 'ME|382|Montenegro', 'MA|212|Morocco', 'MZ|258|Mozambique',
  'MM|95|Myanmar', 'NA|264|Namibia', 'NR|674|Nauru', 'NP|977|Nepal', 'NL|31|Netherlands',
  'NZ|64|New Zealand', 'NI|505|Nicaragua', 'NE|227|Niger', 'NG|234|Nigeria', 'KP|850|North Korea',
  'MK|389|North Macedonia', 'NO|47|Norway', 'OM|968|Oman', 'PK|92|Pakistan', 'PW|680|Palau',
  'PS|970|Palestine', 'PA|507|Panama', 'PG|675|Papua New Guinea', 'PY|595|Paraguay', 'PE|51|Peru',
  'PH|63|Philippines', 'PL|48|Poland', 'PT|351|Portugal', 'PR|1|Puerto Rico', 'QA|974|Qatar',
  'RO|40|Romania', 'RU|7|Russia', 'RW|250|Rwanda', 'KN|1|Saint Kitts and Nevis',
  'LC|1|Saint Lucia', 'VC|1|Saint Vincent and the Grenadines', 'WS|685|Samoa', 'SM|378|San Marino',
  'ST|239|São Tomé and Príncipe', 'SA|966|Saudi Arabia', 'SN|221|Senegal', 'RS|381|Serbia',
  'SC|248|Seychelles', 'SL|232|Sierra Leone', 'SG|65|Singapore', 'SK|421|Slovakia',
  'SI|386|Slovenia', 'SB|677|Solomon Islands', 'SO|252|Somalia', 'ZA|27|South Africa',
  'KR|82|South Korea', 'SS|211|South Sudan', 'ES|34|Spain', 'LK|94|Sri Lanka', 'SD|249|Sudan',
  'SR|597|Suriname', 'SE|46|Sweden', 'CH|41|Switzerland', 'SY|963|Syria', 'TW|886|Taiwan',
  'TJ|992|Tajikistan', 'TZ|255|Tanzania', 'TH|66|Thailand', 'TL|670|Timor-Leste', 'TG|228|Togo',
  'TO|676|Tonga', 'TT|1|Trinidad and Tobago', 'TN|216|Tunisia', 'TR|90|Türkiye',
  'TM|993|Turkmenistan', 'TV|688|Tuvalu', 'UG|256|Uganda', 'UA|380|Ukraine',
  'AE|971|United Arab Emirates', 'GB|44|United Kingdom', 'US|1|United States', 'UY|598|Uruguay',
  'UZ|998|Uzbekistan', 'VU|678|Vanuatu', 'VA|39|Vatican City', 'VE|58|Venezuela', 'VN|84|Vietnam',
  'YE|967|Yemen', 'ZM|260|Zambia', 'ZW|263|Zimbabwe',
];

/** Two ISO letters → the regional-indicator pair that renders as that flag. */
export function flagOf(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return '';
  return String.fromCodePoint(
    ...iso.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

export const COUNTRIES: Country[] = PACKED.map((row) => {
  const [iso, dial, name] = row.split('|');
  return { iso, name, dial: `+${dial}`, flag: flagOf(iso) };
});

const BY_ISO: Record<string, Country> = {};
const BY_NAME: Record<string, Country> = {};
for (const c of COUNTRIES) { BY_ISO[c.iso] = c; BY_NAME[c.name.toLowerCase()] = c; }

export const countryByIso = (iso?: string | null): Country | null =>
  (iso && BY_ISO[iso.toUpperCase()]) || null;

/** Match a stored free-text country back to the list — how a saved address is re-opened. */
export const countryByName = (name?: string | null): Country | null => {
  const k = (name || '').trim().toLowerCase();
  if (!k) return null;
  if (BY_NAME[k]) return BY_NAME[k];
  // The handful of spellings people actually type, rather than a fuzzy match that could land on
  // the wrong country and silently rewrite an address they already had.
  const alias: Record<string, string> = {
    uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
    usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US', america: 'US', 'united states of america': 'US',
    uae: 'AE', 'south korea': 'KR', 'korea': 'KR', holland: 'NL', turkey: 'TR',
    'ivory coast': 'CI', 'czech republic': 'CZ', swaziland: 'SZ', burma: 'MM',
  };
  return alias[k] ? BY_ISO[alias[k]] : null;
};

/** Free-text search over name, ISO and dial code, ranked so a prefix beats a contains. */
export function searchCountries(q: string): Country[] {
  const k = q.trim().toLowerCase().replace(/^\+/, '');
  if (!k) return COUNTRIES;
  const starts: Country[] = [];
  const has: Country[] = [];
  for (const c of COUNTRIES) {
    const n = c.name.toLowerCase();
    const d = c.dial.slice(1);
    if (n.startsWith(k) || c.iso.toLowerCase() === k || d === k) starts.push(c);
    else if (n.includes(k) || d.startsWith(k)) has.push(c);
  }
  return starts.concat(has);
}
