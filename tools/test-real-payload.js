// The ACTUAL 18 fields our scan reads off the Revolut form (from the live harness), sent to the
// real endpoint as the real user — not a hand-made toy payload.
require('dotenv').config();
const jwt=require('jsonwebtoken');
const FIELDS=[
 {key:'f1',tag:'input',type:'text',label:'Full name',placeholder:'Full name'},
 {key:'f2',tag:'input',type:'text',label:'Email',placeholder:'Email'},
 {key:'f3',tag:'input',type:'button',label:'Search phone country codes',options:['+1','+7','+20','+27','+30','+31','+33','+34','+36','+39','+40','+41','+43','+44','+45','+46','+47','+48','+49','+91'],optionsTruncated:true},
 {key:'f4',tag:'input',type:'tel',label:'Phone number',name:'phoneNumber'},
 {key:'f5',tag:'input',type:'button',label:'Current country',options:['Afghanistan','Albania','Algeria','American Samoa','Andorra','India','Netherlands','United Kingdom','United States'],optionsTruncated:true},
 {key:'f6',tag:'input',type:'button',label:'Preferred work locations',options:['Vienna','Munich']},
 {key:'f7',tag:'input',type:'text',label:'Link to your LinkedIn profile (optional)'},
 {key:'f8',tag:'input',type:'text',label:'Links to your Github, portfolio, etc. (optional)'},
 {key:'f9',tag:'input',type:'button',label:'Select gender you identify with (optional)',options:['Male','Female','Non-binary','Prefer not to say','Other']},
 {key:'f10',tag:'input',type:'button',label:'Select ethnicity (optional)',options:['Asian','Black','Hispanic','White','Mixed','Other','Prefer not to say']},
 {key:'f11',tag:'input',type:'button',label:'1. How did you hear about our job posting? (optional) Select one',options:['LinkedIn','Referral','Job board','Company website','Other']},
 {key:'f12',tag:'input',type:'button',label:'2. Have we met at a conference or event? Tell us which one. (optional) Select one',options:['Yes','No']},
 {key:'f13',tag:'input',type:'button',label:'1. Have you previously been employed by Revolut? Select one',options:['Yes','No']},
 {key:'f14',tag:'input',type:'checkbox',label:'He/him'},
 {key:'f15',tag:'input',type:'checkbox',label:'She/her'},
 {key:'f16',tag:'input',type:'checkbox',label:'They/them'},
 {key:'f17',tag:'input',type:'radio',label:'Yes, I consent'},
 {key:'f18',tag:'input',type:'radio',label:"No, I don't consent"},
];
(async()=>{
 for (const uid of [11, 1]) {
  const token=jwt.sign({id:uid,email:'x@y.z'},process.env.JWT_SECRET);
  const t0=Date.now();
  const r=await fetch('https://cvapplyr-website-production.up.railway.app/api/ai-hub/autofill-map',{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify({fields:FIELDS,jobTitle:'Legal Counsel (Loyalty)',companyName:'Revolut'})});
  const txt=await r.text();
  let j=null; try{j=JSON.parse(txt)}catch{}
  console.log('\n=== user '+uid+' — HTTP '+r.status+' in '+(Date.now()-t0)+'ms ===');
  if(!j){console.log('NON-JSON:',txt.slice(0,300));continue;}
  if(r.status!==200){console.log('ERROR BODY:',txt.slice(0,400));continue;}
  const v=j.values||{}; const sk=j.skipped||{};
  FIELDS.forEach(f=>{
   const got=v[f.key];
   const mark=got!=null?'FILLED':(sk[f.key]?'skip  ':'  --  ');
   console.log('  '+mark+'  '+String(f.label).slice(0,52).padEnd(54)+(got!=null?JSON.stringify(got):(sk[f.key]||'')));
  });
  console.log('  filled '+Object.keys(v).length+'/'+FIELDS.length);
 }
})().catch(e=>{console.error('REQUEST FAILED:',e.message);process.exit(1)});
