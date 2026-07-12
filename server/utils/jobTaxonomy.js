'use strict';
// Deterministic job taxonomy — classify a job (or a résumé title) into a FIELD (department),
// a ROLE CATEGORY (sub-type within the field) and a SENIORITY. NO AI, NO network — pure regex,
// so it is free and instant. Used by the global-job firehose (on ingest + backfill) and to derive
// a user's own field from their résumé, so the Explore feed can show "your field, best matches first".
//
// Design: fields are tested in PRIORITY order (most specific first); first match wins. Within a
// field, role categories are tested in order; first match wins, else a generic "<Field> — General".

// ── seniority ──────────────────────────────────────────────────────────────
function seniority(title) {
  const t = ' ' + String(title || '').toLowerCase() + ' ';
  if (/\b(chief|c[ -]?level|cto|ceo|cfo|coo|cmo|ciso|cpo)\b/.test(t)) return 'C-level';
  if (/\b(svp|evp|vp|vice president|head of)\b/.test(t)) return 'VP / Head';
  if (/\b(director|dir\.)\b/.test(t)) return 'Director';
  if (/\b(senior manager|sr\.? manager)\b/.test(t)) return 'Senior Manager';
  if (/\b(manager|mgr|management)\b/.test(t)) return 'Manager';
  if (/\b(lead|team lead|tech lead|principal|staff)\b/.test(t)) return 'Lead / Principal';
  if (/\b(senior|sr\.?|snr)\b/.test(t)) return 'Senior';
  if (/\b(intern|internship|working student|apprentice|trainee|graduate|new grad)\b/.test(t)) return 'Intern / Grad';
  if (/\b(junior|jr\.?|entry[- ]?level|associate|assistant|i\b|1\b)\b/.test(t)) return 'Junior / Entry';
  return 'Mid';
}

// ── fields + role categories ────────────────────────────────────────────────
// r = [roleCategoryLabel, regex]. The first field whose `any` regex hits claims the title.
const FIELDS = [
  {
    field: 'IT & Software',
    any: /\b(software|developer|dev\b|engineer(ing)?|programmer|member of technical staff|full[- ]?stack|front[- ]?end|back[- ]?end|devops|sre|site reliability|qa\b|q\.?a\.?|quality assurance|sdet|test(er|ing)?|automation|cyber|infosec|security engineer|cloud|platform|infrastructure|data engineer|machine learning|ml engineer|ai engineer|mlops|firmware|embedded|android|ios\b|mobile|web developer|systems? engineer|network engineer|database|dba|solutions engineer|sales engineer|technical support|it support|help ?desk|sysadmin|system administrator|architect|blockchain|game developer|gameplay)/i,
    roles: [
      ['QA / Test', /\b(qa\b|q\.?a\.?|quality assurance|sdet|test(er|ing)?|automation engineer)/i],
      ['DevOps / SRE / Infra', /\b(devops|sre|site reliability|platform engineer|infrastructure|cloud engineer|systems? engineer|network engineer|sysadmin|system administrator)/i],
      ['Security', /\b(security|cyber|infosec|appsec|ciso|penetration|threat)/i],
      ['Data / ML / AI Engineer', /\b(data engineer|machine learning|ml engineer|ai engineer|mlops|ml infra)/i],
      ['Mobile Developer', /\b(android|ios\b|mobile|react native|flutter)/i],
      ['Frontend Developer', /\b(front[- ]?end|ui engineer|web developer|javascript|react|angular|vue)/i],
      ['Backend Developer', /\b(back[- ]?end|api engineer|server|golang|java\b|python|node|ruby|\.net|php)/i],
      ['Full-Stack Developer', /\b(full[- ]?stack)/i],
      ['Architect', /\b(architect)/i],
      ['Solutions / Sales Engineer', /\b(solutions? engineer|sales engineer|pre[- ]?sales|field engineer)/i],
      ['IT Support / Helpdesk', /\b(it support|help ?desk|technical support|desktop support|service desk)/i],
      ['Embedded / Firmware', /\b(firmware|embedded)/i],
      ['Engineering Manager', /\b(engineering manager|software.*manager|manager.*engineering|director.*engineering|vp engineering)/i],
      ['Software Developer', /.*/],
    ],
  },
  {
    field: 'Data, AI & Analytics',
    any: /\b(data scientist|data science|data analyst|analytics|business intelligence|\bbi\b|statistician|quantitative|econometric|research scientist|ai researcher|ml researcher|deep learning|nlp|computer vision|analytics engineer|insights analyst|reporting analyst)/i,
    roles: [
      ['Data Scientist', /\b(data scientist|data science)/i],
      ['ML / AI Researcher', /\b(research scientist|ai researcher|ml researcher|deep learning|nlp|computer vision|research engineer)/i],
      ['Data Analyst', /\b(data analyst|reporting analyst|insights analyst|analytics analyst)/i],
      ['BI / Analytics Engineer', /\b(business intelligence|\bbi\b|analytics engineer|tableau|power ?bi|looker)/i],
      ['Quant / Statistician', /\b(quantitative|statistician|econometric|actuar)/i],
      ['Analytics — General', /.*/],
    ],
  },
  {
    field: 'Product',
    any: /\b(product manager|product owner|product lead|head of product|group product|technical product|product operations|product analyst|cpo)/i,
    roles: [
      ['Product Owner', /\b(product owner|scrum)/i],
      ['Technical Product Manager', /\b(technical product)/i],
      ['Product Operations', /\b(product ops|product operations)/i],
      ['Product Analyst', /\b(product analyst)/i],
      ['Product Manager', /.*/],
    ],
  },
  {
    field: 'Design & UX',
    any: /\b(designer|design lead|ux\b|ui\b|user experience|user interface|creative|graphic|visual|motion|brand designer|product designer|illustrat|art director|industrial design|interaction)/i,
    roles: [
      ['UX / Product Designer', /\b(ux\b|user experience|product designer|interaction)/i],
      ['UI / Visual Designer', /\b(ui\b|user interface|visual|graphic)/i],
      ['Brand / Creative', /\b(brand|creative|art director|motion|illustrat)/i],
      ['UX Research', /\b(ux research|user research|design research)/i],
      ['Industrial Designer', /\b(industrial design)/i],
      ['Designer — General', /.*/],
    ],
  },
  {
    field: 'Sales & Business Development',
    any: /\b(sales|account executive|\bae\b|account manager|business development|\bbd\b|\bbdr\b|\bsdr\b|revenue|quota|inside sales|field sales|enterprise sales|channel|partnership|commercial|closing|prospecting|territory)/i,
    roles: [
      ['SDR / BDR', /\b(sdr|bdr|sales development|business development rep|prospecting|inside sales|lead gen)/i],
      ['Account Executive', /\b(account executive|\bae\b|enterprise sales|closing|quota carrying)/i],
      ['Account Manager', /\b(account manager|relationship manager)/i],
      ['Partnerships / Channel', /\b(partnership|channel|alliance|business development manager)/i],
      ['Sales Manager / Leader', /\b(sales manager|sales director|head of sales|vp sales|revenue|regional sales)/i],
      ['Sales — General', /.*/],
    ],
  },
  {
    field: 'Marketing & Communications',
    any: /\b(marketing|brand\b|content\b|seo\b|sem\b|growth|demand gen|campaign|social media|communications|\bpr\b|public relations|copywriter|community manager|events|digital marketing|product marketing|\bpmm\b|crm marketing|email marketing)/i,
    roles: [
      ['Product Marketing', /\b(product marketing|pmm)/i],
      ['Growth / Demand Gen', /\b(growth|demand gen|performance marketing|acquisition|paid media|sem\b)/i],
      ['Content / SEO', /\b(content|seo\b|copywriter|editor|writer)/i],
      ['Social / Community', /\b(social media|community)/i],
      ['Comms / PR', /\b(communications|\bpr\b|public relations)/i],
      ['Events / Field Marketing', /\b(events|field marketing)/i],
      ['Marketing — General', /.*/],
    ],
  },
  {
    field: 'Finance & Accounting',
    any: /\b(finance|financial|accountant|accounting|accounts payable|accounts receivable|\bap\b|\bar\b|controller|treasury|audit|tax\b|payroll|bookkeep|fp&a|fpa\b|investor relations|revenue accounting|billing|procurement|banking|underwrit|credit analyst|investment)/i,
    roles: [
      ['Accounting / Bookkeeping', /\b(accountant|accounting|bookkeep|accounts payable|accounts receivable|\bap\b|\bar\b|billing|general ledger)/i],
      ['FP&A / Finance Analyst', /\b(fp&a|fpa\b|financial analyst|finance analyst|strategic finance|financial planning)/i],
      ['Controller / Treasury', /\b(controller|treasury)/i],
      ['Audit / Tax', /\b(audit|tax\b)/i],
      ['Payroll', /\b(payroll)/i],
      ['Investment / Banking', /\b(investment|banking|underwrit|credit analyst|investor relations|portfolio)/i],
      ['Procurement', /\b(procurement|purchasing|sourcing)/i],
      ['Finance — General', /.*/],
    ],
  },
  {
    field: 'Human Resources & Recruiting',
    any: /\b(recruit|talent|human resources|\bhr\b|people ops|people operations|people partner|hrbp|compensation|benefits|hiring|sourcer|onboarding|learning and development|l&d|diversity|culture|workforce)/i,
    roles: [
      ['Recruiter / Sourcer', /\b(recruit|sourcer|talent acquisition|hiring)/i],
      ['HR Business Partner', /\b(hrbp|people partner|hr business partner|people ops|people operations)/i],
      ['Comp & Benefits', /\b(compensation|benefits|total rewards)/i],
      ['L&D / Training', /\b(learning and development|l&d|training|enablement)/i],
      ['HR — General', /.*/],
    ],
  },
  {
    field: 'Operations & Strategy',
    any: /\b(operations|\bops\b|business operations|\bbizops\b|strategy|strategic|chief of staff|program manager|project manager|delivery manager|\bpmo\b|process improvement|business analyst|\bba\b|revenue operations|revops|general manager|transformation|continuous improvement|lean|six sigma)/i,
    roles: [
      ['Project / Program Manager', /\b(project manager|program manager|delivery manager|pmo\b|scrum master)/i],
      ['Business Analyst', /\b(business analyst|\bba\b|business systems analyst|requirements)/i],
      ['Revenue / Sales Ops', /\b(revenue operations|revops|sales operations|sales ops)/i],
      ['Strategy / Chief of Staff', /\b(strategy|strategic|chief of staff|corporate development|transformation)/i],
      ['Business Operations', /\b(business operations|bizops|general manager|process|lean|six sigma|continuous improvement)/i],
      ['Operations — General', /.*/],
    ],
  },
  {
    field: 'Customer Support & Success',
    any: /\b(customer success|customer support|customer service|client success|support specialist|support agent|technical account|csm\b|customer experience|\bcx\b|help center|call center|contact center|onboarding specialist|renewals|customer care)/i,
    roles: [
      ['Customer Success Manager', /\b(customer success|client success|csm\b|renewals|technical account manager)/i],
      ['Support Specialist / Agent', /\b(support specialist|support agent|customer support|customer service|help center|call center|contact center|customer care|customer experience|\bcx\b)/i],
      ['Onboarding / Implementation', /\b(onboarding|implementation)/i],
      ['Support — General', /.*/],
    ],
  },
  {
    field: 'Legal & Compliance',
    any: /\b(legal|lawyer|attorney|counsel|paralegal|compliance|regulatory|privacy|contracts|governance|risk\b|aml\b|kyc\b|litigation|intellectual property|patent)/i,
    roles: [
      ['Counsel / Attorney', /\b(counsel|lawyer|attorney|litigation)/i],
      ['Paralegal / Legal Ops', /\b(paralegal|legal ops|legal operations|contracts)/i],
      ['Compliance / Risk', /\b(compliance|regulatory|aml\b|kyc\b|risk\b|governance)/i],
      ['Privacy / IP', /\b(privacy|intellectual property|patent|trademark)/i],
      ['Legal — General', /.*/],
    ],
  },
  {
    field: 'Mechanical / Electrical / Civil Engineering',
    any: /\b(mechanical|electrical|civil|structural|aerospace|aeronautic|hardware engineer|electronics|mechatronic|robotics|hvac|thermal|controls engineer|process engineer|chemical engineer|materials|geotechnical|petroleum|mining engineer|automotive engineer|design engineer|cad\b|solidworks|autocad|\bpe\b license)/i,
    roles: [
      ['Mechanical Engineer', /\b(mechanical|hvac|thermal|mechatronic|automotive engineer)/i],
      ['Electrical / Electronics', /\b(electrical|electronics|power|controls engineer|circuit)/i],
      ['Civil / Structural', /\b(civil|structural|geotechnical|transportation engineer)/i],
      ['Hardware / Robotics', /\b(hardware engineer|robotics|firmware|pcb)/i],
      ['Chemical / Process', /\b(chemical engineer|process engineer|petroleum|refinery)/i],
      ['Aerospace', /\b(aerospace|aeronautic|avionics)/i],
      ['Design / CAD Engineer', /\b(design engineer|cad\b|solidworks|autocad|drafter)/i],
      ['Engineering — General', /.*/],
    ],
  },
  {
    field: 'Manufacturing & Production',
    any: /\b(manufacturing|production|assembly|machinist|fabricat|welder|cnc|plant\b|factory|shop floor|line operator|production supervisor|quality control|\bqc\b|maintenance technician|tool ?maker|foreman|forklift|warehouse operative)/i,
    roles: [
      ['Production Operator', /\b(operator|assembly|line\b|shop floor|production associate)/i],
      ['Machinist / Fabrication', /\b(machinist|cnc|fabricat|welder|tool ?maker)/i],
      ['Quality Control', /\b(quality control|\bqc\b|inspector)/i],
      ['Maintenance Technician', /\b(maintenance|technician|mechanic)/i],
      ['Production Supervisor', /\b(supervisor|foreman|plant manager|production manager)/i],
      ['Manufacturing — General', /.*/],
    ],
  },
  {
    field: 'Supply Chain & Logistics',
    any: /\b(supply chain|logistics|warehouse|inventory|fulfillment|distribution|shipping|freight|transportation|fleet|dispatch|procurement|demand planning|supply planning|customs|import|export|driver\b|courier|last mile|3pl)/i,
    roles: [
      ['Warehouse / Fulfillment', /\b(warehouse|fulfillment|distribution center|picker|packer)/i],
      ['Logistics / Transportation', /\b(logistics|transportation|freight|shipping|fleet|dispatch|last mile|3pl|courier|driver)/i],
      ['Supply / Demand Planning', /\b(demand planning|supply planning|inventory|planner|s&op)/i],
      ['Supply Chain — General', /.*/],
    ],
  },
  {
    field: 'Healthcare & Clinical',
    any: /\b(nurse|nursing|\brn\b|physician|doctor|\bmd\b|clinical|medical|patient|healthcare|health care|pharmac|therapist|therapy|caregiver|dental|dentist|radiolog|surgeon|paramedic|phlebotom|medical assistant|care coordinator|behavioral health|psycholog|counselor|veterinar|optometr)/i,
    roles: [
      ['Nursing', /\b(nurse|nursing|\brn\b|\blpn\b|cna\b)/i],
      ['Physician / Provider', /\b(physician|doctor|\bmd\b|surgeon|provider|practitioner)/i],
      ['Clinical / Allied Health', /\b(clinical|therapist|therapy|radiolog|phlebotom|medical assistant|paramedic|technologist)/i],
      ['Pharmacy', /\b(pharmac)/i],
      ['Behavioral / Mental Health', /\b(behavioral health|psycholog|counselor|social worker)/i],
      ['Care Coordination', /\b(care coordinator|patient|case manager|health coach)/i],
      ['Healthcare — General', /.*/],
    ],
  },
  {
    field: 'Science & Research',
    any: /\b(scientist|research associate|laboratory|lab\b|biolog|chemist|chemistry|biochem|genom|molecular|preclinical|\br&d\b|clinical trial|clinical research|pharmacolog|toxicolog|microbiolog|bioinformatic|assay|formulation|regulatory affairs)/i,
    roles: [
      ['Lab / Research Associate', /\b(research associate|laboratory|lab\b|assay|technician)/i],
      ['Scientist (Bio/Chem)', /\b(scientist|biolog|chemist|chemistry|biochem|molecular|genom|microbiolog|pharmacolog)/i],
      ['Clinical Research', /\b(clinical trial|clinical research|regulatory affairs|cra\b)/i],
      ['Bioinformatics', /\b(bioinformatic|computational biolog)/i],
      ['Research — General', /.*/],
    ],
  },
  {
    field: 'Skilled Trades & Field Service',
    any: /\b(electrician|plumber|carpenter|hvac technician|field service|field technician|installer|lineman|solar installer|construction worker|laborer|roofer|painter|mason|equipment operator|locksmith|technician\b)/i,
    roles: [
      ['Electrician / Plumber', /\b(electrician|plumber|pipefitter)/i],
      ['Field Service Technician', /\b(field service|field technician|installer|service technician)/i],
      ['Construction / Trades', /\b(carpenter|roofer|painter|mason|construction|laborer|equipment operator)/i],
      ['Trades — General', /.*/],
    ],
  },
  {
    field: 'Education & Training',
    any: /\b(teacher|teaching|professor|lecturer|instructor|tutor|educator|curriculum|faculty|principal\b|academic|school\b|trainer|coach\b|education)/i,
    roles: [
      ['Teacher / Instructor', /\b(teacher|teaching|instructor|tutor|lecturer|educator|faculty|professor)/i],
      ['Curriculum / Instructional Design', /\b(curriculum|instructional design|academic)/i],
      ['Trainer / Coach', /\b(trainer|coach\b|enablement)/i],
      ['Education — General', /.*/],
    ],
  },
  {
    field: 'Administrative & Office',
    any: /\b(administrative|admin assistant|executive assistant|office manager|receptionist|clerk|secretary|data entry|coordinator|front desk|scheduler|office administrator)/i,
    roles: [
      ['Executive / Admin Assistant', /\b(executive assistant|administrative assistant|admin assistant|secretary|personal assistant)/i],
      ['Office Manager / Reception', /\b(office manager|receptionist|front desk|office administrator)/i],
      ['Clerk / Data Entry', /\b(clerk|data entry|scheduler|coordinator)/i],
      ['Admin — General', /.*/],
    ],
  },
];

const OTHER = { field: 'Other', role: 'General', roles: [['General', /.*/]] };

// Physical-engineering disciplines share the word "engineer" with IT, but IT is tested first and
// would wrongly claim them. When a title names a physical discipline AND has no software qualifier,
// route it to the Mechanical/Electrical/Civil field before the normal loop.
const PHYS_ENG_DISCIPLINE = /\b(mechanical|electrical|electronic|electronics|civil|structural|aerospace|aeronautic|avionics|mechatronic|hvac|robotics|chemical|biomedical|geotechnical|petroleum|mining|automotive|marine|nuclear|metallurg|thermal|hardware)\b/i;
const SOFTWARE_QUALIFIER = /\b(software|data|devops|sre|cloud|platform|security|network|systems?|frontend|front-end|backend|back-end|full.?stack|\bml\b|\bai\b|qa\b|sales engineer|solutions? engineer|web|firmware|embedded|api|blockchain)\b/i;

// Classify one title → { field, roleCategory, seniority }
function classifyTitle(title) {
  const raw = String(title || '').trim();
  const t = ' ' + raw.toLowerCase() + ' ';
  const sen = seniority(raw);
  if (/\bengineer(ing)?\b/.test(t) && PHYS_ENG_DISCIPLINE.test(t) && !SOFTWARE_QUALIFIER.test(t)) {
    const mech = FIELDS.find((f) => f.field.indexOf('Mechanical') === 0);
    let role = mech.field + ' — General';
    for (const [label, rx] of mech.roles) { if (rx.test(t)) { role = label; break; } }
    return { field: mech.field, roleCategory: role, seniority: sen };
  }
  for (const f of FIELDS) {
    if (f.any.test(t)) {
      let role = f.field + ' — General';
      for (const [label, rx] of f.roles) { if (rx.test(t)) { role = label; break; } }
      return { field: f.field, roleCategory: role, seniority: sen };
    }
  }
  return { field: OTHER.field, roleCategory: 'General', seniority: sen };
}

// Derive a user's primary field from their parsed résumé. Uses job_titles (strongest signal),
// then skills/industries text as a fallback. Returns { field, roleCategory } or null if unknown.
function deriveUserField(resumeMeta) {
  if (!resumeMeta) return null;
  const titles = Array.isArray(resumeMeta.job_titles) ? resumeMeta.job_titles : [];
  const counts = {};       // field → weight
  const roleByField = {};  // field → {role→count}
  const bump = (field, role, w) => {
    counts[field] = (counts[field] || 0) + w;
    (roleByField[field] = roleByField[field] || {});
    roleByField[field][role] = (roleByField[field][role] || 0) + w;
  };
  // most-recent title first → decaying weight
  titles.slice(0, 8).forEach((ti, i) => {
    const c = classifyTitle(ti);
    if (c.field !== 'Other') bump(c.field, c.roleCategory, Math.max(1, 5 - i));
  });
  // fallback: skills + industries text
  if (!Object.keys(counts).length) {
    const skills = [].concat(resumeMeta.skills || [], resumeMeta.industries || []).map((s) => String(s || '').toLowerCase());
    const blob = ' ' + skills.join(' , ') + ' ';
    for (const f of FIELDS) { if (f.any.test(blob)) { bump(f.field, f.field + ' — General', 1); break; } }
  }
  const fields = Object.keys(counts);
  if (!fields.length) return null;
  fields.sort((a, b) => counts[b] - counts[a]);
  const top = fields[0];
  const roles = Object.keys(roleByField[top] || {}).sort((a, b) => roleByField[top][b] - roleByField[top][a]);
  return { field: top, roleCategory: roles[0] || null };
}

const ALL_FIELDS = FIELDS.map((f) => f.field).concat(OTHER.field);

module.exports = { classifyTitle, deriveUserField, seniority, ALL_FIELDS };
