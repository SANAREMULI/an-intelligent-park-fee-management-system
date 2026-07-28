/* ══════════════════════════════════════════════════════════════
   INTELLIGENT PRICING ENGINE
   Rates are per person per day. The engine walks every day of the
   stay, classifies it (season / weekend / public holiday), applies
   the pricing rules, then deducts membership entitlements.
   In production these tables live in the SQL database
   (fee_rates, seasons, public_holidays, pricing_rules) and this
   logic runs server-side — see park_fee_system.sql (MySQL) / park_fee_system_postgres.sql (PostgreSQL).
   ══════════════════════════════════════════════════════════════ */
const BASE_RATES={ kenyan:{adult:1500,child:500}, ea:{adult:3000,child:1000}, nonresident:{adult:9000,child:4500} };
const CATS={kenyan:'Kenyan Citizen',ea:'East African Resident',nonresident:'Non-Resident'};
const VEHICLE_FEE=500; /* per vehicle per day, all categories, never waived */

/* Peak season = the Great Migration window. Multiplier applies to person fees only. */
const SEASONS=[ {name:'Peak Season (Migration)', from:'07-01', to:'10-31', mult:1.5} ];

/* Kenya public holidays. Idd dates depend on moon sighting — update via Settings/DB when gazetted. */
const HOLIDAYS={
  '2026-01-01':"New Year's Day",
  '2026-03-20':'Idd-ul-Fitr',
  '2026-04-03':'Good Friday',
  '2026-04-06':'Easter Monday',
  '2026-05-01':'Labour Day',
  '2026-05-27':'Idd-ul-Adha',
  '2026-06-01':'Madaraka Day',
  '2026-10-10':'Mazingira Day',
  '2026-10-20':'Mashujaa Day',
  '2026-12-12':'Jamhuri Day',
  '2026-12-25':'Christmas Day',
  '2026-12-26':'Boxing Day',
  '2027-01-01':"New Year's Day"
};

/* Day surcharges on person fees. When a day is both a weekend and a holiday,
   the HIGHER surcharge applies (they do not stack). */
const SURCHARGES={ weekend:0.10, holiday:0.20 };

const MEMBER_PLANS=[
  {id:'ANNUAL-IND', name:'Annual Pass — Individual', cat:'kenyan',      price:15000,  months:12, adults:1, children:0, blurb:'Unlimited entry for one Kenyan citizen adult for 12 months.'},
  {id:'ANNUAL-FAM', name:'Annual Pass — Family',     cat:'kenyan',      price:40000,  months:12, adults:2, children:3, blurb:'Unlimited entry for 2 adults and up to 3 children (Kenyan citizens).'},
  {id:'EA-ANNUAL',  name:'Annual Pass — EA Resident',cat:'ea',          price:60000,  months:12, adults:1, children:0, blurb:'Unlimited entry for one East African resident adult for 12 months.'},
  {id:'TOUR-OP',    name:'Tour Operator Pass',       cat:'any',         price:250000, months:12, adults:4, children:0, blurb:'For licensed operators — covers up to 4 guests per visit, any category.'}
];

function pad2(n){return String(n).padStart(2,'0');}
function isoParts(iso){const [y,m,d]=iso.split('-').map(Number);return {y,m,d};}
function dayOfWeek(iso){return new Date(iso+'T00:00:00').getDay();} /* 0=Sun..6=Sat */

/* Classify one calendar day for pricing */
function classifyDay(iso){
  const dow=dayOfWeek(iso);
  const weekend=(dow===0||dow===6);
  const holiday=HOLIDAYS[iso]||null;
  const mmdd=iso.slice(5);
  const season=SEASONS.find(s=>mmdd>=s.from&&mmdd<=s.to)||null;
  let sur=0, surLabel=null;
  if(holiday && SURCHARGES.holiday>=(weekend?SURCHARGES.weekend:0)){ sur=SURCHARGES.holiday; surLabel='Public holiday +'+Math.round(sur*100)+'%'; }
  else if(weekend){ sur=SURCHARGES.weekend; surLabel='Weekend +'+Math.round(sur*100)+'%'; }
  return {iso, weekend, holiday, season, mult:season?season.mult:1, sur, surLabel};
}

/* Build the full quote for a stay.
   opts = {cat, startISO, days, adults, children, vehicle:bool, membership:planObj|null}
   Membership covers up to plan.adults / plan.children per visit when the plan
   category matches the booking category (or plan cat is 'any'). Vehicle is never waived. */
function quoteBooking(opts){
  const rates=BASE_RATES[opts.cat];
  if(!rates) throw new Error('Unknown category '+opts.cat);
  const m=opts.membership && (opts.membership.cat===opts.cat||opts.membership.cat==='any') ? opts.membership : null;
  const covAd=m?Math.min(opts.adults,m.adults):0;
  const covCh=m?Math.min(opts.children,m.children):0;
  const payAd=opts.adults-covAd, payCh=opts.children-covCh;
  const days=[]; let personTotal=0, waived=0, vehicleTotal=0;
  let d=opts.startISO;
  for(let i=0;i<opts.days;i++){
    const c=classifyDay(d);
    const adRate=Math.round(rates.adult*c.mult*(1+c.sur));
    const chRate=Math.round(rates.child*c.mult*(1+c.sur));
    const sub=payAd*adRate+payCh*chRate;
    const wv=covAd*adRate+covCh*chRate;
    const veh=opts.vehicle?VEHICLE_FEE:0;
    days.push({...c, adRate, chRate, sub, veh, waived:wv});
    personTotal+=sub; waived+=wv; vehicleTotal+=veh;
    /* next day */
    const nd=new Date(d+'T00:00:00'); nd.setDate(nd.getDate()+1);
    d=nd.getFullYear()+'-'+pad2(nd.getMonth()+1)+'-'+pad2(nd.getDate());
  }
  const total=personTotal+vehicleTotal;
  return {days, personTotal, vehicleTotal, waived, total,
          coveredAdults:covAd, coveredChildren:covCh,
          payAdults:payAd, payChildren:payCh,
          membership:m?{id:m.id,name:m.name}:null,
          hasModifiers:days.some(x=>x.sur>0||x.mult>1)};
}

/* ── SHA-256 (pure JS, public algorithm) — used to salt-hash passwords.
   Demo-grade only: production must hash server-side with bcrypt/argon2. ── */
function sha256(ascii){
  function rightRotate(v,a){return (v>>>a)|(v<<(32-a));}
  var mathPow=Math.pow, maxWord=mathPow(2,32), result='';
  var words=[], asciiBitLength=ascii.length*8;
  var hash=sha256.h=sha256.h||[], k=sha256.k=sha256.k||[];
  var primeCounter=k.length, isComposite={};
  for(var candidate=2; primeCounter<64; candidate++){
    if(!isComposite[candidate]){
      for(var i=0;i<313;i+=candidate) isComposite[i]=candidate;
      hash[primeCounter]=(mathPow(candidate,.5)*maxWord)|0;
      k[primeCounter++]=(mathPow(candidate,1/3)*maxWord)|0;
    }
  }
  ascii+='\x80';
  while(ascii.length%64-56) ascii+='\x00';
  for(i=0;i<ascii.length;i++){
    var j=ascii.charCodeAt(i);
    if(j>>8) return ''; /* ASCII only — inputs are hex salts + user passwords */
    words[i>>2]|=j<<((3-i)%4)*8;
  }
  words[words.length]=(asciiBitLength/maxWord)|0;
  words[words.length]=asciiBitLength;
  for(j=0;j<words.length;){
    var w=words.slice(j,j+=16), oldHash=hash;
    hash=hash.slice(0,8);
    for(i=0;i<64;i++){
      var w15=w[i-15],w2=w[i-2];
      var a=hash[0],e=hash[4];
      var temp1=hash[7]
        +(rightRotate(e,6)^rightRotate(e,11)^rightRotate(e,25))
        +((e&hash[5])^((~e)&hash[6]))
        +k[i]
        +(w[i]=(i<16)?w[i]:(w[i-16]
          +(rightRotate(w15,7)^rightRotate(w15,18)^(w15>>>3))
          +w[i-7]
          +(rightRotate(w2,17)^rightRotate(w2,19)^(w2>>>10)))|0);
      var temp2=(rightRotate(a,2)^rightRotate(a,13)^rightRotate(a,22))
        +((a&hash[1])^(a&hash[2])^(hash[1]&hash[2]));
      hash=[(temp1+temp2)|0].concat(hash);
      hash[4]=(hash[4]+temp1)|0;
    }
    for(i=0;i<8;i++) hash[i]=(hash[i]+oldHash[i])|0;
  }
  for(i=0;i<8;i++){
    for(j=3;j+1;j--){
      var b=(hash[i]>>(j*8))&255;
      result+=((b<16)?0:'')+b.toString(16);
    }
  }
  return result;
}
function hashPw(salt,pw){return sha256(salt+pw);}
function randSalt(){
  let s='';const c='abcdef0123456789';
  const arr=(typeof crypto!=='undefined'&&crypto.getRandomValues)?crypto.getRandomValues(new Uint8Array(16)):null;
  for(let i=0;i<16;i++) s+=arr?c[arr[i]%16]+c[(arr[i]>>4)%16]:c[Math.floor(Math.random()*16)]+c[Math.floor(Math.random()*16)];
  return s.slice(0,16);
}

let BD={}, curPay='mpesa', curRating=0;

/* Escape everything user-typed before it touches innerHTML (XSS guard) */
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function money(n){return 'KSh '+Math.round(n).toLocaleString();}

/* ── PERSISTENT STORAGE (the "System" — swap for a real database/API in production) ── */
const _mem={};
let _ls=null; try{_ls=window.localStorage;_ls.setItem('__pfms_t','1');_ls.removeItem('__pfms_t');}catch(e){_ls=null;}
const store={
  get(k,d){try{const raw=_ls?_ls.getItem(k):(k in _mem?_mem[k]:null);const v=raw==null?null:JSON.parse(raw);return v==null?d:v}catch(e){return d}},
  set(k,v){const raw=JSON.stringify(v);if(_ls){try{_ls.setItem(k,raw);return}catch(e){}}_mem[k]=raw;},
  del(k){if(_ls){try{_ls.removeItem(k)}catch(e){}}delete _mem[k];}
};
/* Records the exact date & time of every login / registration / booking / check-in */
function logAudit(action,name,email,role){
  const a=store.get('pfms_audit',[]);
  a.unshift({action,name,email,role,at:new Date().toISOString()});
  store.set('pfms_audit',a.slice(0,300));
}
function fmtDT(iso){
  return new Date(iso).toLocaleString('en-KE',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function todayISO(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function addDaysISO(iso,n){
  const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

/* ── AUTH STATE ── */
/* Passwords are never stored — only salt + SHA-256(salt+password).
   Hashes below correspond to the demo credentials shown on the login page. */
const STAFF_USERS={
  'admin@pfms.go.ke':{salt:'a3f19c02d7e845b1',hash:'8563e9f81377b4f6031ee0dec5e843fe5ce50e5e60e0f2c8306cf9c9cab52675',name:'John Sanare',role:'System Administrator',tabs:['overview','tickets','revenue','members','settings','audit']},
  'ranger@pfms.go.ke':{salt:'5c8e2b91f0a4d367',hash:'d481e12281893c34db0bb0f55479072e3705c26741b46874215914b30003b827',name:'Naserian Sopia',role:'Gate Ranger',tabs:['overview','tickets']},
  'finance@pfms.go.ke':{salt:'9d47e1c3b28f0a56',hash:'d2584101f203c7bc44888a52c4fd0c00b863e67030be4f34889735f95378c9c9',name:'Kipchoge Rotich',role:'Finance Officer',tabs:['overview','revenue','members']}
};
let isLoggedIn=false, currentUser=null;   // staff
let clientUser=null, pendingPage=null;    // visitor/client

function go(page){
  if(page==='admin' && !isLoggedIn){ page='login'; }
  if(page==='book' && !clientUser){
    pendingPage='book'; page='clogin';
    showClNotice('err','Please sign in (or create an account) to book a ticket.');
  }
  if(page==='clogin') renderAuthPage();
  document.body.classList.remove('ticket-print-mode');
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav-links a').forEach(a=>a.classList.remove('active'));
  const navKey = (page==='login') ? 'admin' : page;
  const n=document.getElementById('nl-'+navKey); if(n) n.classList.add('active');
  window.scrollTo(0,0);
  if(page==='book') resetBook();
  if(page==='member') renderMemberPage();
  if(page==='admin'){
    renderAdmin();
    startLiveUpdates();
  } else {
    stopLiveUpdates();
  }
}

function togglePw(){
  const f=document.getElementById('lg-pw'), eye=document.getElementById('pw-eye');
  if(f.type==='password'){f.type='text';eye.textContent='hide';}
  else{f.type='password';eye.textContent='show';}
}

/* ── STAFF LOGIN (login date/time recorded to the system audit trail) ── */
function doLogin(){
  const em=document.getElementById('lg-em').value.trim().toLowerCase();
  const pw=document.getElementById('lg-pw').value;
  const err=document.getElementById('lg-err');
  const locks=store.get('pfms_lockouts',{});
  const L=locks[em];
  if(L && L.until && Date.now()<L.until){
    err.textContent='Too many failed attempts — locked for '+Math.ceil((L.until-Date.now())/1000)+'s.';
    err.style.display='block';
    return;
  }
  const u=STAFF_USERS[em];
  const ok=!!(u && pw && hashPw(u.salt,pw)===u.hash);
  if(!ok){
    const n=((L&&!L.until)?L.n:0)+1;
    if(n>=5){locks[em]={n:0,until:Date.now()+60000};logAudit('Staff login locked — 5 failed attempts','—',em,'—');}
    else locks[em]={n,until:0};
    store.set('pfms_lockouts',locks);
    err.textContent='Invalid email or password.'+(n>=5?' Locked for 60 seconds.':'');
    err.style.display='block';
    return;
  }
  delete locks[em]; store.set('pfms_lockouts',locks);
  err.style.display='none';
  isLoggedIn=true;
  currentUser={...u,email:em};
  logAudit('Staff login',u.name,em,u.role);
  if(document.getElementById('lg-remember').checked){
    store.set('pfms_staff_session',{email:em,at:new Date().toISOString()});
  }
  document.getElementById('adm-user-name').textContent=u.name;
  document.getElementById('adm-user-role').textContent=u.role;
  document.getElementById('adm-user-av').textContent=u.name.charAt(0).toUpperCase();
  document.getElementById('nav-user-name').textContent=u.name.split(' ')[0];
  document.getElementById('nl-user-chip').style.display='block';
  document.getElementById('lg-em').value='';
  document.getElementById('lg-pw').value='';
  go('admin');
}

function doLogout(){
  if(currentUser) logAudit('Staff logout',currentUser.name,currentUser.email,currentUser.role);
  isLoggedIn=false;
  currentUser=null;
  store.del('pfms_staff_session');
  stopLiveUpdates();
  document.getElementById('nl-user-chip').style.display='none';
  go('home');
}

/* ── CLIENT AUTH (registration + login, dates recorded to the system) ── */
function authTab(t){
  document.getElementById('at-login').className='auth-tab'+(t==='login'?' active':'');
  document.getElementById('at-reg').className='auth-tab'+(t==='reg'?' active':'');
  document.getElementById('cl-login-form').style.display=t==='login'?'block':'none';
  document.getElementById('cl-reg-form').style.display=t==='reg'?'block':'none';
  hideClNotices();
}
function showClNotice(kind,msg){
  hideClNotices();
  const el=document.getElementById(kind==='err'?'cl-err':'cl-ok');
  if(el){el.textContent=msg;el.style.display='block';}
}
function hideClNotices(){
  ['cl-err','cl-ok'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
}

function cRegister(){
  const fn=document.getElementById('cr-fn').value.trim();
  const ln=document.getElementById('cr-ln').value.trim();
  const em=document.getElementById('cr-em').value.trim().toLowerCase();
  const ph=document.getElementById('cr-ph').value.trim();
  const pw=document.getElementById('cr-pw').value;
  const pw2=document.getElementById('cr-pw2').value;
  if(!fn||!ln||!em||!ph||!pw){showClNotice('err','Please fill in all fields.');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)){showClNotice('err','Please enter a valid email address.');return;}
  if(pw.length<6){showClNotice('err','Password must be at least 6 characters.');return;}
  if(pw!==pw2){showClNotice('err','Passwords do not match.');return;}
  const users=store.get('pfms_users',{});
  if(users[em]){showClNotice('err','An account with this email already exists. Please sign in.');return;}
  const now=new Date().toISOString();
  const salt=randSalt();
  users[em]={name:fn+' '+ln,phone:ph,salt,hash:hashPw(salt,pw),registeredAt:now,lastLoginAt:now};
  store.set('pfms_users',users);
  logAudit('Account registered',fn+' '+ln,em,'Visitor');
  setClientSession(em,users[em]);
  logAudit('Client login',fn+' '+ln,em,'Visitor');
  const dest=pendingPage||'clogin'; pendingPage=null;
  go(dest);
  if(dest==='clogin') showClNotice('ok','Account created — you are now signed in.');
}

function cLogin(){
  const em=document.getElementById('cl-em').value.trim().toLowerCase();
  const pw=document.getElementById('cl-pw').value;
  const users=store.get('pfms_users',{});
  const u=users[em];
  let ok=false;
  if(u&&pw){
    if(u.hash) ok=hashPw(u.salt,pw)===u.hash;
    else if(u.pass===pw){ /* migrate legacy plaintext account to salted hash */
      const salt=randSalt(); u.salt=salt; u.hash=hashPw(salt,pw); delete u.pass; ok=true;
    }
  }
  if(!ok){showClNotice('err','Invalid email or password. New here? Create an account.');return;}
  u.lastLoginAt=new Date().toISOString();   // correct login date recorded to the system
  store.set('pfms_users',users);
  logAudit('Client login',u.name,em,'Visitor');
  setClientSession(em,u);
  document.getElementById('cl-em').value='';
  document.getElementById('cl-pw').value='';
  const dest=pendingPage||'clogin'; pendingPage=null;
  go(dest);
}

function setClientSession(email,u){
  clientUser={email,name:u.name,phone:u.phone,registeredAt:u.registeredAt,lastLoginAt:u.lastLoginAt};
  store.set('pfms_client_session',{email,at:new Date().toISOString()});
  updateClientNav();
}

function cLogout(){
  if(clientUser) logAudit('Client logout',clientUser.name,clientUser.email,'Visitor');
  clientUser=null;
  store.del('pfms_client_session');
  updateClientNav();
  go('home');
}

function updateClientNav(){
  const chip=document.getElementById('nl-client-chip');
  const auth=document.getElementById('nl-auth');
  if(clientUser){
    chip.style.display='block';
    auth.style.display='none';
    document.getElementById('nav-client-name').textContent=clientUser.name.split(' ')[0];
  } else {
    chip.style.display='none';
    auth.style.display='block';
  }
}

function renderAuthPage(){
  const authView=document.getElementById('cl-auth-view');
  const acctView=document.getElementById('cl-account-view');
  if(!clientUser){
    authView.style.display='block'; acctView.style.display='none';
    document.getElementById('cl-hdr-ttl').textContent='Visitor Sign In';
    document.getElementById('cl-hdr-sub').textContent='Sign in or create a free account to book and manage your Maasai Mara tickets.';
    return;
  }
  authView.style.display='none'; acctView.style.display='block';
  document.getElementById('cl-hdr-ttl').textContent='My Account';
  document.getElementById('cl-hdr-sub').textContent='Your profile, membership, sign-in history and tickets.';
  const myBookings=store.get('pfms_bookings',[]).filter(b=>b.userEmail===clientUser.email);
  const act=activeMembershipFor(clientUser.email);
  document.getElementById('cl-account-box').innerHTML=`
    <div class="login-icon">👤</div>
    <h3>${esc(clientUser.name)}</h3>
    <div class="login-sub">${esc(clientUser.email)}</div>
    <div class="acct-row"><span>Phone</span><span>${esc(clientUser.phone||'—')}</span></div>
    <div class="acct-row"><span>Registered on</span><span>${fmtDT(clientUser.registeredAt)}</span></div>
    <div class="acct-row"><span>Last login</span><span>${fmtDT(clientUser.lastLoginAt)}</span></div>
    ${act?`<div class="mcard">
        <div class="mc-plan">🎟️ ${esc(act.name)}</div>
        <div class="mc-row"><span>Member No.</span><span>${esc(act.no)}</span></div>
        <div class="mc-row"><span>Covers per visit</span><span>${act.adults} adult(s)${act.children?' + '+act.children+' child(ren)':''}</span></div>
        <div class="mc-row"><span>Expires</span><span>${fmtDT(act.expiresAt).split(',')[0]}</span></div>
        <div style="font-size:.7rem;color:rgba(255,255,255,.55);margin-top:10px">Applied automatically when you book — covered visitors enter free.</div>
      </div>`
     :`<div style="background:var(--cream);border-radius:10px;padding:12px 14px;font-size:.8rem;color:var(--tm);margin-top:14px;text-align:left">No annual pass on this account. <a onclick="go('member')" style="color:var(--gd);font-weight:600;cursor:pointer;text-decoration:underline">View membership plans →</a></div>`}
    <div style="text-align:left;margin-top:22px;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em">My Tickets (${myBookings.length})</div>
    ${myBookings.length?myBookings.map(b=>`
      <div class="my-bk">
        <strong>${esc(b.ref)}</strong> — ${esc(b.catLabel)}<br>
        Visit: ${esc(b.date)} · ${b.dy} day(s) · ${b.ad} adult(s), ${b.ch} child(ren)<br>
        ${money(b.tot)} · ${esc(b.payMethod)} · ${esc(b.status)}${b.checkedIn?' · ✅ Checked in':''}${b.memberSaved?` · <span style="color:#16a34a">pass saved ${money(b.memberSaved)}</span>`:''}<br>
        <button class="btn-back" style="margin-top:9px;padding:6px 14px;font-size:.74rem" onclick="viewTicket('${esc(b.ref)}')">🎫 View / Print Ticket</button>
      </div>`).join('')
      :'<div class="my-bk" style="color:var(--tm)">No tickets yet — book your first visit!</div>'}
    <div style="display:flex;gap:10px;margin-top:24px">
      <button class="btn-primary" style="flex:1" onclick="go('book')">Book a Ticket</button>
      <button class="btn-back" style="flex:1" onclick="cLogout()">Sign Out</button>
    </div>`;
}

function toggleMenu(){
  const nl=document.getElementById('navLinks');
  if(nl.style.display==='flex'){nl.style.cssText=''}
  else{nl.style.cssText='display:flex;flex-direction:column;position:absolute;top:70px;left:0;right:0;background:rgba(13,40,24,.98);padding:20px 5%;gap:14px;z-index:999'}
}

function resetBook(){
  ['bs1','bs2','bs3','bs4'].forEach((id,i)=>document.getElementById(id).style.display=i===0?'block':'none');
  ['s1','s2','s3','s4'].forEach((id,i)=>document.getElementById(id).className='step'+(i===0?' active':''));
  if(clientUser){  // prefill from the signed-in account
    const parts=clientUser.name.split(' ');
    const fn=document.getElementById('b-fn'), ln=document.getElementById('b-ln');
    if(!fn.value) fn.value=parts[0]||'';
    if(!ln.value) ln.value=parts.slice(1).join(' ')||'';
    const em=document.getElementById('b-em'); if(!em.value) em.value=clientUser.email;
    const ph=document.getElementById('b-ph'); if(!ph.value) ph.value=clientUser.phone||'';
    const mp=document.getElementById('b-mp'); if(!mp.value) mp.value=clientUser.phone||'';
  }
}

function bNext(to){
  if(to===2){
    const cat=document.getElementById('b-cat').value;
    if(!document.getElementById('b-fn').value||!document.getElementById('b-ln').value||!cat||!document.getElementById('b-dt').value||!document.getElementById('b-id').value||!document.getElementById('b-ph').value){alert('Please fill in all required fields (name, phone, category, ID/passport and visit date).');return;}
    if(document.getElementById('b-dt').value<todayISO()){alert('Visit date cannot be in the past.');return;}
    const ad=Math.max(1,parseInt(document.getElementById('b-ad').value)||1);
    const ch=Math.max(0,parseInt(document.getElementById('b-ch').value)||0);
    const dy=parseInt(document.getElementById('b-dy').value)||1;
    const veh=document.getElementById('b-veh').value.trim();
    const startISO=document.getElementById('b-dt').value;
    const membership=clientUser?activeMembershipFor(clientUser.email):null;
    const q=quoteBooking({cat,startISO,days:dy,adults:ad,children:ch,vehicle:!!veh,membership});
    BD={name:document.getElementById('b-fn').value+' '+document.getElementById('b-ln').value,
        email:document.getElementById('b-em').value,phone:document.getElementById('b-ph').value,
        cat,catLabel:CATS[cat],id:document.getElementById('b-id').value,
        date:startISO,dy,ad,ch,veh,tot:q.total,quote:q};
    document.getElementById('sum-tbl').innerHTML=
      `<tr><td style="color:var(--tm)">Visitor</td><td>${esc(BD.name)}</td></tr>
       <tr><td style="color:var(--tm)">Category</td><td>${esc(BD.catLabel)}</td></tr>
       <tr><td style="color:var(--tm)">Visit Date</td><td>${esc(BD.date)} · ${dy} day(s)</td></tr>
       <tr><td style="color:var(--tm)">Person fees (${q.payAdults} adult(s), ${q.payChildren} child(ren) billed)</td><td>${money(q.personTotal)}</td></tr>
       ${q.waived?`<tr class="waive-row"><td>Annual pass — ${esc(q.membership.name)} (covers ${q.coveredAdults} adult(s)${q.coveredChildren?' + '+q.coveredChildren+' child(ren)':''})</td><td>− ${money(q.waived)}</td></tr>`:''}
       ${veh?`<tr><td style="color:var(--tm)">Vehicle (${esc(veh)}) × ${dy} day(s)</td><td>${money(q.vehicleTotal)}</td></tr>`:''}
       <tr class="total-row"><td><strong>Total</strong></td><td><strong>${money(q.total)}</strong></td></tr>`;
    const bk=document.getElementById('day-breakdown');
    if(q.hasModifiers||dy>1){
      bk.innerHTML=`<table class="day-bk">
        <tr><th>Day</th><th>Pricing applied</th><th>Adult rate</th><th>Child rate</th><th>Subtotal</th></tr>
        ${q.days.map(d=>{
          const tags=[];
          if(d.season) tags.push('<span class="tagb peak">'+esc(d.season.name)+' ×'+d.season.mult+'</span>');
          if(d.holiday) tags.push('<span class="tagb hol">'+esc(d.holiday)+' +'+Math.round(SURCHARGES.holiday*100)+'%</span>');
          else if(d.weekend) tags.push('<span class="tagb wknd">Weekend +'+Math.round(SURCHARGES.weekend*100)+'%</span>');
          if(!tags.length) tags.push('<span class="tagb std">Standard rate</span>');
          return `<tr><td>${d.iso}</td><td>${tags.join(' ')}</td><td>${money(d.adRate)}</td><td>${money(d.chRate)}</td><td>${money(d.sub+d.veh)}</td></tr>`;
        }).join('')}
      </table>
      <p style="font-size:.72rem;color:var(--tm);margin-top:8px">Fees are calculated automatically per day — season, weekends and Kenyan public holidays are detected by the system. When a day is both a weekend and a public holiday, only the higher surcharge applies.</p>`;
    } else {
      bk.innerHTML='<p style="font-size:.76rem;color:var(--tm);margin-top:10px">Standard low-season weekday rates apply for your dates — no surcharges.</p>';
    }
    document.getElementById('pay-tot').textContent=money(q.total);
  }
  ['bs1','bs2','bs3','bs4'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('bs'+to).style.display='block';
  document.body.classList.toggle('ticket-print-mode', to===4);
  ['s1','s2','s3','s4'].forEach((id,i)=>{
    const el=document.getElementById(id);
    el.className='step'+(i<to-1?' done':i===to-1?' active':'');
  });
  window.scrollTo(0,0);
}

function selPay(m){
  curPay=m;
  ['mpesa','airtel','card','cash'].forEach(x=>{
    document.getElementById('po-'+x).className='pay-opt'+(x===m?' sel':'');
    document.getElementById('pf-'+x).style.display=x===m?'block':'none';
  });
}

/* ── PAYMENT LAYER ──
   One set of simulators serves both gate bookings and membership sales.
   PRODUCTION: the browser never talks to Safaricom / Airtel / the card
   network directly — credentials would leak. The backend exposes:
     POST /api/payments/mpesa/stkpush   -> Daraja OAuth + STK push, result lands on your CallBackURL
     POST /api/payments/airtel/push     -> Airtel Money OpenAPI collection request + callback
     POST /api/payments/card/checkout   -> hosted gateway page (Pesapal / Flutterwave / DPO); card data never touches this system (PCI-DSS)
   Each callback writes to the payments + *_transactions tables in park_fee_system.sql (MySQL) / park_fee_system_postgres.sql (PostgreSQL),
   keyed by an idempotency token so a replayed callback cannot double-credit. */
function normalizeMsisdn(v){
  v=(v||'').replace(/[\s\-()]/g,'');
  if(/^\+?254(7|1)\d{8}$/.test(v)) return v.replace(/^\+/,'');
  if(/^0(7|1)\d{8}$/.test(v)) return '254'+v.slice(1);
  return null;
}
function genMpesaReceipt(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ123456789';let r='S';
  for(let i=0;i<9;i++) r+=c[Math.floor(Math.random()*c.length)];
  return r;
}
function genAirtelReceipt(){
  let r='AM';
  for(let i=0;i<10;i++) r+=Math.floor(Math.random()*10);
  return r;
}
function nextRef(){
  const c=store.get('pfms_ref_counter',900000)+1;
  store.set('pfms_ref_counter',c);
  return 'PFMS-2026-'+String(c).padStart(6,'0');
}
function stkModal(html){
  document.getElementById('stk-body').innerHTML=html;
  document.getElementById('stk-modal').classList.add('open');
}
function closeStk(){document.getElementById('stk-modal').classList.remove('open');}
let stkTimer=null;
function cancelStk(){
  if(stkTimer){clearTimeout(stkTimer);stkTimer=null;}
  closeStk();
  alert('Payment cancelled — nothing has been charged.');
}

function simMobileMoney(brand,msisdn,amount,onOk){
  const masked='+'+msisdn.slice(0,6)+'•••'+msisdn.slice(-3);
  const isMpesa=brand==='M-Pesa';
  stkModal(`<div class="spinner"></div><h4>Sending ${isMpesa?'STK push':'payment prompt'}…</h4><p>Initiating ${brand} request to <strong>${masked}</strong></p>`);
  stkTimer=setTimeout(()=>{
    stkModal(`<div class="spinner"></div><h4>Check your phone 📱</h4>
      <p>A ${brand} payment request has been sent to <strong>${masked}</strong>.</p>
      <div class="stk-amt">${money(amount)}</div>
      <p>Enter your ${brand} PIN on your phone to authorise payment to <strong>Maasai Mara PFMS</strong>.</p>
      <button class="btn-back" style="margin-top:18px" onclick="cancelStk()">Cancel Payment</button>`);
    stkTimer=setTimeout(()=>{
      const receipt=isMpesa?genMpesaReceipt():genAirtelReceipt();
      stkModal(`<div class="suc-icon" style="margin-bottom:16px">✅</div><h4>Payment Received</h4>
        <p>${brand} confirmation: <strong>${receipt}</strong><br>${money(amount)} received from ${masked}.</p>`);
      stkTimer=setTimeout(()=>{
        closeStk();
        onOk({method:brand,phone:msisdn,receipt});
      },1600);
    },4500);
  },1800);
}
function simCard(amount,onOk){
  stkModal(`<div class="spinner"></div><h4>Processing card payment…</h4><p>Contacting your bank for ${money(amount)}. Please wait.</p>`);
  stkTimer=setTimeout(()=>{closeStk();onOk({method:'Card',receipt:'CARD-'+Date.now().toString().slice(-8)});},2200);
}

function confirmBooking(){
  if(!BD.quote){alert('Please complete the booking details first.');return;}
  if(BD.tot===0){ /* fully covered by an annual pass, no vehicle — nothing to charge */
    finalizeBooking({method:'Annual Pass',receipt:null,status:'Paid'});
    return;
  }
  if(curPay==='mpesa'){
    const m=normalizeMsisdn(document.getElementById('b-mp').value);
    if(!m){alert('Please enter a valid M-Pesa number, e.g. 07XX XXX XXX or +2547XX XXX XXX.');return;}
    simMobileMoney('M-Pesa',m,BD.tot,pay=>finalizeBooking({...pay,status:'Paid'}));
  } else if(curPay==='airtel'){
    const m=normalizeMsisdn(document.getElementById('b-am').value);
    if(!m){alert('Please enter a valid Airtel Money number, e.g. 073X / 075X / 078X XXX XXX.');return;}
    simMobileMoney('Airtel Money',m,BD.tot,pay=>finalizeBooking({...pay,status:'Paid'}));
  } else if(curPay==='card'){
    simCard(BD.tot,pay=>finalizeBooking({...pay,status:'Paid'}));
  } else {
    finalizeBooking({method:'Cash at Gate',receipt:null,status:'Reserved'});
  }
}

function finalizeBooking(pay){
  const ref=nextRef();
  const paid=pay.status==='Paid';
  const q=BD.quote||{};
  const booking={
    ref,userEmail:clientUser?clientUser.email:BD.email,
    name:BD.name,email:BD.email,phone:BD.phone,idNo:BD.id,
    cat:BD.cat,catLabel:BD.catLabel,date:BD.date,dy:BD.dy,ad:BD.ad,ch:BD.ch,veh:BD.veh,
    tot:BD.tot,payMethod:pay.method,receipt:pay.receipt||null,
    memberSaved:q.waived||0,memberPlan:q.membership?q.membership.name:null,
    status:pay.status,paidAt:paid?new Date().toISOString():null,
    checkedIn:false,checkedInAt:null,
    bookedAt:new Date().toISOString()
  };
  const all=store.get('pfms_bookings',[]);
  all.unshift(booking);
  store.set('pfms_bookings',all);
  logAudit('Booking '+(paid?'paid via '+pay.method:'reserved (cash at gate)')+' · '+ref,BD.name,booking.userEmail,'Visitor');
  renderTicket(booking);
  bNext(4);
}

/* ── MEMBERSHIP SALES ── */
function memberNoNext(){
  const c=store.get('pfms_member_counter',100)+1;
  store.set('pfms_member_counter',c);
  return 'MMP-2026-'+String(c).padStart(4,'0');
}
function activeMembershipFor(email){
  if(!email) return null;
  const now=Date.now();
  const ms=store.get('pfms_memberships',[]).filter(m=>m.email===email && new Date(m.expiresAt).getTime()>now);
  if(!ms.length) return null;
  ms.sort((a,b)=>new Date(b.expiresAt)-new Date(a.expiresAt));
  const rec=ms[0];
  const plan=MEMBER_PLANS.find(p=>p.id===rec.planId);
  return plan?{...plan,no:rec.no,expiresAt:rec.expiresAt}:null;
}
function renderMemberPage(){
  const grid=document.getElementById('plan-grid');
  const wrap=document.getElementById('member-active-wrap');
  const act=clientUser?activeMembershipFor(clientUser.email):null;
  wrap.style.display=act?'block':'none';
  if(act){
    wrap.innerHTML=`<div class="mcard">
      <div class="mc-plan">🎟️ ${esc(act.name)}</div>
      <div class="mc-row"><span>Holder</span><span>${esc(clientUser.name)}</span></div>
      <div class="mc-row"><span>Member No.</span><span>${esc(act.no)}</span></div>
      <div class="mc-row"><span>Covers per visit</span><span>${act.adults} adult(s)${act.children?' + '+act.children+' child(ren)':''}</span></div>
      <div class="mc-row"><span>Expires</span><span>${fmtDT(act.expiresAt).split(',')[0]}</span></div>
      <div style="font-size:.7rem;color:rgba(255,255,255,.55);margin-top:10px">Your pass is applied automatically at booking — covered visitors pay KSh 0 entry.</div>
    </div>`;
  }
  grid.innerHTML=MEMBER_PLANS.map(p=>`<div class="plan-card${p.id==='ANNUAL-FAM'?' feat':''}">
    <div class="plan-cat">${p.cat==='any'?'All categories':esc(CATS[p.cat])}</div>
    <div class="plan-nm">${esc(p.name)}</div>
    <div class="plan-pr">${money(p.price)} <span>/ 12 months</span></div>
    <p class="plan-blurb">${esc(p.blurb)}</p>
    <div class="plan-cov">Covers ${p.adults} adult(s)${p.children?' + '+p.children+' child(ren)':''} per visit · vehicle fees excluded</div>
    <button class="btn-primary" ${act?'disabled style="opacity:.5;cursor:not-allowed"':''} onclick="buyPlan('${p.id}')">${act?'Pass already active':'Buy this pass'}</button>
  </div>`).join('');
}
function buyPlan(id){
  if(!clientUser){
    pendingPage='member';
    go('clogin');
    showClNotice('err','Please sign in (or create an account) to buy an annual pass.');
    return;
  }
  if(activeMembershipFor(clientUser.email)){alert('This account already has an active pass.');return;}
  const p=MEMBER_PLANS.find(x=>x.id===id);
  if(p) openMemberPay(p);
}
let memPay={method:'mpesa',plan:null};
function openMemberPay(p){
  memPay={method:'mpesa',plan:p};
  stkModal(`<h4 style="margin-bottom:4px">${esc(p.name)}</h4>
    <div class="stk-amt">${money(p.price)}</div>
    <div class="pay-opts" style="grid-template-columns:repeat(3,1fr);margin:14px 0">
      <div class="pay-opt sel" id="mp-mpesa" onclick="memMethod('mpesa')"><div class="ico">📱</div><div class="nm">M-Pesa</div></div>
      <div class="pay-opt" id="mp-airtel" onclick="memMethod('airtel')"><div class="ico">📲</div><div class="nm">Airtel Money</div></div>
      <div class="pay-opt" id="mp-card" onclick="memMethod('card')"><div class="ico">💳</div><div class="nm">Card</div></div>
    </div>
    <div class="form-group" id="mp-phone-wrap" style="text-align:left"><label>Mobile money number</label><input type="tel" id="mp-phone" value="${esc(clientUser.phone||'')}" placeholder="07XX XXX XXX"></div>
    <div style="display:flex;gap:10px;margin-top:6px">
      <button class="btn-back" style="flex:1" onclick="closeStk()">Cancel</button>
      <button class="btn-primary" style="flex:1" onclick="payMembership()">Pay ${money(p.price)}</button>
    </div>`);
}
function memMethod(m){
  memPay.method=m;
  ['mpesa','airtel','card'].forEach(x=>{const el=document.getElementById('mp-'+x);if(el)el.className='pay-opt'+(x===m?' sel':'');});
  const pw=document.getElementById('mp-phone-wrap');
  if(pw) pw.style.display=m==='card'?'none':'block';
}
function payMembership(){
  const p=memPay.plan; if(!p) return;
  if(memPay.method==='card'){simCard(p.price,pay=>finalizeMembership(p,pay));return;}
  const m=normalizeMsisdn(document.getElementById('mp-phone').value);
  if(!m){alert('Please enter a valid Kenyan mobile number.');return;}
  simMobileMoney(memPay.method==='mpesa'?'M-Pesa':'Airtel Money',m,p.price,pay=>finalizeMembership(p,pay));
}
function finalizeMembership(p,pay){
  const exp=new Date(); exp.setMonth(exp.getMonth()+p.months);
  const rec={no:memberNoNext(),email:clientUser.email,name:clientUser.name,
    planId:p.id,planName:p.name,price:p.price,method:pay.method,receipt:pay.receipt||null,
    purchasedAt:new Date().toISOString(),expiresAt:exp.toISOString()};
  const all=store.get('pfms_memberships',[]);
  all.unshift(rec);
  store.set('pfms_memberships',all);
  logAudit('Membership purchased · '+rec.no+' ('+p.name+') via '+pay.method,clientUser.name,clientUser.email,'Visitor');
  stkModal(`<div class="suc-icon" style="margin-bottom:12px">🎟️</div><h4>Karibu, pass holder!</h4>
    <div class="mcard">
      <div class="mc-plan">${esc(p.name)}</div>
      <div class="mc-row"><span>Holder</span><span>${esc(clientUser.name)}</span></div>
      <div class="mc-row"><span>Member No.</span><span>${esc(rec.no)}</span></div>
      <div class="mc-row"><span>Paid</span><span>${money(p.price)} · ${esc(pay.method)}${pay.receipt?' · '+esc(pay.receipt):''}</span></div>
      <div class="mc-row"><span>Expires</span><span>${fmtDT(rec.expiresAt).split(',')[0]}</span></div>
    </div>
    <button class="btn-primary" style="width:100%;margin-top:16px" onclick="closeStk();renderMemberPage()">Done</button>`);
}

/* ── TICKET PREVIEW (shared by new bookings and reprints from My Account) ── */
function renderTicket(b){
  document.getElementById('tkt-ref').textContent=b.ref;
  document.getElementById('tkt-body').innerHTML=
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:.84rem">
      <div><span style="color:var(--tm)">Visitor</span><br><strong>${esc(b.name)}</strong></div>
      <div><span style="color:var(--tm)">ID / Passport</span><br><strong>${esc(b.idNo||'—')}</strong></div>
      <div><span style="color:var(--tm)">Category</span><br><strong>${esc(b.catLabel)}</strong></div>
      <div><span style="color:var(--tm)">Party</span><br><strong>${b.ad} adult(s), ${b.ch} child(ren)${b.veh?' · '+esc(b.veh):''}</strong></div>
      <div><span style="color:var(--tm)">Visit Date</span><br><strong>${esc(b.date)}</strong></div>
      <div><span style="color:var(--tm)">Valid Until</span><br><strong>${addDaysISO(b.date,b.dy-1)} (${b.dy} day(s))</strong></div>
      <div><span style="color:var(--tm)">${b.status==='Paid'?'Total Paid':'Amount Due at Gate'}</span><br><strong style="color:var(--gd)">${money(b.tot)}</strong></div>
      <div><span style="color:var(--tm)">Payment</span><br><strong>${esc(b.payMethod)}${b.receipt?' · '+esc(b.receipt):''} — ${esc(b.status)}</strong></div>
      ${b.memberPlan?`<div style="grid-column:1/-1"><span style="color:var(--tm)">Annual Pass</span><br><strong style="color:#16a34a">${esc(b.memberPlan)} applied — saved ${money(b.memberSaved)}</strong></div>`:''}
    </div>
    <div style="text-align:center;font-family:'Playfair Display',serif;font-size:1.15rem;font-weight:700;color:var(--gd);margin-top:18px">Karibu Maasai Mara!</div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--cream-d);display:flex;justify-content:space-between;font-size:.72rem;color:var(--tm)">
      <span>📍 Sekenani Gate, Narok County</span><span>Issued ${fmtDT(b.bookedAt)}</span>
    </div>`;
  renderTicketQR(b.ref);
}

function renderTicketQR(ref){
  const el=document.getElementById('tkt-qr');
  if(window.qrcode){
    try{
      const qr=window.qrcode(0,'M');
      qr.addData(ref);
      qr.make();
      el.innerHTML=qr.createSvgTag({cellSize:3,margin:1,scalable:true});
      el.classList.add('qr-real');
      return;
    }catch(e){/* fall through to text fallback */}
  }
  el.classList.remove('qr-real');
  el.innerHTML='<span style="font-size:10px;padding:4px">'+ref+'</span>';
}

function viewTicket(ref){
  const b=store.get('pfms_bookings',[]).find(x=>x.ref===ref);
  if(!b) return;
  go('book');
  renderTicket(b);
  bNext(4);
}

/* ── STRICT TICKET VERIFICATION ──
   A ticket is only valid if it exists in the system's booking records,
   AND today falls within the booked visit dates, AND payment is complete. */
function vBox(r,color,bg,border,html){
  r.style.cssText=`display:block;margin-top:22px;padding:18px;border-radius:10px;text-align:left;background:${bg};border:1px solid ${border}`;
  r.innerHTML=html;
}
function doVerify(){
  const ref=document.getElementById('v-ref').value.trim().toUpperCase();
  const r=document.getElementById('v-result');
  if(!ref){alert('Please enter a ticket reference.');return;}
  const b=store.get('pfms_bookings',[]).find(x=>x.ref===ref);
  if(!b){
    vBox(r,'#dc2626','#fee2e2','#dc2626',
      `<div style="color:#dc2626;font-weight:600;font-size:.95rem;margin-bottom:8px">❌ Invalid Ticket</div>
       <div style="font-size:.85rem">Reference <strong>${esc(ref)}</strong> does not exist in the booking system. This ticket is not genuine — do not admit.</div>`);
    return;
  }
  const start=b.date, end=addDaysISO(b.date,b.dy-1), today=todayISO();
  const details=`<div style="font-size:.85rem;margin-top:10px"><strong>Reference:</strong> ${esc(b.ref)}<br>
    <strong>Visitor:</strong> ${esc(b.name)}<br><strong>ID/Passport:</strong> ${esc(b.idNo||'—')}<br>
    <strong>Category:</strong> ${esc(b.catLabel)}<br><strong>Party:</strong> ${b.ad} adult(s), ${b.ch} child(ren)${b.veh?' · Vehicle '+esc(b.veh):''}<br>
    <strong>Valid:</strong> ${esc(start)}${b.dy>1?' to '+end:''} (${b.dy} day(s))<br>
    <strong>Payment:</strong> ${esc(b.payMethod)}${b.receipt?' · '+esc(b.receipt):''} — ${esc(b.status)}<br>
    ${b.memberPlan?'<strong>Annual pass:</strong> '+esc(b.memberPlan)+' (saved '+money(b.memberSaved)+')<br>':''}
    <strong>Booked on:</strong> ${fmtDT(b.bookedAt)}</div>`;

  if(b.status!=='Paid'){
    vBox(r,'#ca8a04','#fef9c3','#ca8a04',
      `<div style="color:#ca8a04;font-weight:600;font-size:.95rem">⚠️ Payment Pending — Cash at Gate</div>
       <div style="font-size:.85rem;margin-top:6px">Genuine booking, but <strong>${money(b.tot)}</strong> must be collected before entry.</div>${details}
       <button class="btn-primary" style="width:100%;margin-top:14px" onclick="collectCash('${esc(b.ref)}')">Record Cash Payment (${money(b.tot)})</button>`);
    return;
  }
  if(today<start){
    vBox(r,'#ca8a04','#fef9c3','#ca8a04',
      `<div style="color:#ca8a04;font-weight:600;font-size:.95rem">⚠️ Not Valid Today</div>
       <div style="font-size:.85rem;margin-top:6px">This is a genuine ticket, but it is only valid from <strong>${esc(start)}</strong>. Today is ${today}.</div>${details}`);
    return;
  }
  if(today>end){
    vBox(r,'#dc2626','#fee2e2','#dc2626',
      `<div style="color:#dc2626;font-weight:600;font-size:.95rem">❌ Ticket Expired</div>
       <div style="font-size:.85rem;margin-top:6px">This ticket was valid ${esc(start)}${b.dy>1?' to '+end:''} and has expired. Do not admit.</div>${details}`);
    return;
  }
  if(b.checkedIn){
    vBox(r,'#ca8a04','#fef9c3','#ca8a04',
      `<div style="color:#ca8a04;font-weight:600;font-size:.95rem">⚠️ Already Checked In</div>
       <div style="font-size:.85rem;margin-top:6px">This ticket was already used for entry on <strong>${fmtDT(b.checkedInAt)}</strong>.</div>${details}`);
    return;
  }
  vBox(r,'#16a34a','#dcfce7','#16a34a',
    `<div style="color:#16a34a;font-weight:600;font-size:.95rem">✅ Valid Ticket — Genuine Booking</div>
     <div style="font-size:.85rem;margin-top:6px">Valid for entry today (${today}). Payment confirmed.</div>${details}
     <button class="btn-primary" style="width:100%;margin-top:14px" onclick="checkInTicket('${esc(b.ref)}')">✓ Check In Visitor Now</button>`);
}

function checkInTicket(ref){
  const all=store.get('pfms_bookings',[]);
  const b=all.find(x=>x.ref===ref);
  if(!b) return;
  b.checkedIn=true;
  b.checkedInAt=new Date().toISOString();
  store.set('pfms_bookings',all);
  logAudit('Gate check-in · '+ref,b.name,b.userEmail,'Visitor');
  doVerify();
}

function collectCash(ref){
  const all=store.get('pfms_bookings',[]);
  const b=all.find(x=>x.ref===ref);
  if(!b) return;
  b.status='Paid';
  b.payMethod='Cash at Gate';
  b.paidAt=new Date().toISOString();
  store.set('pfms_bookings',all);
  logAudit('Cash payment collected · '+ref,b.name,b.userEmail,'Visitor');
  doVerify();
}

function rate(n){
  curRating=n;
  document.querySelectorAll('.star').forEach((s,i)=>s.className='star'+(i<n?' on':''));
}

function doFeedback(){
  if(!curRating){alert('Please select a star rating.');return;}
  const rec={rating:curRating,
    name:document.getElementById('fb-name').value.trim(),
    visit:document.getElementById('fb-dt').value,
    ref:document.getElementById('fb-ref').value.trim(),
    cat:document.getElementById('fb-cat').value,
    comment:document.getElementById('fb-txt').value.trim(),
    at:new Date().toISOString()};
  const all=store.get('pfms_feedback',[]);
  all.unshift(rec);
  store.set('pfms_feedback',all);
  logAudit('Feedback submitted ('+curRating+'★)',rec.name||'Anonymous',clientUser?clientUser.email:'—','Visitor');
  document.getElementById('fb-thanks').style.display='block';
}

/* ══ ADMIN CONSOLE ══
   Every number below is computed from the real stored records
   (pfms_bookings, pfms_memberships, pfms_feedback) — nothing is fabricated.
   In production these queries run against the SQL views in park_fee_system.sql (MySQL) / park_fee_system_postgres.sql (PostgreSQL). */
let curTab='overview', revRange=30, chartRefs={}, adminTimer=null, liveSecondsTimer=null, lastUpdateAt=null;

const TAB_TITLES={overview:'Overview Dashboard',tickets:'Ticket Management',revenue:'Revenue Analytics',members:'Membership Management',settings:'System Settings',audit:'Audit Trail'};

function allowedTabs(){return (currentUser&&currentUser.tabs)||[];}
function applyRoleTabs(){
  const al=allowedTabs();
  document.querySelectorAll('.sb-link[data-tab]').forEach(l=>{l.style.display=al.includes(l.dataset.tab)?'':'none';});
  if(!al.includes(curTab)) curTab=al[0]||'overview';
}
function renderAdmin(){
  document.getElementById('a-date').textContent=new Date().toLocaleDateString('en-KE',{weekday:'short',year:'numeric',month:'long',day:'numeric'});
  applyRoleTabs();
  aTab(null,curTab);
}
function aTab(el,key){
  if(currentUser&&currentUser.tabs&&!currentUser.tabs.includes(key)) return;
  curTab=key;
  document.querySelectorAll('.sb-link').forEach(l=>l.classList.remove('active'));
  const link=el||document.querySelector('.sb-link[data-tab="'+key+'"]');
  if(link) link.classList.add('active');
  document.getElementById('a-ttl').textContent=TAB_TITLES[key]||key;
  document.querySelectorAll('.atab').forEach(t=>t.style.display='none');
  const tab=document.getElementById('tab-'+key);
  if(tab) tab.style.display='block';
  renderTab(key);
}
function renderTab(k){
  if(k==='overview') renderOverview();
  else if(k==='tickets') renderTicketsTab();
  else if(k==='revenue') renderRevenue();
  else if(k==='members') renderMembersTab();
  else if(k==='settings') renderSettings();
  else if(k==='audit') renderAudit();
}

/* Unified payments feed: paid gate entries + membership sales */
function allPayments(){
  const pays=[];
  store.get('pfms_bookings',[]).forEach(b=>{
    if(b.status==='Paid') pays.push({at:b.paidAt||b.bookedAt,amt:b.tot,method:b.payMethod,cat:b.catLabel,kind:'Gate entry'});
  });
  store.get('pfms_memberships',[]).forEach(m=>{
    pays.push({at:m.purchasedAt,amt:m.price,method:m.method,cat:'Membership',kind:'Membership'});
  });
  return pays;
}
function inRange(iso,days){
  if(!days) return true;
  return new Date(iso).getTime()>=Date.now()-days*86400000;
}
function statusBadge(b){
  return b.checkedIn?'<span class="badge badge-g">Checked In</span>'
    :b.status==='Paid'?'<span class="badge badge-b">Paid</span>'
    :'<span class="badge badge-y">Reserved</span>';
}

/* ── OVERVIEW ── */
function renderOverview(){
  const bs=store.get('pfms_bookings',[]);
  const pays=allPayments();
  const today=todayISO();
  const todayRev=pays.filter(p=>p.at&&p.at.slice(0,10)===today).reduce((a,p)=>a+p.amt,0);
  const mtd=pays.filter(p=>p.at&&p.at.slice(0,10)>=today.slice(0,8)+'01').reduce((a,p)=>a+p.amt,0);
  const inWindow=b=>b.date<=today&&addDaysISO(b.date,b.dy-1)>=today;
  const visitors=bs.filter(b=>b.status==='Paid'&&inWindow(b)).reduce((a,b)=>a+b.ad+b.ch,0);
  const active=bs.filter(b=>b.status==='Paid'&&!b.checkedIn&&inWindow(b)).length;
  const fb=store.get('pfms_feedback',[]);
  const avg=fb.length?fb.reduce((a,f)=>a+f.rating,0)/fb.length:0;
  document.getElementById('kpi-visitors').textContent=visitors.toLocaleString();
  document.getElementById('kpi-visitors-sub').textContent='on valid paid tickets today';
  document.getElementById('kpi-revenue').textContent=money(todayRev);
  document.getElementById('kpi-revenue-sub').textContent=money(mtd)+' this month';
  document.getElementById('kpi-tickets').textContent=active;
  document.getElementById('kpi-tickets-sub').textContent='valid, awaiting check-in';
  document.getElementById('kpi-feedback').textContent=fb.length?avg.toFixed(1)+'★':'—';
  document.getElementById('kpi-feedback-sub').textContent=fb.length?'based on '+fb.length+' review(s)':'no reviews yet';
  const tbody=document.getElementById('bookings-tbody');
  const rows=bs.slice(0,8);
  tbody.innerHTML=rows.length?rows.map(b=>
    `<tr><td>${esc(b.ref)}</td><td>${esc(b.name)}</td><td>${esc(b.catLabel)}</td><td>${b.ad} adult(s)${b.ch?', '+b.ch+' child(ren)':''}</td><td>${money(b.tot)}</td><td>${esc(b.payMethod)}</td><td>${statusBadge(b)}</td></tr>`).join('')
    :'<tr><td colspan="7" style="text-align:center;color:var(--tm)">No bookings yet — make one from the Book a Ticket page, or seed demo data in Settings.</td></tr>';
  lastUpdateAt=Date.now();
  refreshUpdatedLabel();
}

/* ── TICKETS ── */
function renderTicketsTab(){
  const qEl=document.getElementById('tk-search');
  const q=(qEl?qEl.value:'').trim().toLowerCase();
  const bs=store.get('pfms_bookings',[]).filter(b=>!q||[b.ref,b.name,b.idNo].some(v=>(v||'').toLowerCase().includes(q)));
  document.getElementById('tickets-count').textContent=bs.length+' ticket(s)'+(q?' matching "'+q+'"':'');
  document.getElementById('tickets-tbody').innerHTML=bs.length?bs.map(b=>
    `<tr><td>${esc(b.ref)}</td><td>${esc(b.name)}</td><td>${esc(b.idNo||'—')}</td><td>${esc(b.date)} · ${b.dy}d</td><td>${b.ad}A${b.ch?'+'+b.ch+'C':''}${b.veh?' 🚗':''}</td><td>${money(b.tot)}</td><td>${esc(b.payMethod)}</td><td>${statusBadge(b)}</td></tr>`).join('')
    :'<tr><td colspan="8" style="text-align:center;color:var(--tm)">No tickets found.</td></tr>';
}

/* ── REVENUE ANALYTICS ── */
function setRange(d,btn){
  revRange=d;
  document.querySelectorAll('.range-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  renderRevenue();
}
function lastNDates(n){
  const out=[];
  for(let i=n-1;i>=0;i--){
    const d=new Date(Date.now()-i*86400000);
    out.push(d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()));
  }
  return out;
}
function drawChart(id,cfg){
  const cv=document.getElementById(id);
  if(!cv) return;
  if(!window.Chart){
    cv.parentElement.innerHTML='<div style="font-size:.78rem;color:var(--tm);padding:10px">Charts need the Chart.js CDN (offline?). The figures are still in the summary table.</div>';
    return;
  }
  if(chartRefs[id]) chartRefs[id].destroy();
  chartRefs[id]=new Chart(cv,cfg);
}
function renderRevenue(){
  const pays=allPayments().filter(p=>p.at&&inRange(p.at,revRange));
  /* trend */
  let span=revRange;
  if(!span){
    const oldest=pays.reduce((m,p)=>Math.min(m,new Date(p.at).getTime()),Date.now());
    span=Math.min(120,Math.max(7,Math.ceil((Date.now()-oldest)/86400000)+1));
  }
  const labels=lastNDates(span);
  const byDay={};
  pays.forEach(p=>{const d=p.at.slice(0,10);byDay[d]=(byDay[d]||0)+p.amt;});
  drawChart('ch-trend',{type:'line',
    data:{labels:labels.map(l=>l.slice(5)),datasets:[{label:'KSh collected',data:labels.map(l=>byDay[l]||0),borderColor:'#1a4a28',backgroundColor:'rgba(26,74,40,.12)',fill:true,tension:.3,pointRadius:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>'KSh '+(v>=1000?(v/1000)+'k':v)}}}}});
  /* by method */
  const byM={};
  pays.forEach(p=>{byM[p.method]=(byM[p.method]||0)+p.amt;});
  drawChart('ch-method',{type:'doughnut',
    data:{labels:Object.keys(byM),datasets:[{data:Object.values(byM),backgroundColor:['#1a4a28','#c9a227','#2d6e42','#8a6d10','#4a4a4a']}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:10}}}}}});
  /* by category */
  const byC={};
  pays.forEach(p=>{byC[p.cat]=(byC[p.cat]||0)+p.amt;});
  drawChart('ch-cat',{type:'bar',
    data:{labels:Object.keys(byC),datasets:[{data:Object.values(byC),backgroundColor:'#c9a227',borderColor:'#8a6d10',borderWidth:1}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>'KSh '+(v>=1000?(v/1000)+'k':v)}}}}});
  /* summary */
  const total=pays.reduce((a,p)=>a+p.amt,0);
  const gate=pays.filter(p=>p.kind==='Gate entry');
  const mem=pays.filter(p=>p.kind==='Membership');
  const topM=Object.entries(byM).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('rev-summary').innerHTML=
    `<tr><th>Metric</th><th>Value</th></tr>
     <tr><td>Period</td><td>${revRange?('Last '+revRange+' days'):'All time'}</td></tr>
     <tr><td>Transactions</td><td>${pays.length}</td></tr>
     <tr><td>Total collected</td><td><strong>${money(total)}</strong></td></tr>
     <tr><td>Gate entries</td><td>${gate.length} · ${money(gate.reduce((a,p)=>a+p.amt,0))}</td></tr>
     <tr><td>Membership sales</td><td>${mem.length} · ${money(mem.reduce((a,p)=>a+p.amt,0))}</td></tr>
     <tr><td>Average transaction</td><td>${pays.length?money(total/pays.length):'—'}</td></tr>
     <tr><td>Top payment method</td><td>${topM?esc(topM[0])+' ('+Math.round(topM[1]/total*100)+'%)':'—'}</td></tr>`;
}

/* ── MEMBERSHIPS ── */
function renderMembersTab(){
  const ms=store.get('pfms_memberships',[]);
  const now=Date.now();
  const act=ms.filter(m=>new Date(m.expiresAt).getTime()>now);
  const exp30=act.filter(m=>new Date(m.expiresAt).getTime()<now+30*86400000);
  document.getElementById('kpi-mem-active').textContent=act.length;
  document.getElementById('kpi-mem-rev').textContent=money(ms.reduce((a,m)=>a+m.price,0));
  document.getElementById('kpi-mem-exp').textContent=exp30.length;
  document.getElementById('members-tbody').innerHTML=ms.length?ms.map(m=>{
    const live=new Date(m.expiresAt).getTime()>now;
    return `<tr><td>${esc(m.no)}</td><td>${esc(m.name)}<br><span style="color:var(--tm);font-size:.72rem">${esc(m.email)}</span></td><td>${esc(m.planName)}</td><td>${fmtDT(m.purchasedAt).split(',')[0]}</td><td>${fmtDT(m.expiresAt).split(',')[0]}</td><td>${money(m.price)} · ${esc(m.method)}</td><td>${live?'<span class="badge badge-g">Active</span>':'<span class="badge badge-r">Expired</span>'}</td></tr>`;
  }).join('')
  :'<tr><td colspan="7" style="text-align:center;color:var(--tm)">No memberships sold yet — passes are bought from the Membership page.</td></tr>';
}

/* ── SETTINGS ── */
function renderSettings(){
  document.getElementById('rules-tbl').innerHTML=
    `<tr><th>Rule</th><th>Value</th></tr>
     <tr><td>Kenyan Citizen (adult / child)</td><td>${money(BASE_RATES.kenyan.adult)} / ${money(BASE_RATES.kenyan.child)} per day</td></tr>
     <tr><td>East African Resident (adult / child)</td><td>${money(BASE_RATES.ea.adult)} / ${money(BASE_RATES.ea.child)} per day</td></tr>
     <tr><td>Non-Resident (adult / child)</td><td>${money(BASE_RATES.nonresident.adult)} / ${money(BASE_RATES.nonresident.child)} per day</td></tr>
     <tr><td>Vehicle fee</td><td>${money(VEHICLE_FEE)} per vehicle per day — never waived</td></tr>
     <tr><td>${esc(SEASONS[0].name)}</td><td>${SEASONS[0].from} to ${SEASONS[0].to} · person fees × ${SEASONS[0].mult}</td></tr>
     <tr><td>Weekend surcharge</td><td>+${Math.round(SURCHARGES.weekend*100)}% on person fees (Sat &amp; Sun)</td></tr>
     <tr><td>Public holiday surcharge</td><td>+${Math.round(SURCHARGES.holiday*100)}% on person fees — higher of the two applies, no stacking</td></tr>`;
  document.getElementById('hol-tbl').innerHTML='<tr><th>Date</th><th>Holiday</th></tr>'+
    Object.entries(HOLIDAYS).map(([d,n])=>`<tr><td>${d}</td><td>${esc(n)}${n.startsWith('Idd')?' <span style="color:var(--tm);font-size:.7rem">(moon-dependent — confirm when gazetted)</span>':''}</td></tr>`).join('');
}

/* ── AUDIT ── */
function renderAudit(){
  const tbody=document.getElementById('audit-tbody');
  if(!tbody) return;
  const audit=store.get('pfms_audit',[]);
  if(!audit.length){
    tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--tm)">No activity recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML=audit.slice(0,40).map(a=>
    `<tr><td>${fmtDT(a.at)}</td><td>${esc(a.name)}</td><td>${esc(a.email)}</td><td>${esc(a.role)}</td><td>${esc(a.action)}</td></tr>`).join('');
}

/* ── DEMO DATA (clearly tagged, one click to remove) ── */
const DEMO_NAMES=['Grace Wanjiku','James Odhiambo','Amara Diallo','Peter Kamau','Fatuma Ali','David Kiptoo','Lucy Achieng','Brian Otieno','Naomi Chebet','Samuel Mwangi','Wanjala Barasa','Esther Nyambura','Sarah Mitchell','Mercy Wambui','Hans Weber','Yuki Tanaka'];
function seedDemoData(){
  const bs=store.get('pfms_bookings',[]);
  const ms=store.get('pfms_memberships',[]);
  const fb=store.get('pfms_feedback',[]);
  const catPool=['kenyan','kenyan','kenyan','ea','nonresident','nonresident','nonresident'];
  const methodPool=['M-Pesa','M-Pesa','M-Pesa','M-Pesa','M-Pesa','Cash at Gate','Cash at Gate','Card','Card','Airtel Money'];
  for(let i=0;i<90;i++){
    const back=Math.floor(Math.random()*30);
    const bookedAt=new Date(Date.now()-back*86400000-Math.floor(Math.random()*10*3600000));
    const visitOffset=Math.floor(Math.random()*3);
    const vd=new Date(bookedAt.getTime()+visitOffset*86400000);
    const visit=vd.getFullYear()+'-'+pad2(vd.getMonth()+1)+'-'+pad2(vd.getDate());
    const cat=catPool[Math.floor(Math.random()*catPool.length)];
    const ad=1+Math.floor(Math.random()*3);
    const ch=Math.random()>.6?1+Math.floor(Math.random()*2):0;
    const dy=Math.random()>.7?2:1;
    const hasVeh=Math.random()>.45;
    const q=quoteBooking({cat,startISO:visit,days:dy,adults:ad,children:ch,vehicle:hasVeh,membership:null});
    const paid=Math.random()>.12;
    const method=paid?methodPool[Math.floor(Math.random()*methodPool.length)]:'Cash at Gate';
    const done=new Date(visit+'T00:00:00').getTime()<Date.now()-86400000;
    bs.push({
      ref:nextRef(),demo:true,userEmail:'demo@pfms.local',
      name:DEMO_NAMES[Math.floor(Math.random()*DEMO_NAMES.length)],email:'',phone:'',idNo:'DEMO-'+(1000+i),
      cat,catLabel:CATS[cat],date:visit,dy,ad,ch,veh:hasVeh?'KD'+String.fromCharCode(65+i%26)+' '+(100+i)+'X':'',
      tot:q.total,payMethod:paid?method:'Cash at Gate',
      receipt:paid?(method==='M-Pesa'?genMpesaReceipt():method==='Airtel Money'?genAirtelReceipt():method==='Card'?'CARD-'+(20000000+i):null):null,
      memberSaved:0,memberPlan:null,
      status:paid?'Paid':'Reserved',paidAt:paid?bookedAt.toISOString():null,
      checkedIn:paid&&done,checkedInAt:paid&&done?new Date(visit+'T08:30:00').toISOString():null,
      bookedAt:bookedAt.toISOString()
    });
  }
  bs.sort((a,b)=>new Date(b.bookedAt)-new Date(a.bookedAt));
  store.set('pfms_bookings',bs);
  const demoPlans=['ANNUAL-IND','ANNUAL-FAM','EA-ANNUAL','TOUR-OP'];
  for(let i=0;i<4;i++){
    const p=MEMBER_PLANS.find(x=>x.id===demoPlans[i]);
    const bought=new Date(Date.now()-Math.floor(Math.random()*25+2)*86400000);
    const exp=new Date(bought); exp.setMonth(exp.getMonth()+p.months);
    ms.push({no:memberNoNext(),demo:true,email:'demo'+i+'@pfms.local',name:DEMO_NAMES[i+4],
      planId:p.id,planName:p.name,price:p.price,method:i%2?'Card':'M-Pesa',receipt:i%2?'CARD-3100000'+i:genMpesaReceipt(),
      purchasedAt:bought.toISOString(),expiresAt:exp.toISOString()});
  }
  store.set('pfms_memberships',ms);
  for(let i=0;i<12;i++){
    fb.push({demo:true,rating:3+Math.floor(Math.random()*3),name:DEMO_NAMES[Math.floor(Math.random()*DEMO_NAMES.length)],visit:'',ref:'',cat:'General',comment:'Demo review',at:new Date(Date.now()-Math.floor(Math.random()*30)*86400000).toISOString()});
  }
  store.set('pfms_feedback',fb);
  logAudit('Demo data seeded — 90 bookings, 4 memberships, 12 reviews',currentUser?currentUser.name:'—',currentUser?currentUser.email:'—',currentUser?currentUser.role:'—');
  renderTab(curTab);
  alert('Seeded 90 demo bookings, 4 memberships and 12 reviews over the last 30 days. All tagged as demo — remove them any time from this tab.');
}
function clearDemoData(){
  store.set('pfms_bookings',store.get('pfms_bookings',[]).filter(b=>!b.demo));
  store.set('pfms_memberships',store.get('pfms_memberships',[]).filter(m=>!m.demo));
  store.set('pfms_feedback',store.get('pfms_feedback',[]).filter(f=>!f.demo));
  logAudit('Demo data cleared',currentUser?currentUser.name:'—',currentUser?currentUser.email:'—',currentUser?currentUser.role:'—');
  renderTab(curTab);
  alert('Demo records removed. Real bookings, memberships and reviews are untouched.');
}

/* ── CSV EXPORT ── */
function exportCSV(kind){
  let head,rows,fn;
  if(kind==='memberships'){
    head=['Member No','Holder','Email','Plan','Price KSh','Method','Receipt','Purchased','Expires'];
    rows=store.get('pfms_memberships',[]).map(m=>[m.no,m.name,m.email,m.planName,m.price,m.method,m.receipt||'',m.purchasedAt,m.expiresAt]);
    fn='pfms_memberships.csv';
  } else {
    head=['Reference','Visitor','ID/Passport','Category','Visit date','Days','Adults','Children','Vehicle','Amount KSh','Pass savings KSh','Method','Receipt','Status','Paid at','Checked in','Booked at'];
    rows=store.get('pfms_bookings',[]).map(b=>[b.ref,b.name,b.idNo||'',b.catLabel,b.date,b.dy,b.ad,b.ch,b.veh||'',b.tot,b.memberSaved||0,b.payMethod,b.receipt||'',b.status,b.paidAt||'',b.checkedIn?'Yes':'No',b.bookedAt]);
    fn='pfms_bookings.csv';
  }
  if(!rows.length){alert('Nothing to export yet.');return;}
  const csv=[head,...rows].map(r=>r.map(v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a=document.createElement('a');
  a.href=url; a.download=fn;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}

/* ── LIVE REFRESH — re-reads real records every 5s while the dashboard is open ── */
function startLiveUpdates(){
  stopLiveUpdates();
  adminTimer=setInterval(()=>{if(curTab==='overview')renderOverview();},5000);
  liveSecondsTimer=setInterval(refreshUpdatedLabel,1000);
}
function stopLiveUpdates(){
  if(adminTimer){clearInterval(adminTimer);adminTimer=null;}
  if(liveSecondsTimer){clearInterval(liveSecondsTimer);liveSecondsTimer=null;}
}
function refreshUpdatedLabel(){
  const el=document.getElementById('live-updated');
  if(!el||!lastUpdateAt) return;
  const secs=Math.floor((Date.now()-lastUpdateAt)/1000);
  el.textContent=secs<2?'Updated just now':'Updated '+secs+'s ago';
}

document.addEventListener('DOMContentLoaded',()=>{
  const di=document.getElementById('b-dt'); if(di) di.min=todayISO();

  // Restore client session ("keep me signed in" for visitors)
  const cs=store.get('pfms_client_session',null);
  if(cs){
    const users=store.get('pfms_users',{});
    if(users[cs.email]){
      const u=users[cs.email];
      clientUser={email:cs.email,name:u.name,phone:u.phone,registeredAt:u.registeredAt,lastLoginAt:u.lastLoginAt};
      updateClientNav();
    } else store.del('pfms_client_session');
  }

  // Restore staff session if "Keep me signed in" was checked
  const ss=store.get('pfms_staff_session',null);
  if(ss && STAFF_USERS[ss.email]){
    const u=STAFF_USERS[ss.email];
    isLoggedIn=true;
    currentUser={...u,email:ss.email};
    document.getElementById('adm-user-name').textContent=u.name;
    document.getElementById('adm-user-role').textContent=u.role;
    document.getElementById('adm-user-av').textContent=u.name.charAt(0).toUpperCase();
    document.getElementById('nav-user-name').textContent=u.name.split(' ')[0];
    document.getElementById('nl-user-chip').style.display='block';
  }
});
